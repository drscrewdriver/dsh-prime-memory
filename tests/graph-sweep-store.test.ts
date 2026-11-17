/**
 * 两把刀的**存储层**测试(v0.26.58):B 刀 GraphStore.sweepStock、A 刀 resetGraphOnly,
 * 外加归档必须连带退出向量表(否则向量检索把归档节点捞回来)。
 *
 * 与 graph-sweep-pure.test.ts 的分工:那文件锁判据,本文件锁**落库语义**——
 * dryRun 真的一个字没写、落库真的写回、重建后 queueMissing 真的全量命中。
 *
 * 夹具形态是这里最要紧的一件事:脏行**不能**经 complete() 产生。v2 的入口闸门是
 * filter-on-input,裸角色 / 路径名 place 的新提案会被当场拒收(本文件第 1 个用例
 * 就把这条锁住),于是「闸门上线前落库的存量」只能直插复现——这也正是 B 刀存在的
 * 理由:闸门管不到已有行。用直插造脏行,才是被测对象的真实输入分布。
 */
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { GraphProjectionResult } from '../src/graph/types.js';
import { GraphStore } from '../src/store/graph-store.js';
import type { MemoryLogger } from '../src/types.js';

const require = createRequire(import.meta.url);
const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** 探针与生产加载路径逐字对齐(建库开 allowExtension + 前后开关 enableLoadExtension),
 * 否则会静默跳过整组用例——教训见 graph-node-vec.test.ts 头注。 */
function probeVec0(): boolean {
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  try {
    const mod = require('sqlite-vec') as { load(d: unknown): void };
    db.enableLoadExtension(true);
    mod.load(db);
    db.exec('CREATE VIRTUAL TABLE probe USING vec0(v float[4] distance_metric=cosine)');
    return true;
  } catch {
    return false;
  } finally {
    try {
      db.enableLoadExtension(false);
    } catch {
      /* ignore */
    }
    db.close();
  }
}
const VEC0_OK = probeVec0();

function makeRawDb(): DatabaseSync {
  const raw = new DatabaseSync(':memory:', { allowExtension: true });
  if (VEC0_OK) {
    try {
      const mod = require('sqlite-vec') as { load(d: unknown): void };
      raw.enableLoadExtension(true);
      mod.load(raw);
      raw.enableLoadExtension(false);
    } catch {
      /* 探针已过却加载失败:退回裸连接,由 nodeVecReady 断言兜住 */
    }
  }
  raw.exec(`
    CREATE TABLE l1_records (
      record_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT DEFAULT '',
      priority INTEGER DEFAULT 50,
      scene_name TEXT DEFAULT '',
      session_id TEXT DEFAULT 'default',
      version INTEGER NOT NULL DEFAULT 0,
      timestamp_str TEXT DEFAULT '',
      timestamp_start TEXT DEFAULT '',
      timestamp_end TEXT DEFAULT '',
      created_time TEXT DEFAULT '',
      updated_time TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}',
      family TEXT NOT NULL DEFAULT 'chat'
    );
  `);
  return raw;
}

function insertRawRecord(raw: DatabaseSync, id: string): void {
  raw
    .prepare(
      `INSERT INTO l1_records (record_id, content, type, created_time, updated_time, timestamp_str, metadata_json)
       VALUES (?, ?, 'episodic', '2026-09-06T07:00:00.000Z', '2026-09-06T07:00:00.000Z', '', '{}')`,
    )
    .run(id, `记忆 ${id}`);
}

/** 直插一行节点(绕过 apply 硬校验)= 「闸门上线前的存量」形态。 */
function rawInsertNode(
  raw: DatabaseSync,
  id: string,
  name: string,
  type: string,
  extra: { aliases?: string[]; facts?: unknown[]; status?: string } = {},
): void {
  raw
    .prepare(
      `INSERT INTO graph_nodes (node_id, name, type, aliases_json, tags_json, current_state, facts_json,
         status, confidence, source_record_ids_json, families_json, created_time, updated_time)
       VALUES (?, ?, ?, ?, '[]', '', ?, ?, 0.8, '["r1"]', '["work"]', ?, ?)`,
    )
    .run(
      id,
      name,
      type,
      JSON.stringify(extra.aliases ?? []),
      JSON.stringify(extra.facts ?? []),
      extra.status ?? 'active',
      '2026-11-16T00:00:00.000Z',
      '2026-11-16T00:00:00.000Z',
    );
}

const DIRTY_ASSISTANT = '助手';
const DIRTY_PLACE = 'E:/test/rewrite-agently/mine-dsh-plugins';

/** 干净提案:走完整 complete 链路,顺带登记 r1 的投影凭证(countsForRebuild.projected)。 */
function cleanResult(): GraphProjectionResult {
  return {
    reason: '干净夹具',
    nodes: [
      {
        ref: 'c',
        name: 'DSH',
        type: 'project',
        aliases: ['E:/x/y', 'deepseek harness'],
        facts: [{ key: '当前状态', value: '进行中', sourceRecordIds: ['r1'] }],
        sourceRecordIds: ['r1'],
      },
    ],
    edges: [],
  };
}

function dirtyOnlyResult(): GraphProjectionResult {
  return {
    reason: '脏提案',
    nodes: [
      { ref: 'a', name: DIRTY_ASSISTANT, type: 'person', sourceRecordIds: ['r1'] },
      { ref: 'b', name: DIRTY_PLACE, type: 'place', sourceRecordIds: ['r1'] },
    ],
    edges: [],
  };
}

function seededWithDirty(): { gs: GraphStore; raw: DatabaseSync } {
  const raw = makeRawDb();
  insertRawRecord(raw, 'r1');
  const gs = new GraphStore();
  gs.init(raw, noopLogger, VEC0_OK ? { dimensions: 4 } : undefined);
  gs.queueGraphProjection(['r1'], 10000);
  const claim = gs.claimNext();
  if (!claim) throw new Error('夹具:claimNext 应能取到刚入队的 job');
  const done = gs.complete(claim.job.id, cleanResult(), { now: '2026-11-16T00:00:00.000Z' });
  if (done.nodes.length !== 1) throw new Error(`夹具:干净提案应落 1 节点,实落 ${done.nodes.length}`);
  rawInsertNode(raw, 'n_assistant', DIRTY_ASSISTANT, 'person');
  rawInsertNode(raw, 'n_place', DIRTY_PLACE, 'place');
  rawInsertNode(raw, 'n_legacy', '旧工具', 'tool', { aliases: ['E:/legacy/path', 'deepseek harness'] });
  return { gs, raw };
}

describe('v2 入口闸门与 B 刀的分工(夹具前提,先锁住)', () => {
  it('闸门确实拒收裸角色 / 路径名 place 的新提案——所以存量只能由 B 刀或 A 刀收敛', () => {
    const raw = makeRawDb();
    insertRawRecord(raw, 'r1');
    const gs = new GraphStore();
    gs.init(raw, noopLogger);
    gs.queueGraphProjection(['r1'], 10000);
    const claim = gs.claimNext()!;
    const done = gs.complete(claim.job.id, dirtyOnlyResult(), { now: '2026-11-16T00:00:00.000Z' });
    expect(done.nodes).toEqual([]);
    expect(gs.countsForRebuild().nodes).toBe(0);
    raw.close();
    gs.close();
  });
});

describe('GraphStore.sweepStock:B 刀落库语义', () => {
  it('缺省 dryRun 只报告:库里逐行未变', () => {
    const { gs, raw } = seededWithDirty();
    const cols = 'node_id, name, status, aliases_json, facts_json, tags_json, current_state';
    const before = raw.prepare(`SELECT ${cols} FROM graph_nodes ORDER BY node_id`).all();
    const rp = gs.sweepStock();
    expect(rp.scanned).toBe(4);
    expect(rp.bareRoleArchived).toBe(1);
    expect(rp.placeRenamed).toBe(1);
    // 别名剔除只 1 处:DSH 是**经 complete 落库**的,apply 入档时已按 isAliasShaped 滤过
    // (那正是闸门 filter-on-input 的分工);E:/legacy/path 走直插,才是闸门漏下的存量。
    expect(rp.aliasesPruned).toBe(1);
    const after = raw.prepare(`SELECT ${cols} FROM graph_nodes ORDER BY node_id`).all();
    expect(after).toEqual(before); // 一字未写
    raw.close();
    gs.close();
  });

  it('dryRun=false 真的落库:改名/归档/剔别名/key 归一都在盘上', () => {
    const { gs, raw } = seededWithDirty();
    const rp = gs.sweepStock({ dryRun: false });
    expect(rp.bareRoleArchived).toBe(1);
    const renamed = raw.prepare('SELECT name, status, tags_json FROM graph_nodes WHERE node_id = ?').get('n_place') as
      | { name: string; status: string; tags_json: string }
      | undefined;
    expect(renamed?.name).toBe('mine-dsh-plugins');
    expect(renamed?.status).toBe('active');
    expect(JSON.parse(renamed?.tags_json ?? '[]')).toContain('路径');
    const archived = raw.prepare("SELECT name FROM graph_nodes WHERE status = 'archived'").all() as Array<{ name: string }>;
    expect(archived.map((r) => r.name)).toEqual([DIRTY_ASSISTANT]);
    const dsh = raw.prepare("SELECT aliases_json, facts_json, current_state FROM graph_nodes WHERE name = 'DSH'").get() as
      { aliases_json: string; facts_json: string; current_state: string };
    expect(JSON.parse(dsh.aliases_json)).toEqual(['deepseek harness']);
    expect((JSON.parse(dsh.facts_json) as Array<{ key: string }>)[0]?.key).toBe('状态');
    expect(dsh.current_state).toBe('状态: 进行中');
    raw.close();
    gs.close();
  });

  it('幂等:落库后再扫一轮零变更', () => {
    const { gs, raw } = seededWithDirty();
    const first = gs.sweepStock({ dryRun: false });
    expect(first.touchedIds.length + first.archivedIds.length).toBeGreaterThan(0);
    const second = gs.sweepStock({ dryRun: false });
    expect(second.bareRoleArchived).toBe(0);
    expect(second.placeRenamed).toBe(0);
    expect(second.aliasesPruned).toBe(0);
    expect(second.factsRenamed).toBe(0);
    expect(second.statesRebuilt).toBe(0);
    expect(second.touchedIds).toEqual([]);
    expect(second.archivedIds).toEqual([]);
    raw.close();
    gs.close();
  });

  it('归档节点退出读面:词法检索与可见集都不含它,但行仍在(可恢复)', () => {
    const { gs, raw } = seededWithDirty();
    expect(gs.searchNodes('助手', 5).length).toBe(1);
    gs.sweepStock({ dryRun: false });
    expect(gs.searchNodes('助手', 5)).toEqual([]);
    const visible = gs.loadGraph().nodes.filter((n) => n.status === 'active' || n.status === 'disputed');
    expect(visible.some((n) => n.name === DIRTY_ASSISTANT)).toBe(false);
    const cnt = raw.prepare('SELECT COUNT(*) n FROM graph_nodes WHERE node_id = ?').get('n_assistant') as { n: number };
    expect(cnt.n).toBe(1);
    raw.close();
    gs.close();
  });

  it.runIf(VEC0_OK)('vec0 可用:归档连带删向量行,向量检索不再召回它', () => {
    const { gs, raw } = seededWithDirty();
    expect(gs.nodeVecReady).toBe(true);
    const v = new Float32Array([1, 0, 0, 0]);
    gs.upsertNodeVectors([{ nodeId: 'n_assistant', embedding: v }, { nodeId: 'n_place', embedding: v }]);
    expect(gs.searchNodesByVector(v, 10).some((h) => h.node.id === 'n_assistant')).toBe(true);
    gs.sweepStock({ dryRun: false });
    const left = raw.prepare("SELECT COUNT(*) n FROM graph_node_vec WHERE node_id = 'n_assistant'").get() as { n: number };
    expect(left.n).toBe(0); // 向量行随归档清掉
    const kept = raw.prepare("SELECT COUNT(*) n FROM graph_node_vec WHERE node_id = 'n_place'").get() as { n: number };
    expect(kept.n).toBe(1); // 未归档的不动
    expect(gs.searchNodesByVector(v, 10).some((h) => h.node.id === 'n_assistant')).toBe(false);
    raw.close();
    gs.close();
  });

  it.runIf(VEC0_OK)('向量路状态闸(补的那处缺陷):仅状态翻拱、向量行未删时也不召回', () => {
    // 与上一条的分工:上一条证 sweep **删了**向量行;这一条证即便行还在(历史遗留、
    // 或别的写入方漏删),searchNodesByVector 的节点状态闸也会拦住——双保险各自成立。
    const { gs, raw } = seededWithDirty();
    const v = new Float32Array([1, 0, 0, 0]);
    gs.upsertNodeVectors([{ nodeId: 'n_assistant', embedding: v }]);
    raw.prepare("UPDATE graph_nodes SET status = 'archived' WHERE node_id = 'n_assistant'").run();
    const still = raw.prepare("SELECT COUNT(*) n FROM graph_node_vec WHERE node_id = 'n_assistant'").get() as { n: number };
    expect(still.n).toBe(1); // 刻意留行:只翻状态
    expect(gs.searchNodesByVector(v, 10).some((h) => h.node.id === 'n_assistant')).toBe(false);
    raw.close();
    gs.close();
  });

  it.runIf(VEC0_OK)('落库清扫顺带清掉历史遗留的归档向量残留(线上实测 222 行那类泄漏)', () => {
    const { gs, raw } = seededWithDirty();
    // 造泄漏:n_oldarch 在本轮 sweep 之前就已 archived(模拟旧版 delete/merge 留下的向量残留)。
    // upsertNodeVectors 不看节点状态——残留正是这么来的。n_legacy 是 tool 类型,sweep 不归档它。
    rawInsertNode(raw, 'n_oldarch', '旧归档项目', 'project', { status: 'archived' });
    const v = new Float32Array([1, 0, 0, 0]);
    gs.upsertNodeVectors([{ nodeId: 'n_oldarch', embedding: v }, { nodeId: 'n_legacy', embedding: v }]);
    expect(gs.listNodeVectorIds().sort()).toEqual(['n_legacy', 'n_oldarch']);
    const rp = gs.sweepStock({ dryRun: false });
    // 只清「已归档且仍在向量表里」那一行;在世节点的向量行一个都不能少。
    expect(rp.vecRowsPruned).toBe(1);
    expect(gs.listNodeVectorIds()).toEqual(['n_legacy']);
    // 再跑一次已无残留 → 计数归零(幂等)
    expect(gs.sweepStock({ dryRun: false }).vecRowsPruned).toBe(0);
    raw.close();
    gs.close();
  });
});

describe('GraphStore.resetGraphOnly:A 刀派生投影作废', () => {
  it('六表清空并回报行数;凭证清零后 queueMissing 命中全部存活记录', () => {
    const { gs, raw } = seededWithDirty();
    insertRawRecord(raw, 'r2');
    insertRawRecord(raw, 'r3');
    expect(gs.countMissing()).toBe(2); // r2/r3 从未投影
    const before = gs.countsForRebuild();
    expect(before.nodes).toBe(4);
    expect(before.projected).toBe(1);
    const cleared = gs.resetGraphOnly();
    expect(cleared).toEqual(before);
    expect(gs.countsForRebuild()).toEqual({ nodes: 0, edges: 0, concepts: 0, jobs: 0, projected: 0 });
    // L1 事实源一字未动:A 刀只删派生行
    const l1 = raw.prepare('SELECT COUNT(*) n FROM l1_records').get() as { n: number };
    expect(l1.n).toBe(3);
    // 重建的核心机制:凭证没了 → queueMissing 的 WHERE 命中**全部**记录(含已投影过的
    // r1)。注意返回值是 job 数而非记录数:入队按 GRAPH_JOB_BATCH=8 分片,3 条 → 1 个
    // 作业。runner.rebuildGraph 与工具面回报都以此为「作业数」口径,不混称记录数。
    expect(gs.countMissing()).toBe(3);
    expect(gs.queueMissing(9000)).toBe(1);
    expect(gs.countMissing()).toBe(0);
    const mapped = raw.prepare('SELECT COUNT(*) n FROM graph_job_records').get() as { n: number };
    expect(mapped.n).toBe(3); // 记录侧确实是全量映射
    raw.close();
    gs.close();
  });

  it('重复调用幂等;向量表存在与否都不阻断', () => {
    const { gs, raw } = seededWithDirty();
    expect(gs.resetGraphOnly().nodes).toBe(4);
    expect(gs.resetGraphOnly()).toEqual({ nodes: 0, edges: 0, concepts: 0, jobs: 0, projected: 0 });
    raw.close();
    gs.close();
  });

  it('降级态(连接已关)→ 三个入口安全 no-op 不抛', () => {
    const raw = new DatabaseSync(':memory:');
    raw.close();
    const gs = new GraphStore();
    gs.init(raw);
    expect(gs.ready).toBe(false);
    expect(gs.countsForRebuild()).toEqual({ nodes: 0, edges: 0, concepts: 0, jobs: 0, projected: 0 });
    expect(gs.resetGraphOnly().nodes).toBe(0);
    const rp = gs.sweepStock({ dryRun: false });
    expect(rp.scanned).toBe(0);
    expect(rp.touchedIds).toEqual([]);
  });
});

describe('归档不复活(B 刀的持久性)', () => {
  // 为什么单独一组:B 刀把泛称/place 判成 archived,而 apply 的合并路径原本无条件写
  // `node.status = status`(投影缺省即 active)。于是**下一批投影命中同名实体就把归档行
  // 翻回 active**,task_28 的 bareRole=0 会随时间自己回退。0.26.59 之前没有任何测试锁这条,
  // 探针也是带正对照才确认的(对照组不写,反例的「不写」不算证据)。
  it('同名提案不再把 archived 写回 active;内容照样更新', () => {
    const { gs, raw } = seededWithDirty();
    rawInsertNode(raw, 'n_archtool', 'FooTool', 'tool', { status: 'archived' });
    insertRawRecord(raw, 'r9');
    gs.queueGraphProjection(['r9'], 10000);
    const claim = gs.claimNext();
    if (!claim) throw new Error('夹具:应能 claim 到新 job');
    gs.complete(claim.job.id, {
      reason: '归档后再次被提到',
      edges: [],
      nodes: [{ ref: 'a', name: 'FooTool', type: 'tool', facts: [{ key: '用途', value: '仍在用', sourceRecordIds: ['r9'] }], sourceRecordIds: ['r9'] }],
    }, { now: '2026-11-17T00:00:00.000Z' });
    const row = raw.prepare("SELECT status, facts_json f FROM graph_nodes WHERE node_id = 'n_archtool'").get() as { status: string; f: string };
    expect(row.status).toBe('archived'); // 否决权高于投影的默认值
    expect((JSON.parse(row.f) as unknown[]).length).toBe(1); // 内容更新不受影响——只拦状态
    raw.close();
    gs.close();
  });

  it('投影**显式**表态仍生效(只拦缺省 active);active 节点不受影响', () => {
    const { gs, raw } = seededWithDirty();
    rawInsertNode(raw, 'n_arch2', 'BarTool', 'tool', { status: 'archived' });
    insertRawRecord(raw, 'r9');
    gs.queueGraphProjection(['r9'], 10000);
    const claim = gs.claimNext();
    if (!claim) throw new Error('夹具:应能 claim 到新 job');
    gs.complete(claim.job.id, {
      reason: '显式 disputed',
      edges: [],
      nodes: [
        { ref: 'a', name: 'BarTool', type: 'tool', status: 'disputed', sourceRecordIds: ['r9'] },
        { ref: 'b', name: 'DSH', type: 'project', sourceRecordIds: ['r9'] }, // 夹具里是 active,应仍 active
      ],
    }, { now: '2026-11-17T00:00:00.000Z' });
    // 按 name 查:complete() 生成的行 id 来自 idFactory,不是字面量(踩过)
    const g = (name: string) => (raw.prepare('SELECT status FROM graph_nodes WHERE name = ?').get(name) as { status: string }).status;
    expect(g('BarTool')).toBe('disputed'); // 显式表态 = 人有理由重新讨论它,不该被拦
    expect(g('BarTool')).not.toBe('archived');
    expect(g('DSH')).toBe('active');
    raw.close();
    gs.close();
  });
});