/**
 * 召回读路缓存（2026-11-09）：钉住五条不变量，防"缓存把语义改坏"。
 *
 * ① 节点分词缓存按**内容签名**失效：内容变了旧词立刻消失、新词立刻命中；
 * ② 预建关系词邻接表（graphLane 复用）与函数内重建结果逐项一致；
 * ③ 全图读缓存命中同一快照，且**任何写事务提交后**立即失效（不依赖脏标记）；
 * ④ 同连接、同毫秒（updated_time 与 MAX 相同）的写入也立即可见；
 * ⑤ PRAGMA data_version 兜住**外部连接**把 updated_time 写成与 MAX 相同的写入；
 * ⑥ 预热跳过 archived/superseded 节点，且返回"实际建分词"的计数。
 *
 * 用真实 node:sqlite（临时文件），不 mock 引擎。写缝（private tx/upsertTouchedInTx）
 * 经结构化 cast 调用——本文件测的就是这两个内部缝的失效协作。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRelationTokenAdjacency, searchGraphNodes, warmNodeTokens } from '../src/graph/search.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { GraphEdge, GraphNode } from '../src/graph/types.js';

const T = '2026-09-06T07:00:00.000Z';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-recall-cache-'));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function node(over: Partial<GraphNode> & { id: string; name: string }): GraphNode {
  return {
    type: 'project',
    aliases: [],
    tags: [],
    currentState: '',
    facts: [],
    status: 'active',
    confidence: 0.8,
    sourceRecordIds: ['r1'],
    families: ['work'],
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function edge(over: Partial<GraphEdge> & { id: string }): GraphEdge {
  return {
    fromNodeId: 'n-a',
    toNodeId: 'n-b',
    relation: '依赖',
    status: 'active',
    confidence: 0.8,
    sourceRecordIds: [],
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

/** GraphStore 的 private 写缝：单测直接驱动"tx 提交 → 缓存失效"这条协作。 */
interface GraphInternals {
  tx<T>(fn: () => T): T;
  upsertTouchedInTx(nodes: GraphNode[], edges: GraphEdge[]): void;
}
const internals = (gs: unknown): GraphInternals => gs as GraphInternals;

function openDb(name: string): MemoryDb {
  const db = new MemoryDb(join(dir, name), 0);
  db.init();
  return db;
}

describe('graph token cache', () => {
  it('rebuilds on content change: old token disappears, new token hits', () => {
    const edges: GraphEdge[] = [];
    const before = node({ id: 'n-token', name: '分词缓存键 zzalpha' });
    expect(searchGraphNodes([before], edges, 'zzalpha', 5).map((h) => h.node.id)).toEqual(['n-token']);
    // 不变内容 → 缓存命中，结果稳定
    expect(searchGraphNodes([before], edges, 'zzalpha', 5).map((h) => h.node.id)).toEqual(['n-token']);
    // 改名（updatedAt 故意不变：签名只认内容，不认时间戳）
    const after = node({ id: 'n-token', name: '分词缓存键 zzbeta' });
    expect(searchGraphNodes([after], edges, 'zzalpha', 5)).toEqual([]);
    expect(searchGraphNodes([after], edges, 'zzbeta', 5).map((h) => h.node.id)).toEqual(['n-token']);
  });

  it('prebuilt adjacency equals the in-function build (same hits, order and scores)', () => {
    const nodes = [
      node({ id: 'n-a', name: '依赖方甲' }),
      node({ id: 'n-b', name: '依赖方乙' }),
    ];
    const edges = [edge({ id: 'e1', fromNodeId: 'n-a', toNodeId: 'n-b', relation: '依赖' })];
    const plain = searchGraphNodes(nodes, edges, '依赖', 5);
    const reused = searchGraphNodes(nodes, edges, '依赖', 5, { adjacency: buildRelationTokenAdjacency(edges) });
    expect(plain.length).toBeGreaterThan(0);
    expect(reused).toEqual(plain);
  });
});

describe('graph read cache', () => {
  it('serves one cached snapshot and drops it on every write transaction', () => {
    const db = openDb('cache.db');
    const gs = db.graphStore;
    const snapshot = gs.loadGraph();
    expect(gs.loadGraph()).toBe(snapshot); // 缓存命中：同一对象
    internals(gs).tx(() => internals(gs).upsertTouchedInTx([node({ id: 'n-w', name: '写事务可见' })], []));
    expect(gs.loadGraph()).not.toBe(snapshot); // 提交即失效
    expect(gs.loadGraph().nodes.map((n) => n.id)).toContain('n-w');
  });

  it('same-connection same-millisecond write is immediately visible', () => {
    const db = openDb('same-ms.db');
    const gs = db.graphStore;
    const arena = internals(gs);
    arena.tx(() => arena.upsertTouchedInTx([node({ id: 'n-ms', name: '同毫秒写 zzold' })], []));
    expect(gs.searchNodes('zzold', 5).map((h) => h.node.id)).toEqual(['n-ms']); // 建立缓存
    // 同一 id、同一 updatedAt（= 当前 MAX）改内容：timestamp 指纹看不出变化
    arena.tx(() => arena.upsertTouchedInTx([node({ id: 'n-ms', name: '同毫秒写 zznew' })], []));
    expect(gs.searchNodes('zzold', 5)).toEqual([]);
    expect(gs.searchNodes('zznew', 5).map((h) => h.node.id)).toEqual(['n-ms']);
  });

  it('data_version catches an external write that reuses the same updated_time', () => {
    const db = openDb('external.db');
    const gs = db.graphStore;
    const arena = internals(gs);
    arena.tx(() => arena.upsertTouchedInTx([node({ id: 'n-ext', name: '外部写 zzold' })], []));
    expect(gs.searchNodes('zzold', 5).map((h) => h.node.id)).toEqual(['n-ext']); // 建立缓存
    const file = join(dir, 'external.db');
    const ext = new DatabaseSync(file);
    try {
      const max = (ext.prepare('SELECT MAX(updated_time) AS m FROM graph_nodes').get() as { m: string }).m;
      // 关键：updated_time 写成与 MAX 完全相同（同毫秒/不带时间戳的写），只有 data_version 会变
      ext.prepare('UPDATE graph_nodes SET name = ?, updated_time = ? WHERE node_id = ?').run('外部写 zznew', max, 'n-ext');
    } finally {
      ext.close();
    }
    expect(gs.searchNodes('zznew', 5).map((h) => h.node.id)).toEqual(['n-ext']);
  });
});

describe('warmup', () => {
  it('skips archived/superseded nodes and returns the tokenized count', async () => {
    const nodes = [
      node({ id: 'n-active', name: '预热 active' }),
      node({ id: 'n-disputed', name: '预热 disputed', status: 'disputed' }),
      node({ id: 'n-archived', name: '预热 archived', status: 'archived' }),
      node({ id: 'n-superseded', name: '预热 superseded', status: 'superseded' }),
    ];
    // 纯函数：只统计 active|disputed
    expect(warmNodeTokens(nodes)).toBe(2);

    const db = openDb('warm.db');
    const gs = db.graphStore;
    const arena = internals(gs);
    arena.tx(() => arena.upsertTouchedInTx(nodes, []));
    const warmed = await gs.warmSearchCache(() => false, 2);
    expect(warmed.nodes).toBe(2); // 实际建分词数 = active + disputed
    expect(warmed.edges).toBe(0);
    // 预热后检索仍只用 active|disputed（archived 不可见）
    expect(gs.searchNodes('预热', 10).every((h) => h.node.status !== 'archived' && h.node.status !== 'superseded')).toBe(true);
  });
});
