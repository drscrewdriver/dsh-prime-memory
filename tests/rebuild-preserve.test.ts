/**
 * 保留式重建单测(task_8c)。
 *
 * **先反证再正向** —— 四条反证各自否定一种"看起来对"的做法:
 *
 * | 反证 | 被否定的做法 | 实测依据 |
 * |---|---|---|
 * | A | 按事实源单独判定,不取交集 | 事实源 1,694 id vs 检索库 740 ⇒ 直接恢复会**复活 25 条已退场记录** |
 * | B | 用"无锚点"当判据 | 检索库 `dsh_source_anchors` 命中 **0/740** ⇒ 会把全部记忆判成保留,重建退化为空操作 |
 * | C | 事实源读不出来时照常放行 | "没有要保留的"与"不知道有什么要保留的"数据上无法区分 ⇒ 静默退化为破坏性重建 |
 * | D | 恢复只写检索库 | `records/` 已归档 ⇒ 记忆再次成为"无事实源副本"的孤儿,下次重建判不出来 |
 *
 * 正向:
 * - 导入记忆在"快照 → 判定 → 清空 → 恢复"全程**逐条仍在**(行数 + 内容断言);
 * - 复现真实数据形状(19 条无来源存活 / 25 条无来源退场 / 740 全无锚点)。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describePlan,
  gateClear,
  isRederivable,
  planPreserve,
  readFactSource,
  restorePreserved,
  type PreservePlan,
} from '../src/pipeline/rebuild-preserve.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { MemoryRecord } from '../src/types.js';

const T = 1_700_000_000_000;
const ANCHOR_KEY = 'dsh_source_anchors';

/** 事实源侧记录(有 `source_message_ids` 列)。 */
function fact(id: string, content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    content,
    type: 'episodic',
    priority: 50,
    scene_name: '围绕某项目的讨论',
    timestamps: [T],
    createdAt: T,
    updatedAt: T,
    version: 0,
    metadata: {},
    sessionId: 'default',
    family: 'chat',
    ...overrides,
  };
}

/** 检索库侧记录(无 `source_message_ids` 列 —— 这正是要跨源判定的原因)。 */
function dbRec(id: string, content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const r = fact(id, content, overrides);
  delete (r as { source_message_ids?: string[] }).source_message_ids;
  return r;
}

/** 由 L0 蒸馏而来:有 source ids ⇒ 重建能再造。 */
const distilled = (id: string, content = `蒸馏记忆 ${id}`): MemoryRecord =>
  fact(id, content, { source_message_ids: ['msg-1', 'msg-2'] });

/** 外部导入 / 手工写入:无 source ids ⇒ 重建造不出来。 */
const imported = (id: string, scene = '__manual__'): MemoryRecord =>
  fact(id, `导入记忆 ${id}`, { scene_name: scene });

async function withDb<T>(name: string, fn: (db: MemoryDb) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-preserve-${name}-`));
  const db = new MemoryDb(join(dir, 'memory.db'), 0);
  db.init();
  try {
    return await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** 从检索库全量读回(与 `l1-snapshot.test.ts` 同口径:内容而非行数)。 */
function contents(db: MemoryDb): string[] {
  return db
    .getAllL1()
    .map((r) => `${r.id}=${r.content}`)
    .sort();
}

/**
 * 直接构造保留计划(绕过 `planPreserve` 的"事实源 ∩ 检索库"交集判定)。
 *
 * `restorePreserved` 的行为要**独立于判定逻辑**被测 —— 用 `planPreserve` 造输入
 * 会让"交集规则"混进恢复用例,失败时分不清是哪一层错了。
 */
function planOf(records: readonly MemoryRecord[]): PreservePlan {
  return {
    preserved: records.map((record) => ({ record: dbRec(record.id, record.content, { scene_name: record.scene_name }), reason: 'no-source' as const })),
    rederivable: 0,
    retiredNoSource: 0,
    factCount: records.length,
    dbCount: records.length,
  };
}

describe('反证 A:只按事实源判定会复活已退场记录', () => {
  it('事实源里无来源但检索库已无此行的记录,不进保留集', () => {
    // 事实源 3 条:1 条退场的导入记忆 + 1 条存活的导入记忆 + 1 条蒸馏记忆
    const facts = [imported('gone_1'), imported('keep_1'), distilled('dis_1')];
    // 检索库里 gone_1 已被合并掉,只剩两条
    const live = [dbRec('keep_1', '导入记忆 keep_1', { scene_name: '__manual__' }), dbRec('dis_1', '蒸馏记忆 dis_1')];

    const plan = planPreserve(facts, live);

    expect(plan.retiredNoSource).toBe(1);
    expect(plan.preserved.map((p) => p.record.id)).toEqual(['keep_1']);
    // 若按事实源无脑恢复,这里会是 ['gone_1','keep_1'] —— 已删记录被复活
    expect(plan.preserved.map((p) => p.record.id)).not.toContain('gone_1');
  });

  it('三个计数自洽:保留 + 可重蒸馏 + 退场无来源 == 存活集合的完整划分', () => {
    const facts = [imported('i1'), imported('i2'), imported('gone'), distilled('d1'), distilled('d2'), distilled('dgone')];
    const live = [
      dbRec('i1', '导入记忆 i1', { scene_name: '__manual__' }),
      dbRec('i2', '导入记忆 i2', { scene_name: '外部导入/其他工具' }),
      dbRec('d1', '蒸馏记忆 d1'),
      dbRec('d2', '蒸馏记忆 d2'),
    ];
    const plan = planPreserve(facts, live);

    expect(plan.preserved).toHaveLength(2);
    expect(plan.rederivable).toBe(2);
    expect(plan.retiredNoSource).toBe(1);
    expect(plan.factCount).toBe(6);
    expect(plan.dbCount).toBe(4);
    // 划分:保留 + 可重蒸馏 == 检索库总数(退场的两条不在检索库里)
    expect(plan.preserved.length + plan.rederivable).toBe(plan.dbCount);
  });
});

describe('反证 B:用"无锚点"当判据会把全部记忆判成保留', () => {
  it('一条有 source ids 但**没有锚点**的记忆,不可保留 —— 它是能从 L0 重造的', () => {
    // 实测:检索库 740 条里 dsh_source_anchors 命中 0 条,即"无锚点"恒真。
    const r = distilled('dis_1');
    expect(r.metadata?.[ANCHOR_KEY]).toBeUndefined();
    expect(isRederivable(r)).toBe(true);

    const plan = planPreserve([r], [dbRec('dis_1', r.content)]);
    expect(plan.preserved).toEqual([]);
    expect(plan.rederivable).toBe(1);

    // 对照:换成"无锚点即保留"的判据,740/740 都会进保留集 → 重建变成空操作
    const naiveKeepAll = [r, imported('i1'), distilled('d2')].filter(
      (x) => x.metadata?.[ANCHOR_KEY] === undefined,
    );
    expect(naiveKeepAll).toHaveLength(3);
  });

  it('锚点存在与否不影响判定 —— 判据只有 source ids', () => {
    const anchored = distilled('dis_2');
    anchored.metadata = { [ANCHOR_KEY]: [{ sessionId: 's', turn: 3, step: 1 }] };
    expect(planPreserve([anchored], [dbRec('dis_2', anchored.content)]).preserved).toEqual([]);
  });
});

describe('反证 C:事实源读不出来时不能放行', () => {
  const someLive = [dbRec('i1', '导入记忆 i1'), dbRec('d1', '蒸馏记忆 d1')];

  it('目录不存在 + 检索库非空 → 拒绝清空', () => {
    const read = { ok: false, records: [], files: 0, reason: 'dir-missing' as const };
    const plan = planPreserve([], someLive);
    const gate = gateClear(read, plan);

    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('source-missing');
    expect(gate.note).toContain('未清空');
  });

  it('可读但零记录 + 检索库非空 → 拒绝(与"目录存在且真没内容"不是一回事)', () => {
    const read = { ok: true, records: [], files: 0 };
    const gate = gateClear(read, planPreserve([], someLive));
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('source-empty');
  });

  it('检索库为空时照常放行 —— 不把功能卡死在干净环境上', () => {
    const read = { ok: false, records: [], files: 0, reason: 'dir-missing' as const };
    const gate = gateClear(read, planPreserve([], []));
    expect(gate.allowed).toBe(true);
    expect(gate.code).toBe('empty-db');
  });

  it('正常态放行,并在说明里给出保留条数', () => {
    const facts = [imported('i1'), distilled('d1')];
    const plan = planPreserve(facts, someLive);
    const gate = gateClear({ ok: true, records: facts, files: 1 }, plan);
    expect(gate.allowed).toBe(true);
    expect(gate.code).toBe('ok');
    expect(gate.note).toContain('保留 1 条');
  });
});

describe('反证 D:恢复必须双写,不能只写检索库', () => {
  it('恢复走 appendNew(JSONL 事实源 + 检索库),不直连 db.upsertL1', async () => {
    const calls: string[] = [];
    const store = {
      appendNew: async (records: MemoryRecord[]) => {
        calls.push(`appendNew:${records.length}`);
      },
      getByIds: (ids: string[]) => ids.map((id) => dbRec(id, `导入记忆 ${id}`)),
    };
    const plan = planOf([imported('i1'), imported('i2')]);

    const res = await restorePreserved(store, plan);

    expect(calls).toEqual(['appendNew:2']);
    expect(res).toEqual({ attempted: 2, restored: 2, missing: [] });
  });

  it('恢复后逐条核实:没回来的 id 会被列出来,而不是"没抛就算成功"', async () => {
    const store = {
      appendNew: async () => undefined,
      // 只回了 1 条
      getByIds: () => [dbRec('i1', '导入记忆 i1')],
    };
    const plan = planOf([imported('i1'), imported('i2')]);
    const res = await restorePreserved(store, plan);

    expect(res.attempted).toBe(2);
    expect(res.restored).toBe(1);
    expect(res.missing).toEqual(['i2']);
  });

  it('空保留集不做任何写入', async () => {
    let called = false;
    const store = {
      appendNew: async () => {
        called = true;
      },
      getByIds: () => [],
    };
    const res = await restorePreserved(store, planOf([]));
    expect(called).toBe(false);
    expect(res).toEqual({ attempted: 0, restored: 0, missing: [] });
  });
});

describe('正向:导入记忆在带保护的流程下全程未被动过', () => {
  it('快照 → 判定 → 清空 → 恢复后,导入记忆逐条仍在(行数 + 内容)', async () => {
    await withDb('roundtrip', async (db) => {
      // 检索库:2 条导入 + 3 条蒸馏(真实分布里导入是少数)
      for (const r of [dbRec('i1', '导入记忆 i1', { scene_name: '__manual__' }), dbRec('i2', '导入记忆 i2', { scene_name: '外部导入/memport' })]) {
        expect(db.upsertL1(r)).toBe(true);
      }
      for (let i = 0; i < 3; i++) expect(db.upsertL1(dbRec(`d${i}`, `蒸馏记忆 d${i}`))).toBe(true);
      const totalBefore = db.countL1();
      expect(totalBefore).toBe(5);

      // 事实源:与检索库同 id,但不带 source ids 的两条正是导入记忆
      const facts = [
        imported('i1'),
        imported('i2', '外部导入/memport'),
        distilled('d0'),
        distilled('d1'),
        distilled('d2'),
      ];
      const emptyDir = await mkdtemp(join(tmpdir(), 'dsh-preserve-empty-'));
      try {
        const read = await readFactSource(emptyDir);
        expect(read.ok).toBe(true);
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }

      const plan = planPreserve(facts, db.getAllL1());
      expect(gateClear({ ok: true, records: facts, files: 1 }, plan).allowed).toBe(true);
      expect(plan.preserved.map((p) => p.record.id)).toEqual(['i1', 'i2']);

      // 破坏性一步:清空检索库(模拟重建 prepare 的清库)
      const preservedContents = plan.preserved.map((p) => `${p.record.id}=${p.record.content}`).sort();
      expect(db.clearL1()).toBe(true);
      expect(db.countL1()).toBe(0);

      // 恢复
      const store = {
        appendNew: async (records: MemoryRecord[]) => {
          expect(db.upsertL1Batch(records)).toBe(true);
        },
        getByIds: (ids: string[]) => db.getL1ByIds(ids),
      };
      const res = await restorePreserved(store, plan);

      expect(res.missing).toEqual([]);
      expect(db.countL1()).toBe(2);
      // 逐条内容断言,不只断行数
      expect(contents(db).filter((c) => c.startsWith('i'))).toEqual(preservedContents);
    });
  });

  it('端到端:readFactSource 读到的真实形状能走通全链路', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-preserve-fs-'));
    const recordsDir = join(dir, 'records');
    await mkdir(recordsDir, { recursive: true });
    // 同名 id 后写胜:JSONL 是追加日志
    await writeFile(
      join(recordsDir, '2026-09-17.jsonl'),
      [
        JSON.stringify({ ...imported('i1'), content: '旧形态' }),
        JSON.stringify({ ...imported('i1'), content: '新形态' }),
        JSON.stringify({ ...distilled('d1') }),
        '',
      ].join('\n'),
      'utf-8',
    );
    try {
      const read = await readFactSource(recordsDir);
      expect(read.ok).toBe(true);
      expect(read.records).toHaveLength(2);

      const plan = planPreserve(read.records, [dbRec('i1', '新形态', { scene_name: '__manual__' })]);
      expect(plan.preserved).toHaveLength(1);
      expect(plan.preserved[0].record.content).toBe('新形态');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('事实源读取的真实失败形态', () => {
  it('目录不存在 → dir-missing,不抛', async () => {
    const read = await readFactSource(join(tmpdir(), 'dsh-preserve-does-not-exist-xyz'));
    expect(read.ok).toBe(false);
    expect(read.reason).toBe('dir-missing');
    expect(read.records).toEqual([]);
  });

  it('目录里的坏行被跳过,但好行照常读到', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-preserve-bad-'));
    await writeFile(join(dir, 'x.jsonl'), '{不是 JSON}\n' + JSON.stringify(imported('i1')) + '\n', 'utf-8');
    try {
      const read = await readFactSource(dir);
      expect(read.ok).toBe(true);
      expect(read.records.map((r) => r.id)).toEqual(['i1']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('非 .jsonl 文件(hidden/临时)不参与判定', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-preserve-ext-'));
    await writeFile(join(dir, 'notes.txt'), JSON.stringify(imported('i9')), 'utf-8');
    try {
      const read = await readFactSource(dir);
      expect(read.ok).toBe(true);
      expect(read.files).toBe(0);
      expect(read.records).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('无出处记录一律保留(兜底:事实源部分损坏时的保守方向)', () => {
  it('检索库里有、事实源里完全没有 → unprovenanced,保留', () => {
    const plan = planPreserve([distilled('d1')], [dbRec('d1', '蒸馏记忆 d1'), dbRec('mystery', '来源不明的记忆')]);
    expect(plan.preserved.map((p) => [p.record.id, p.reason])).toEqual([['mystery', 'unprovenanced']]);
  });

  it('内容为空的记录标 empty-content(它同样造不出来)', () => {
    const plan = planPreserve([imported('i1')], [dbRec('i1', '   ', { scene_name: '__manual__' })]);
    expect(plan.preserved.map((p) => p.reason)).toEqual(['empty-content']);
  });
});

describe('摘要文本 —— 必须说清"没恢复什么"', () => {
  it('把退场条数也写进去,不能只报"保留了几条"', () => {
    const plan: PreservePlan = planPreserve(
      [imported('i1'), imported('gone'), distilled('d1')],
      [dbRec('i1', '导入记忆 i1'), dbRec('d1', '蒸馏记忆 d1')],
    );
    const s = describePlan(plan);
    expect(s).toContain('保留 1 条');
    expect(s).toContain('已退场 1 条');
  });
});
