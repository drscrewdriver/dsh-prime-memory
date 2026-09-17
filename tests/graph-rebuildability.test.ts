/**
 * 图谱可重建性冒烟测试(task_12,§G 的唯一保险机制)。
 *
 * 锁死的前提:**图谱是 L1 的可重建派生投影——不存在只属于图谱的事实。**
 * 该前提是 T4 换引擎自由的唯一保障,也是 §G「不引入图数据库」决策的成立依据:
 * 引擎可随时更换,因为图谱是「重建」而非「迁移」。
 *
 * 三条断言(判据经 Wave 1 执行期修正,原「drop 后逐字段一致」实测不可实现,详见
 * `evidence/README.md` 与 `findings.md §11`):
 *
 *  ① 零无来源不变量 —— 每个 node/fact/edge 的来源非空,且指向存活的 L1 记录。
 *  ② 负向验证 —— 绕过 apply 直接注入无来源行时,①**必须失败**。
 *     否则该测试只是空转,守不住任何东西。
 *  ③ 结构同构重建 —— drop 掉 5 张图谱表 → 从 L1 重投影 → 归一 `id`/`createdAt`/
 *     `updatedAt` 后逐字段一致。
 *
 * 为何 ③ 必须归一 id 与时间戳(不可按字面「逐字段」):
 * `pipeline/graph.ts:110` 的真实投影路径调用
 * `complete(job.id, result, { now: ... })`——**只注入 now,不注入 idFactory**,
 * 故 id 回落 `node_${Date.now()}_${randomBytes(3)}`。任何重投影的每一行 id 与
 * 时间戳必然不同。既有测试之所以确定,是因为它们在**纯函数层**注入 idFactory
 * (`graph.test.ts`、`graph-store.test.ts`、`graph-pipeline.test.ts`),
 * 而真实管线路径恰恰不注入。
 *
 * 边界(§G 正式澄清):`markSourcesDeleted` 保留来源已从 L1 删除的 `archived`
 * 墓碑行(`graph-store.ts:659-698`),故**墓碑不可由当前 L1 快照重建**。
 * 因此 ③ 使用无删除夹具,墓碑由 ① 的显式豁免单独覆盖。
 * 正确层次是 **L0 事实源 → L1 → 图谱**(见 `pipeline/rebuild.ts:2` 的重建定义)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { normalizeEntityName } from '../src/graph/apply.js';
import type { GraphEdge, GraphNode } from '../src/graph/types.js';
import { runGraphProjection } from '../src/pipeline/graph.js';
import { GRAPH_PROJECTION_EXAMPLE } from '../src/prompts/graph-projection.js';
import { GraphStore } from '../src/store/graph-store.js';
import type { MemoryConfig, MemoryLogger } from '../src/types.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-graph-rebuild-'));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** 图谱域 5 张表(与 `graph-store.ts:198-253` 的建表清单一致)。 */
const GRAPH_TABLES = [
  'graph_nodes',
  'graph_edges',
  'graph_projection_jobs',
  'graph_job_records',
  'graph_projected_records',
] as const;

/**
 * 最小 L1 夹具:只建图谱读路径实际用到的列(`l1SelectCols` 会按 `PRAGMA table_info`
 * 现查现拼,缺时间增强列时自动退回基础列)。
 * `created_time` 固定 → `anchorTimeFromRecords` 的兜底时间锚可复现,
 * ③ 的 `validFrom` 才不依赖 `now`。
 */
function makeRawDb(file: string): DatabaseSync {
  const raw = new DatabaseSync(file, { allowExtension: false });
  raw.exec(`
    CREATE TABLE IF NOT EXISTS l1_records (
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

/** 假宿主 ctx:单次流式回包固定文本(重放 golden 样例 → 投影输入确定)。 */
function fakeCtx(response: string): Context {
  return {
    llm: {
      async *stream() {
        yield { type: 'block-end', block: { type: 'text', text: response } };
        yield { type: 'usage', usage: { outputTokens: 120, reasoningTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'normal' } };
      },
    },
    get: () => undefined,
    effect: (fn: () => (() => void) | void) => {
      const d = fn();
      return typeof d === 'function' ? d : () => {};
    },
    on: () => () => {},
  } as unknown as Context;
}

function graphCfg(): MemoryConfig {
  return {
    llm: {
      provider: 'p', model: 'm', mode: 'host', baseURL: '', apiKey: '',
      maxTokens: 65536, reasoningEffort: '', temperature: 0.3,
      maxInputChars: 100000, timeoutMs: 1000,
    },
  } as unknown as MemoryConfig;
}

/** golden 样例硬编码引用 `rec-1`/`rec-2`(见 `prompts/graph-projection.ts`)。 */
const FIXTURE_RECORDS = ['rec-1', 'rec-2'] as const;

/**
 * 从 L1 全量重投影:入队 → 反复跑真实管线直到无 job 可 claim。
 * `runGraphProjection` 每次只 claim 一个 job(`pipeline/graph.ts:96`),故需循环。
 * 返回实际执行的轮数,用于断言「确实投影了东西」而非空转。
 */
async function projectAllFromL1(gs: GraphStore, ctx: Context): Promise<number> {
  gs.queueGraphProjection([...FIXTURE_RECORDS], 10000);
  let rounds = 0;
  while (await runGraphProjection(ctx, graphCfg(), gs, noopLogger)) {
    rounds++;
    if (rounds > 20) throw new Error('投影未收敛(疑似 job 状态机死循环)');
  }
  return rounds;
}

interface Violation {
  kind: 'node' | 'fact' | 'edge';
  id: string;
  detail: string;
}

function parseSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * ① 的不变量检查器(测试侧纯函数,**不侵入产品代码**)。
 *
 * 规则:
 *  - 每个 node / fact / edge 的 `sourceRecordIds` 必须非空;
 *  - 每个引用 id 必须存在于 `l1_records`;
 *  - **墓碑豁免**:`status==='archived'` 的行(及其内嵌 facts)按设计来源已删,
 *    只豁免「存活性」,「非空」仍必须满足——空来源的墓碑同样是违规。
 */
function checkProvenanceInvariant(raw: DatabaseSync): Violation[] {
  const violations: Violation[] = [];
  const alive = new Set<string>(
    (raw.prepare('SELECT record_id FROM l1_records').all() as Array<{ record_id: string }>).map(
      (r) => r.record_id,
    ),
  );

  const check = (
    kind: Violation['kind'],
    id: string,
    sources: readonly string[],
    archived: boolean,
  ): void => {
    if (sources.length === 0) {
      violations.push({ kind, id, detail: '来源为空——图谱里存在无 L1 来源的事实' });
      return;
    }
    if (archived) return; // 墓碑:来源按设计已从 L1 删除
    for (const s of sources) {
      if (!alive.has(s)) violations.push({ kind, id, detail: `来源 ${s} 不在 l1_records 中` });
    }
  };

  const nodeRows = raw.prepare('SELECT * FROM graph_nodes').all() as Array<Record<string, unknown>>;
  for (const n of nodeRows) {
    const nodeId = String(n.node_id);
    const nodeArchived = String(n.status) === 'archived';
    check('node', nodeId, parseSafe<string[]>(n.source_record_ids_json as string, []), nodeArchived);
    const facts = parseSafe<Array<{ id?: string; key?: string; status?: string; sourceRecordIds?: string[] }>>(
      n.facts_json as string,
      [],
    );
    for (const f of facts) {
      check(
        'fact',
        `${nodeId}#${f.id ?? f.key ?? '?'}`,
        Array.isArray(f.sourceRecordIds) ? f.sourceRecordIds : [],
        // fact 自身无 archived 态:随宿主节点墓碑化
        nodeArchived || f.status === 'archived',
      );
    }
  }

  const edgeRows = raw.prepare('SELECT * FROM graph_edges').all() as Array<Record<string, unknown>>;
  for (const e of edgeRows) {
    check(
      'edge',
      String(e.edge_id),
      parseSafe<string[]>(e.source_record_ids_json as string, []),
      String(e.status) === 'archived',
    );
  }

  return violations;
}

/**
 * ③ 的归一化:抹掉**计算来源性**字段(`id` / `createdAt` / `updatedAt`,由随机
 * idFactory 与 wall-clock now 决定),保留全部**内容性**字段。
 * 边用「节点 key」而非 node id 引用,使比较与 id 无关。
 */
function canonicalize(graph: { nodes: GraphNode[]; edges: GraphEdge[] }): unknown {
  const keyOf = (n: GraphNode): string => `${n.type}|${normalizeEntityName(n.name)}`;
  const keyById = new Map(graph.nodes.map((n) => [n.id, keyOf(n)]));
  const sorted = (xs: readonly string[]): string[] => [...xs].sort();

  const nodes = graph.nodes
    .map((n) => ({
      key: keyOf(n),
      name: n.name,
      type: n.type,
      aliases: sorted(n.aliases),
      tags: sorted(n.tags ?? []),
      currentState: n.currentState,
      status: n.status,
      confidence: n.confidence,
      sourceRecordIds: sorted(n.sourceRecordIds),
      families: sorted(n.families),
      facts: n.facts
        .map((f) => ({
          key: f.key,
          value: f.value,
          status: f.status,
          validFrom: f.validFrom,
          validTo: f.validTo ?? null,
          confidence: f.confidence,
          sourceRecordIds: sorted(f.sourceRecordIds),
        }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const edges = graph.edges
    .map((e) => ({
      from: keyById.get(e.fromNodeId) ?? `<不可解析:${e.fromNodeId}>`,
      to: keyById.get(e.toNodeId) ?? `<不可解析:${e.toNodeId}>`,
      relation: e.relation,
      status: e.status,
      validFrom: e.validFrom ?? null,
      validTo: e.validTo ?? null,
      confidence: e.confidence,
      sourceRecordIds: sorted(e.sourceRecordIds),
    }))
    .sort((a, b) => {
      const ka = `${a.from}|${a.relation}|${a.to}|${a.status}`;
      const kb = `${b.from}|${b.relation}|${b.to}|${b.status}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  return { nodes, edges };
}

/** 建一个已投影完成的图谱夹具(原始句柄 + GraphStore)。 */
function projectedFixture(file: string): { raw: DatabaseSync; gs: GraphStore } {
  const raw = makeRawDb(join(dir, file));
  for (const id of FIXTURE_RECORDS) insertRawRecord(raw, id);
  const gs = new GraphStore();
  gs.init(raw);
  return { raw, gs };
}

describe('task_12 ① 零无来源不变量', () => {
  it('正常投影后:所有 node/fact/edge 来源非空且指向存活 L1 记录', async () => {
    const { raw, gs } = projectedFixture('inv-ok.db');
    const rounds = await projectAllFromL1(gs, fakeCtx(JSON.stringify(GRAPH_PROJECTION_EXAMPLE)));
    expect(rounds).toBe(1);

    const graph = gs.loadGraph();
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);

    expect(checkProvenanceInvariant(raw)).toEqual([]);

    // 不变量必须真的覆盖到了每一类行,否则「零违例」可能只是因为没检查到东西
    const factCount = graph.nodes.reduce((acc, n) => acc + n.facts.length, 0);
    expect(factCount).toBeGreaterThan(0);
    for (const n of graph.nodes) expect(n.sourceRecordIds.length).toBeGreaterThan(0);
    for (const e of graph.edges) expect(e.sourceRecordIds.length).toBeGreaterThan(0);
    for (const n of graph.nodes) for (const f of n.facts) expect(f.sourceRecordIds.length).toBeGreaterThan(0);

    gs.close();
    raw.close();
  });

  it('墓碑边界:来源已从 L1 删除的 archived 行豁免存活检查,但来源仍必须非空', async () => {
    const { raw, gs } = projectedFixture('inv-tomb.db');
    await projectAllFromL1(gs, fakeCtx(JSON.stringify(GRAPH_PROJECTION_EXAMPLE)));
    expect(checkProvenanceInvariant(raw)).toEqual([]);

    // 删除全部来源 → 删除传播把节点/边标 archived(墓碑保留,来源已死)
    raw.exec("DELETE FROM l1_records WHERE record_id IN ('rec-1','rec-2')");
    gs.markSourcesDeleted(['rec-1', 'rec-2']);

    const archived = gs.loadGraph().nodes.filter((n) => n.status === 'archived');
    expect(archived.length).toBeGreaterThan(0);
    // 来源确实已经不在 L1 了 —— 这正是「墓碑不可由当前 L1 快照重建」的证据
    for (const n of archived) {
      for (const s of n.sourceRecordIds) {
        const hit = raw.prepare('SELECT 1 FROM l1_records WHERE record_id = ?').get(s);
        expect(hit).toBeUndefined();
      }
    }
    // 豁免生效:不因来源已死而报违例
    expect(checkProvenanceInvariant(raw)).toEqual([]);

    gs.close();
    raw.close();
  });
});

describe('task_12 ② 负向验证(证明测试真在守护前提)', () => {
  it('直接注入「来源为空」的节点 → 不变量必须报违例', async () => {
    const { raw, gs } = projectedFixture('neg-empty.db');
    await projectAllFromL1(gs, fakeCtx(JSON.stringify(GRAPH_PROJECTION_EXAMPLE)));
    expect(checkProvenanceInvariant(raw)).toEqual([]);

    // 绕过 apply 的 validSources 硬校验,直接落一条无来源行
    raw
      .prepare(
        `INSERT INTO graph_nodes (node_id, name, type, source_record_ids_json, status)
         VALUES ('ghost-node', '幽灵实体', 'person', '[]', 'active')`,
      )
      .run();

    const violations = checkProvenanceInvariant(raw);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.id === 'ghost-node' && v.kind === 'node')).toBe(true);
    expect(violations.find((v) => v.id === 'ghost-node')!.detail).toContain('来源为空');

    gs.close();
    raw.close();
  });

  it('直接注入「来源指向不存在记录」的节点 → 不变量必须报违例', async () => {
    const { raw, gs } = projectedFixture('neg-dangling.db');
    await projectAllFromL1(gs, fakeCtx(JSON.stringify(GRAPH_PROJECTION_EXAMPLE)));
    expect(checkProvenanceInvariant(raw)).toEqual([]);

    raw
      .prepare(
        `INSERT INTO graph_nodes (node_id, name, type, source_record_ids_json, status)
         VALUES ('dangling-node', '悬空实体', 'person', '["never-existed"]', 'active')`,
      )
      .run();

    const violations = checkProvenanceInvariant(raw);
    expect(violations.some((v) => v.id === 'dangling-node' && v.detail.includes('never-existed'))).toBe(true);

    gs.close();
    raw.close();
  });

  it('正向对照:同样无来源的提案走 apply 会被硬校验丢弃(两条防线都成立)', async () => {
    const { raw, gs } = projectedFixture('neg-apply.db');
    // 入队后手动 claim,用「来源为空」的提案调 complete
    expect(gs.queueGraphProjection([...FIXTURE_RECORDS], 10000)).toBe(1);
    const claim = gs.claimNext()!;
    gs.complete(claim.job.id, {
      reason: '',
      nodes: [
        { ref: 'a', name: '合法实体', type: 'person', sourceRecordIds: ['rec-1'] },
        { ref: 'b', name: '无来源实体', type: 'person', sourceRecordIds: [] },
        { ref: 'c', name: '越批实体', type: 'person', sourceRecordIds: ['别人的记录'] },
      ],
      edges: [],
    });

    const names = gs.loadGraph().nodes.map((n) => n.name);
    expect(names).toContain('合法实体');
    // apply 的 validSources 把无来源/越批提案整条丢弃 → 落库的图谱天然满足①
    expect(names).not.toContain('无来源实体');
    expect(names).not.toContain('越批实体');
    expect(checkProvenanceInvariant(raw)).toEqual([]);

    gs.close();
    raw.close();
  });
});

describe('task_12 ③ 结构同构重建(drop 5 表 → 从 L1 重投影)', () => {
  it('drop 后从 L1 重投影,归一 id/时间后与重建前逐字段一致', async () => {
    const { raw, gs } = projectedFixture('rebuild.db');
    const ctx = fakeCtx(JSON.stringify(GRAPH_PROJECTION_EXAMPLE));

    // ── 重建前 ──
    await projectAllFromL1(gs, ctx);
    const before = gs.loadGraph();
    const beforeCanonical = canonicalize(before);
    expect(before.nodes.length).toBeGreaterThan(0);
    expect(before.edges.length).toBeGreaterThan(0);
    expect(checkProvenanceInvariant(raw)).toEqual([]);

    // 已投影去重生效:不 drop 则无法重复入队
    expect(gs.queueGraphProjection([...FIXTURE_RECORDS], 10000)).toBe(0);

    // ── 真 drop(不是 DELETE 清数据),并断言表确实消失 ──
    for (const t of GRAPH_TABLES) raw.exec(`DROP TABLE IF EXISTS ${t}`);
    const survived = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'graph_%'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(survived).toEqual([]);

    // ── 重建:重新建表 + 从 L1 全量重投影 ──
    gs.init(raw);
    const rounds = await projectAllFromL1(gs, ctx);
    expect(rounds).toBe(1);

    const after = gs.loadGraph();
    expect(checkProvenanceInvariant(raw)).toEqual([]);

    // 归一 id/createdAt/updatedAt 后逐字段一致
    expect(canonicalize(after)).toEqual(beforeCanonical);

    // 顺带钉住「id 确实变了」——证明归一化不是为了掩盖空转
    const beforeIds = new Set(before.nodes.map((n) => n.id));
    const afterIds = after.nodes.map((n) => n.id);
    expect(afterIds.some((id) => beforeIds.has(id))).toBe(false);

    gs.close();
    raw.close();
  });
});
