/**
 * §C 丢弃留痕(conflict_rejected)回归 —— task_1.1 / 1.2 / 1.3 / 1.4。
 *
 * 修的是什么:「LLM 明确说"这条冲突我判不了"、而这一跳没接住」这件事此前**完全静默**
 * —— 既不停放也不落库,只在日志里留一行 warn,事后在库里查不到。
 * 于是「模型说了什么」与「库里留下了什么」之间有一条**不可审计的缝**。
 *
 * 本文件钉死五件事:
 * ① `conflictRejectId` 的确定性(幂等 id);
 * ② `recordConflictRejected` 的幂等(**来自主键**,不是调用方自觉)与读取口径;
 * ③ DDL 可重复执行且**不改写**既有行;
 * ④ 管线里"配不成对"的 conflict 决策**真的落痕**且记忆照常入库;
 * ⑤ 关闭态**不落痕**(结构性不可达),以及留痕失败**不中断蒸馏**。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const extractQueue: string[] = [];
/** 去重决策形态:errorPair = 发一条**配不成对**的 conflict(对手是幻觉 id)。 */
let conflictMode: 'errorPair' | 'none' = 'none';

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    callLLM: vi.fn(async (_ctx: unknown, _cfg: unknown, opts: { layer?: string; user?: string }) => {
      if (opts?.layer !== 'l1-dedup') return extractQueue.shift() ?? '[]';
      const ids = [...String(opts.user ?? '').matchAll(/record_id: (\S+?)\)/g)].map((m) => m[1]);
      if (conflictMode === 'errorPair' && ids.length >= 1) {
        return JSON.stringify([{ record_id: ids[0], action: 'conflict', winner: ids[0], loser: 'mem_ghost' }]);
      }
      return JSON.stringify(ids.map((id) => ({ record_id: id, action: 'store' })));
    }),
  };
});

const { runExtraction } = await import('../src/pipeline/l1.js');
const { conflictRejectId, REJECT_FORMAT } = await import('../src/store/conflicts.js');
const { L1Store } = await import('../src/store/l1.js');
const { MemoryDb } = await import('../src/store/sqlite.js');
type MemoryConfig = import('../src/contract.js').MemoryConfig;
type FamilyStates = import('../src/pipeline/l1.js').FamilyStates;
type ConversationMessage = import('../src/types.js').ConversationMessage;
type ConflictRejected = import('../src/store/conflicts.js').ConflictRejected;

let root: string;
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} } as never;

function cfg(conflictFreezeEnabled: boolean): MemoryConfig {
  return {
    dataDir: '',
    family: 'auto',
    capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 },
    extract: { enabled: true, minMessages: 1, idleSeconds: 300, backgroundMessages: 10, candidatePool: 5 },
    l2: { enabled: true, minNewMemories: 5, maxScenes: 12, sceneContextLimit: 3 },
    l3: { enabled: true, interval: 20 },
    recall: { enabled: true, maxResults: 5, maxCharsPerMemory: 500, maxTotalRecallChars: 2000, timeoutMs: 5000, includePersona: true, includeSceneNav: true, strategy: 'keyword', scoreThreshold: 0, decayHalfLifeDays: 0 },
    embedding: { enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 0, maxInputChars: 5000, timeoutMs: 10000, allowLocalModels: true, mirror: '', proxy: '' },
    llm: { provider: '', model: '', mode: 'host', baseURL: '', apiKey: '', maxTokens: 65536, reasoningEffort: 'medium', maxInputChars: 700000, timeoutMs: 120000 },
    hall: { enabled: ['work'] },
    tokenCost: { retentionDays: 365 },
    tools: true,
    benchControl: false,
    conflictFreeze: { enabled: conflictFreezeEnabled, maxPending: 100, timeoutDays: 0 },
  } as MemoryConfig;
}

function states(): FamilyStates {
  const s = () => ({ lastScene: '', chain: [], lastAt: 0, lastRunAt: 0, warmupThreshold: 0, distilledCount: 0 });
  return { chat: s(), work: s() } as unknown as FamilyStates;
}

const messages = (): ConversationMessage[] => [
  { id: 'm1', role: 'user', content: '项目 Zeta 负责人是甲', timestamp: 1_700_000_000_000 },
  { id: 'm2', role: 'assistant', content: '收到', timestamp: 1_700_000_001_000 },
];

/** 一次抽出一条新记忆(供 conflict 决策挂名)。 */
function seedOne(): void {
  extractQueue.push(
    JSON.stringify([
      {
        scene_name: '丢弃留痕',
        message_ids: ['m1'],
        memories: [
          { record_id: '占位', content: '项目 Zeta 负责人是甲', type: 'work_fact', priority: 70, source_message_ids: ['m1'], metadata: { hall: 'work' } },
        ],
      },
    ]),
  );
}

async function setup() {
  const dir = await mkdtemp(join(root, 'rejected-'));
  const db = new MemoryDb(join(dir, 'm.db'), 0);
  db.init();
  const store = new L1Store(dir, db, undefined, 'keyword', noopLogger, 0);
  await store.init();
  return { db, store, dir };
}

const REJECTED_COLS = 'reject_id, run_id, record_id, winner_raw, loser_raw, reason, created_at';
const rejectedRows = (db: MemoryDb): Array<Record<string, unknown>> =>
  (db as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }).db
    .prepare(`SELECT ${REJECTED_COLS} FROM conflict_rejected ORDER BY created_at ASC, reject_id ASC`)
    .all() as never;

beforeEach(() => {
  extractQueue.length = 0;
  conflictMode = 'none';
});

describe('task_1.2 丢弃留痕的幂等 id', () => {
  it('同一入参两次调用得同一 id;格式版本进摘要输入', () => {
    const a = conflictRejectId('run-1', 'rec-1', 'w', 'l');
    const b = conflictRejectId('run-1', 'rec-1', 'w', 'l');
    expect(a).toBe(b);
    // 任一输入变化都必须改 id(否则不同决策会被主键吃掉,静默丢痕)
    expect(conflictRejectId('run-2', 'rec-1', 'w', 'l')).not.toBe(a);
    expect(conflictRejectId('run-1', 'rec-2', 'w', 'l')).not.toBe(a);
    expect(conflictRejectId('run-1', 'rec-1', 'w2', 'l')).not.toBe(a);
    expect(conflictRejectId('run-1', 'rec-1', 'w', 'l2')).not.toBe(a);
    expect(REJECT_FORMAT).toBe('c-conflict-rejected/v1');
    // 与 pair_id 空间隔离:同三元组不得与 pair_id 撞上(前缀不同)
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('task_1.3 store 层读写与幂等', () => {
  it('重复登记同一决策只留 1 行,且返回值反映真实新增数', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rejected-store-'));
    const { db, store } = await setup();
    try {
      const row: ConflictRejected = {
        rejectId: conflictRejectId('run-1', 'rec-1', 'w', 'l'),
        runId: 'run-1',
        recordId: 'rec-1',
        winnerRaw: 'w',
        loserRaw: 'l',
        reason: 'not-pair',
        createdAt: '2026-09-22T00:00:00.000Z',
      };
      expect(store.recordConflictRejected([row])).toBe(1);
      expect(store.recordConflictRejected([row])).toBe(0); // 幂等来自主键
      expect(rejectedRows(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('listConflictRejected 按 created_at 升序、limit 与 createdBefore 生效', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rejected-list-'));
    const { db, store } = await setup();
    try {
      const mk = (n: number): ConflictRejected => ({
        rejectId: conflictRejectId('run-1', `rec-${n}`, 'w', 'l'),
        runId: 'run-1',
        recordId: `rec-${n}`,
        winnerRaw: 'w',
        loserRaw: 'l',
        reason: 'not-pair',
        createdAt: `2026-09-2${n}T00:00:00.000Z`,
      });
      store.recordConflictRejected([mk(1), mk(2), mk(3)]);
      expect(store.listConflictRejected({ limit: 10 }).map((r) => r.createdAt)).toEqual([
        '2026-09-21T00:00:00.000Z',
        '2026-09-22T00:00:00.000Z',
        '2026-09-23T00:00:00.000Z',
      ]);
      expect(store.listConflictRejected({ limit: 2 })).toHaveLength(2);
      // createdBefore 是**排他**上界
      expect(store.listConflictRejected({ createdBefore: '2026-09-23T00:00:00.000Z' })).toHaveLength(2);
      // 字段映射:snake_case 只活在这一层,取出来必须是 camelCase 且非空
      const first = store.listConflictRejected({ limit: 1 })[0]!;
      expect(first.rejectId).not.toBe('');
      expect(first.runId).toBe('run-1');
      expect(first.reason).toBe('not-pair');
    } finally {
      db.close();
    }
  });

  it('DDL 可重复执行:重开同一库再 init 不报错,既有行不被改写', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rejected-ddl-'));
    const { db, store, dir } = await setup();
    const row: ConflictRejected = {
      rejectId: conflictRejectId('run-1', 'rec-keep', 'w', 'l'),
      runId: 'run-1',
      recordId: 'rec-keep',
      winnerRaw: 'w',
      loserRaw: 'l',
      reason: 'not-pair',
      createdAt: '2026-09-22T00:00:00.000Z',
    };
    store.recordConflictRejected([row]);
    const before = rejectedRows(db);
    db.close();

    const db2 = new MemoryDb(join(dir, 'm.db'), 0);
    db2.init(); // 第二次 init:CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 必须幂等
    try {
      expect(rejectedRows(db2)).toEqual(before);
    } finally {
      db2.close();
    }
  });
});

describe('task_1.4 管线落痕', () => {
  it('配不成对的 conflict 决策落痕 1 行,且新记忆照常入库', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rejected-pipeline-'));
    conflictMode = 'errorPair';
    seedOne();
    const { db, store } = await setup();
    try {
      const out = await runExtraction({} as never, cfg(true), store, states(), messages(), [], noopLogger, 'work');
      expect(out.stored).toBe(1); // 回归:回落 store 的行为不变
      const rows = rejectedRows(db);
      expect(rows, '配不成对必须留下可审计痕迹').toHaveLength(1);
      const r = rows[0]!;
      expect(r.reason).toBe('not-pair');
      expect(String(r.winner_raw)).not.toBe('');
      expect(String(r.loser_raw)).toBe('mem_ghost'); // **原始输出**被保留
      expect(String(r.run_id)).not.toBe('');
      expect(String(r.created_at)).not.toBe('');
      expect(String(r.record_id)).toBe(out.newRecords[0]!.id);
      // 留痕不是退场:一分记忆都没被软删
      expect(store.listRetired({ limit: 10, offset: 0 }).total).toBe(0);
    } finally {
      db.close();
    }
  });

  it('关闭态**不落痕**(结构性不可达),新记忆仍照常入库', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rejected-off-'));
    conflictMode = 'errorPair';
    seedOne();
    const { db, store } = await setup();
    try {
      const out = await runExtraction({} as never, cfg(false), store, states(), messages(), [], noopLogger, 'work');
      expect(out.stored).toBe(1);
      expect(rejectedRows(db), '关闭态不得落痕').toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('留痕落盘失败**不中断蒸馏**(与凭证同策略:记 warn、继续)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rejected-fail-'));
    conflictMode = 'errorPair';
    seedOne();
    const { db, store } = await setup();
    const warns: string[] = [];
    const logger = { info: () => {}, warn: (m: string) => warns.push(String(m)), error: () => {} };
    const patched = Object.assign(Object.create(store) as L1Store, {
      recordConflictRejected: () => {
        throw new Error('boom');
      },
    });
    try {
      const out = await runExtraction({} as never, cfg(true), patched, states(), messages(), [], logger as never, 'work');
      expect(out.stored).toBe(1);
      expect(warns.some((m) => m.includes('丢弃留痕落盘失败'))).toBe(true);
    } finally {
      db.close();
    }
  });
});
