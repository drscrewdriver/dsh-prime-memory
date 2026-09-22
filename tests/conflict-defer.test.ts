/**
 * §C R1 未决态(`defer`)回归 —— task_2.2 / 2.3 / 2.4 / 2.6。
 *
 * 修的是什么:在此之前人工只有三选一(winner / loser / both)。**"我看了,但判不了"没有出口**,
 * 于是要么硬判(污染结论),要么什么都不做(与"没看过"在库里无从区分,且超时安全阀会
 * 按 `created_at` 把它静默 `auto` 了结——人再看时它已经关了)。
 *
 * 本文件钉死六件事:
 * ① `defer` 只写 `reviewed_at`/`deferred_at`/`defer_count`,**不写** `resolved_at`;
 * ② 该对**仍在待裁决队列**里,且 `defer_count` 递增;
 * ③ 返回体**必须带 notice**,渲染不得把它说成"两者都保留";
 * ④ 关闭态返回"未开启"notice,且**一个列都不写**;
 * ⑤ 超时基准 = `deferred_at ?? created_at`(defer **重置**计时),且复看达上限的对
 *    被排除出超时扫描——但人工裁决**仍够得着**(那是它们唯一的出口);
 * ⑥ 读取面能区分 `unseen` 与 `deferred`。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { buildConflictPair, DEFER_MAX } from '../src/store/conflicts.js';
import { listConflictPairs, renderConflictResolution, resolveConflictPair } from '../src/conflict-service.js';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { MemoryRecord } from '../src/types.js';

let root: string;
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} } as never;

function rec(id: string, content: string): MemoryRecord {
  const t = 1_700_000_000_000;
  return {
    id,
    content,
    type: 'episodic',
    priority: 50,
    scene_name: '日常',
    timestamps: [t],
    createdAt: t,
    updatedAt: t,
    version: 0,
    metadata: {},
    sessionId: 'default',
    family: 'chat',
  };
}

type RawDb = {
  prepare: (s: string) => {
    all: (...a: unknown[]) => unknown[];
    get: (...a: unknown[]) => unknown;
    run: (...a: unknown[]) => { changes: number };
  };
};
const rawOf = (db: MemoryDb): RawDb => (db as unknown as { db: RawDb }).db;

/** 一行的可比较快照(用于断言"关闭态一个列都没写")。 */
const rowSnapshot = (db: MemoryDb, pairId: string): Record<string, unknown> =>
  (rawOf(db).prepare('SELECT * FROM conflict_pending WHERE pair_id = ?').get(pairId) ?? {}) as Record<
    string,
    unknown
  >;

async function setup(tag: string) {
  const dir = await mkdtemp(join(root, tag));
  const db = new MemoryDb(join(dir, 'm.db'), 0);
  db.init();
  const store = new L1Store(dir, db, undefined, 'keyword', noopLogger, 0);
  await store.init();
  return { db, store };
}

/** 一条 30 天以上的旧对(createdAt 早于任何合理 cutoff)。 */
const OLD = '2026-08-01T00:00:00.000Z';
const cutoff30d = (): string => new Date(Date.now() - 30 * 86_400_000).toISOString();

describe('task_2.2 defer 写入口', () => {
  it('defer 只写三列、不写 resolved_at,对仍在队列里且 defer_count 递增', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-defer-write-'));
    const { db, store } = await setup('defer-');
    try {
      const pair = buildConflictPair({ runId: 'run-1', winnerId: 'w-1', loserId: 'l-1', createdAt: OLD });
      db.recordConflictPending([pair]);
      const deps = { l1: store, conflictFreezeEnabled: true };

      const first = await resolveConflictPair(deps, pair.pairId, 'defer');
      expect(first.notice, 'defer 返回体必须带 notice').toBeTruthy();
      expect(first.resolved_at, 'defer 不写 resolved_at').toBe('');
      expect(first.removed_record_id, 'defer 不退场任何一方').toBe('');

      const row = rowSnapshot(db, pair.pairId);
      expect(row.resolved_at, 'resolved_at 必须仍为空串').toBe('');
      expect(row.resolution, 'resolution 必须仍为空串').toBe('');
      expect(String(row.reviewed_at)).not.toBe('');
      expect(String(row.deferred_at)).not.toBe('');
      expect(Number(row.defer_count)).toBe(1);

      // ② 还在队列里(这是 R1 的核心:defer 不关闭冲突)
      expect(store.listConflictPending().map((p) => p.pairId)).toContain(pair.pairId);

      const second = await resolveConflictPair(deps, pair.pairId, 'defer');
      expect(second.notice).toBeTruthy();
      expect(Number(rowSnapshot(db, pair.pairId).defer_count)).toBe(2);
    } finally {
      db.close();
    }
  });

  it('渲染不得把 defer 说成"两者都保留"(即便 view 没带 notice)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-defer-render-'));
    const { db, store } = await setup('render-');
    try {
      const pair = buildConflictPair({ runId: 'run-2', winnerId: 'w-2', loserId: 'l-2', createdAt: OLD });
      db.recordConflictPending([pair]);
      const out = await resolveConflictPair({ l1: store, conflictFreezeEnabled: true }, pair.pairId, 'defer');
      expect(renderConflictResolution(out)).not.toContain('两者都保留');

      // 纵深防御:手工构造一个**不带 notice** 的 defer view
      const bare = renderConflictResolution({
        pair_id: pair.pairId,
        outcome: 'defer',
        resolved_at: '',
        removed_record_id: '',
      });
      expect(bare, '不得落进 else 分支').not.toContain('两者都保留');
      expect(bare).toContain('未关闭');
    } finally {
      db.close();
    }
  });

  it('关闭态(task_2.6):notice 指向未开启,且**一个列都不写**', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-defer-off-'));
    const { db, store } = await setup('off-');
    try {
      const pair = buildConflictPair({ runId: 'run-3', winnerId: 'w-3', loserId: 'l-3', createdAt: OLD });
      db.recordConflictPending([pair]);
      const before = rowSnapshot(db, pair.pairId);

      const out = await resolveConflictPair({ l1: store, conflictFreezeEnabled: false }, pair.pairId, 'defer');
      expect(out.notice).toContain('矛盾冻结未开启');
      expect(rowSnapshot(db, pair.pairId), '关闭态零写入').toEqual(before);
    } finally {
      db.close();
    }
  });

  it('markConflictReviewed 对**已裁决**的对返回 0 行且不改写(审计 N1)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-defer-after-resolve-'));
    const { db, store } = await setup('after-');
    try {
      db.upsertL1(rec('w-x', '胜方'));
      db.upsertL1(rec('l-x', '败方'));
      const pair = buildConflictPair({ runId: 'run-x', winnerId: 'w-x', loserId: 'l-x', createdAt: OLD });
      db.recordConflictPending([pair]);
      await resolveConflictPair({ l1: store, conflictFreezeEnabled: true }, pair.pairId, 'winner');

      // 已裁决 ⇒ 写"已复看"必须被拒(`WHERE resolved_at = ''`),不得把结论旁边再添一笔
      const changes = store.markConflictReviewed(pair.pairId, {
        reviewedAt: new Date().toISOString(),
        deferredAt: new Date().toISOString(),
        deferCount: 9,
      });
      expect(changes).toBe(0);
      expect(Number(rowSnapshot(db, pair.pairId).defer_count), '未被写回').toBe(0);
    } finally {
      db.close();
    }
  });

  it('既有 winner / loser / both 三条路径与返回形状不变(回归)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-defer-legacy-'));
    const { db, store } = await setup('legacy-');
    try {
      db.upsertL1(rec('w-4', '胜方'));
      db.upsertL1(rec('l-4', '败方'));
      const pair = buildConflictPair({ runId: 'run-4', winnerId: 'w-4', loserId: 'l-4', createdAt: OLD });
      db.recordConflictPending([pair]);
      const out = await resolveConflictPair({ l1: store, conflictFreezeEnabled: true }, pair.pairId, 'winner');
      expect(out.resolved_at).not.toBe('');
      expect(out.removed_record_id).toBe('l-4');
      expect(out.notice).toBeUndefined();
      expect(renderConflictResolution(out)).toContain('判定 LLM 建议的胜方为真');
    } finally {
      db.close();
    }
  });
});

describe('task_2.3 超时基准与复看上限', () => {
  it('超时基准 = deferred_at ?? created_at:defer 重置计时(陈旧 created_at 不再扫到它)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-defer-timeout-'));
    const { db, store } = await setup('timeout-');
    try {
      const stalePair = buildConflictPair({ runId: 'run-5', winnerId: 'w-5', loserId: 'l-5', createdAt: OLD });
      const deferredPair = buildConflictPair({ runId: 'run-6', winnerId: 'w-6', loserId: 'l-6', createdAt: OLD });
      db.recordConflictPending([stalePair, deferredPair]);

      const cutoff = cutoff30d();
      const beforeIds = store.listConflictPending({ createdBefore: cutoff }).map((p) => p.pairId);
      expect(beforeIds, '未 defer 的旧对会被扫到').toContain(stalePair.pairId);
      expect(beforeIds, '未 defer 的旧对会被扫到').toContain(deferredPair.pairId);

      await resolveConflictPair({ l1: store, conflictFreezeEnabled: true }, deferredPair.pairId, 'defer');

      const afterIds = store.listConflictPending({ createdBefore: cutoff }).map((p) => p.pairId);
      expect(afterIds, 'defer 过的对不再因 created_at 陈旧被 auto').not.toContain(deferredPair.pairId);
      expect(afterIds, '未 defer 的对仍照常被扫到(有界性未被破坏)').toContain(stalePair.pairId);
    } finally {
      db.close();
    }
  });

  it(`复看达上限(${DEFER_MAX})的对被排除出超时扫描,但默认列出与人工裁决仍够得着`, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-defer-cap-'));
    const { db, store } = await setup('cap-');
    try {
      db.upsertL1(rec('w-7', '胜方'));
      db.upsertL1(rec('l-7', '败方'));
      const pair = buildConflictPair({ runId: 'run-7', winnerId: 'w-7', loserId: 'l-7', createdAt: OLD });
      db.recordConflictPending([pair]);
      const deps = { l1: store, conflictFreezeEnabled: true };

      for (let i = 0; i < DEFER_MAX; i++) await resolveConflictPair(deps, pair.pairId, 'defer');
      expect(Number(rowSnapshot(db, pair.pairId).defer_count)).toBe(DEFER_MAX);

      // 把 `deferred_at` 抹回空串,使该行**仅**因时间陈旧而落在扫描范围内 ——
      // 否则 defer 已重置计时,行根本不会因时间进入扫描,「复看上限」这个机制就无从体现
      // (初版用例正是在这里把两个机制混为一谈,被实测打回)。
      rawOf(db).prepare("UPDATE conflict_pending SET deferred_at = '' WHERE pair_id = ?").run(pair.pairId);

      const cutoff = cutoff30d();
      expect(
        store.listConflictPending({ createdBefore: cutoff }).map((p) => p.pairId),
        '不带开关 ⇒ 只按时间过滤,钉子户仍在扫描集内',
      ).toContain(pair.pairId);
      expect(
        store.listConflictPending({ createdBefore: cutoff, excludeDeferExhausted: true }).map((p) => p.pairId),
        '带开关 ⇒ 复看达上限的行被排除出超时扫描',
      ).not.toContain(pair.pairId);
      expect(
        store.listConflictPending({ limit: 100 }).map((p) => p.pairId),
        '默认列出**不受**排除开关影响(否则快照哈希会随 defer_count 漂移)',
      ).toContain(pair.pairId);

      // 人工裁决是钉子户唯一的出口 ⇒ 必须仍然够得着
      const out = await resolveConflictPair(deps, pair.pairId, 'winner');
      expect(out.resolved_at, '钉子户必须能被人收口').not.toBe('');
      expect(out.removed_record_id).toBe('l-7');
    } finally {
      db.close();
    }
  });

  it('defer 不改变 maxPending 的计数口径(未裁决仍按 resolved_at = 计)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-defer-count-'));
    const { db, store } = await setup('count-');
    try {
      const pair = buildConflictPair({ runId: 'run-8', winnerId: 'w-8', loserId: 'l-8', createdAt: OLD });
      db.recordConflictPending([pair]);
      expect(store.countConflictPendingUnresolved()).toBe(1);
      await resolveConflictPair({ l1: store, conflictFreezeEnabled: true }, pair.pairId, 'defer');
      expect(store.countConflictPendingUnresolved(), 'defer 后仍计为未裁决').toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('task_2.1 迁移:对已存在的旧表执行 ALTER', () => {
  it('手工造一张升级前的 7 列表 + 一行 ⇒ init 后加列且**既有行逐列不变**', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-defer-migrate-'));
    const dir = join(root, 'migrate');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'm.db');

    // 1) 造"升级前"的库:只有 7 列 + 一行真实数据
    const pre = new DatabaseSync(file, { allowExtension: false });
    pre.exec(`
      CREATE TABLE conflict_pending (
        pair_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL DEFAULT '',
        winner_id TEXT NOT NULL DEFAULT '',
        loser_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        resolved_at TEXT NOT NULL DEFAULT '',
        resolution TEXT NOT NULL DEFAULT ''
      )
    `);
    pre
      .prepare(
        `INSERT INTO conflict_pending (pair_id, run_id, winner_id, loser_id, created_at, resolved_at, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('pair-old', 'run-old', 'w-old', 'l-old', OLD, '', '');
    pre.close();

    // 2) 正常打开 ⇒ init 触发 ALTER 迁移(PRAGMA table_info 判存在)
    const db = new MemoryDb(file, 0);
    db.init();
    try {
      const cols = (rawOf(db).prepare('PRAGMA table_info(conflict_pending)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols, '三列被补上').toEqual(
        expect.arrayContaining(['reviewed_at', 'deferred_at', 'defer_count']),
      );

      const row = rowSnapshot(db, 'pair-old');
      // 既有行的 7 个旧列**逐列不变**(迁移不得改写任何既有值)
      expect(row.run_id).toBe('run-old');
      expect(row.winner_id).toBe('w-old');
      expect(row.loser_id).toBe('l-old');
      expect(row.created_at).toBe(OLD);
      expect(row.resolved_at).toBe('');
      expect(row.resolution).toBe('');
      // 新列取默认值
      expect(row.reviewed_at).toBe('');
      expect(row.deferred_at).toBe('');
      expect(Number(row.defer_count)).toBe(0);
    } finally {
      db.close();
    }

    // 3) 迁移后再开一次:ALTER 必须幂等(不报错、行数不变)
    const again = new MemoryDb(file, 0);
    again.init();
    try {
      expect(
        Number((rawOf(again).prepare('SELECT COUNT(*) AS n FROM conflict_pending').get() as { n: number }).n),
      ).toBe(1);
    } finally {
      again.close();
    }
  });
});

describe('task_2.4 读取面区分 未看 / 已看未决', () => {
  it('unseen → deferred,并带 defer_count', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-defer-view-'));
    const { db, store } = await setup('view-');
    try {
      const pair = buildConflictPair({ runId: 'run-9', winnerId: 'w-9', loserId: 'l-9', createdAt: OLD });
      db.recordConflictPending([pair]);
      const deps = { l1: store, conflictFreezeEnabled: true };

      const before = listConflictPairs(deps);
      expect(before.items[0]?.review_state).toBe('unseen');
      expect(before.items[0]?.defer_count).toBe(0);

      await resolveConflictPair(deps, pair.pairId, 'defer');

      const after = listConflictPairs(deps);
      expect(after.items[0]?.review_state).toBe('deferred');
      expect(after.items[0]?.defer_count).toBe(1);
      // 队列恒等:defer 不改变总数(它没关闭任何东西)
      expect(after.total).toBe(before.total);
    } finally {
      db.close();
    }
  });
});
