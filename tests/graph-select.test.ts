/**
 * 记忆库元素选择(selectExplorerNodes)验收面。
 *
 * 钉住的性质(spec S5):
 * ① 未超限 → 全选、truncated=false、三层计数全 0、输出顺序=入参顺序(与 buildFullView 同形);
 * ② 超限时 nodes.length === nodeCap 且 counts 三层之和 === nodes.length;
 * ③ **老 hub 不独占名额**:高度数 hub 存在时,最新的孤立点仍必须入选(新鲜层);
 * ④ 窄预算下每层至少 1 个名额(floor(cap×0.2)=0 的退化要防住);
 * ⑤ 边只画两端都入选的;edgeCap 紧张时因果边优先保留;
 * ⑥ 不可见(superseded/archived)节点与其悬挂边一律不出现;
 * ⑦ 同输入两次调用逐位一致;totalVisible/totalEdges 给出截断前的真实分母。
 */
import { describe, expect, it } from 'vitest';
import { selectExplorerNodes } from '../src/graph/select.js';
import type { GraphEdge, GraphNode } from '../src/graph/types.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';

function node(id: string, opts: { status?: GraphNode['status']; updatedAt?: string } = {}): GraphNode {
  return {
    id,
    name: `n-${id}`,
    type: 'tool',
    aliases: [],
    tags: [],
    currentState: '',
    facts: [],
    status: opts.status ?? 'active',
    confidence: 1,
    sourceRecordIds: [`${id}-rec`],
    families: [],
    createdAt: T0,
    updatedAt: opts.updatedAt ?? T0,
  };
}

function edge(from: string, to: string, relation = '依赖', status: GraphEdge['status'] = 'active'): GraphEdge {
  return {
    id: `e-${from}-${to}-${relation}`,
    fromNodeId: from,
    toNodeId: to,
    relation,
    status,
    confidence: 1,
    sourceRecordIds: [],
    createdAt: T0,
    updatedAt: T0,
  };
}

/** 造 n 个孤立点(id 带序号,便于断言顺序)。 */
function plain(n: number, updatedAt = T0): GraphNode[] {
  return Array.from({ length: n }, (_, i) => node(`p${i}`, { updatedAt }));
}

describe('selectExplorerNodes —— 未超限', () => {
  it('全选、不截断、三层计数全 0、顺序保持入参序', () => {
    const nodes = [...plain(3), node('x', { status: 'superseded' })];
    const r = selectExplorerNodes(nodes, [], { nodeCap: 10, edgeCap: 10 });
    expect(r.nodes.map((n) => n.id)).toEqual(['p0', 'p1', 'p2']); // 不可见者被剔,余下保持原序
    expect(r.truncated).toBe(false);
    expect(r.counts).toEqual({ skeleton: 0, fresh: 0, tail: 0 });
    expect(r.totalVisible).toBe(3);
  });

  it('恰好等于 cap → 不算截断', () => {
    const r = selectExplorerNodes(plain(5), [], { nodeCap: 5 });
    expect(r.nodes).toHaveLength(5);
    expect(r.truncated).toBe(false);
  });
});

describe('selectExplorerNodes —— 三层配额', () => {
  it('超限 → nodes.length === cap 且三层之和 === nodes.length', () => {
    const nodes = [...plain(20)];
    const r = selectExplorerNodes(nodes, [], { nodeCap: 8, edgeCap: 100 });
    expect(r.nodes).toHaveLength(8);
    expect(r.truncated).toBe(true);
    expect(r.counts.skeleton + r.counts.fresh + r.counts.tail).toBe(8);
    expect(r.totalVisible).toBe(20);
  });

  it('老 hub 不独占名额:高度数 hub 存在时,最新的孤立点仍入选', () => {
    const hub = node('hub');
    const leaves = Array.from({ length: 6 }, (_, i) => node(`l${i}`));
    const newcomer = node('newcomer', { updatedAt: T1 }); // 刚沉淀、度 0
    const edges = leaves.map((l) => edge('hub', l.id));
    const r = selectExplorerNodes([hub, ...leaves, newcomer], edges, { nodeCap: 4, edgeCap: 50 });
    const ids = r.nodes.map((n) => n.id);
    expect(ids).toContain('hub');       // 骨架层拿到主干
    expect(ids).toContain('newcomer');  // 新鲜层保住新记忆(纯 degree 排序会把它挤掉)
    expect(r.counts.fresh).toBeGreaterThanOrEqual(1);
  });

  it('窄预算(cap=2)下每层仍至少 1 个名额', () => {
    const hub = node('hub');
    const leaves = Array.from({ length: 4 }, (_, i) => node(`k${i}`));
    const r = selectExplorerNodes([hub, ...leaves], leaves.map((l) => edge('hub', l.id)), { nodeCap: 2 });
    expect(r.nodes).toHaveLength(2);
    expect(r.counts.skeleton).toBe(1);
    expect(r.counts.fresh).toBe(1);
  });

  it('孤立点不占骨架层:全是度 0 时骨架层取到 cap 上限内、新鲜层保住最新者', () => {
    const nodes = [...plain(10, T0), node('latest', { updatedAt: T1 })];
    const r = selectExplorerNodes(nodes, [], { nodeCap: 3 });
    expect(r.nodes.map((n) => n.id)).toContain('latest');
    expect(r.counts.fresh + r.counts.skeleton + r.counts.tail).toBe(3);
  });
});

describe('selectExplorerNodes —— 边', () => {
  it('一端未入选的边不画(星图上不出现悬空线)', () => {
    const a = node('a');
    const b = node('b');
    const c = node('c');
    const edges = [edge('a', 'b'), edge('a', 'c')];
    const r = selectExplorerNodes([a, b, c], edges, { nodeCap: 2, edgeCap: 10 });
    expect(r.nodes).toHaveLength(2);
    for (const e of r.edges) {
      expect(r.nodes.some((n) => n.id === e.from)).toBe(true);
      expect(r.nodes.some((n) => n.id === e.to)).toBe(true);
    }
  });

  it('edgeCap 紧张时因果边优先保留', () => {
    const hub = node('hub');
    const leaves = [node('c1'), node('c2'), node('p1')];
    const edges = [edge('hub', 'p1', '依赖'), edge('hub', 'c1', '导致'), edge('hub', 'c2', '取代')];
    const r = selectExplorerNodes([hub, ...leaves], edges, { nodeCap: 10, edgeCap: 2 });
    expect(r.edges).toHaveLength(2);
    expect(r.edges.every((e) => e.causal)).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it('非 active 边一律不出现', () => {
    const nodes = [node('a'), node('b')];
    const r = selectExplorerNodes(nodes, [edge('a', 'b', '依赖', 'archived')], {});
    expect(r.edges).toEqual([]);
    expect(r.totalEdges).toBe(0);
  });
});

describe('selectExplorerNodes —— 确定性与分母', () => {
  it('同输入两次调用逐位一致', () => {
    const hub = node('hub');
    const nodes = [hub, ...Array.from({ length: 30 }, (_, i) => node(`q${i}`, { updatedAt: i % 3 === 0 ? T1 : T0 }))];
    const edges = nodes.slice(1).map((n) => edge('hub', n.id, n.id === 'q7' ? '导致' : '依赖'));
    const caps = { nodeCap: 12, edgeCap: 6 };
    expect(selectExplorerNodes(nodes, edges, caps)).toEqual(selectExplorerNodes(nodes, edges, caps));
  });

  it('caps 非法值钳到 ≥1(不出现空图)', () => {
    const r = selectExplorerNodes([node('a'), node('b')], [edge('a', 'b')], { nodeCap: 0, edgeCap: -5 });
    expect(r.nodes.length).toBeGreaterThanOrEqual(1);
    expect(r.truncated).toBe(true);
  });
});
