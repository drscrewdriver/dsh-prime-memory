/**
 * 2D ego 子集纯函数（graph-canvas-data.egoSubgraph）验收面。
 *
 * 钉住的性质：
 * ① BFS ≤hops：第 hops+1 跳节点不出现；环不死循环；
 * ② 边只留两端都入选的（悬挂边剔除）；
 * ③ root 不存在 → 空结构不抛；孤立 root → 只有 root 自己；
 * ④ cap 触顶 → truncated=true 且节点数不超 cap；
 * ⑤ 确定性：同输入两次调用逐位一致（BFS 发现序）。
 */
import { describe, expect, it } from 'vitest';
import { EGO_SUBGRAPH_CAP, EGO_SUBGRAPH_HOPS, egoSubgraph } from '../client/src/tabs/graph-canvas-data.js';
import type { GraphFull } from '../client/src/tabs/graph-canvas-data.js';

const node = (id: string): GraphFull['nodes'][number] => ({ id, name: `n-${id}`, type: 'tool' });
const edge = (from: string, to: string): GraphFull['edges'][number] => ({ from, to, relation: '关联', causal: false });
const full = (nodes: string[], edges: Array<[string, string]>): GraphFull => ({
  nodes: nodes.map(node),
  edges: edges.map(([a, b]) => edge(a, b)),
});

describe('egoSubgraph —— 2D 点击聚焦的客户端子集', () => {
  it('链式图 a-b-c-d-e：从 a 出发 3 跳只到 d', () => {
    const g = full(['a', 'b', 'c', 'd', 'e'], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']]);
    const r = egoSubgraph(g, 'a');
    expect(r.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(r.edges.map((e) => `${e.from}-${e.to}`)).toEqual(['a-b', 'b-c', 'c-d']);
    expect(r.truncated).toBe(false);
  });

  it('跳数默认与 3D 同心壳同源（3 跳）', () => {
    expect(EGO_SUBGRAPH_HOPS).toBe(3);
    expect(EGO_SUBGRAPH_CAP).toBe(400);
  });

  it('环不死循环：三角环从任一顶点出发节点不重复', () => {
    const g = full(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
    const r = egoSubgraph(g, 'a');
    expect(new Set(r.nodes.map((n) => n.id)).size).toBe(r.nodes.length);
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('root 不存在 → 空结构不抛；孤立点 → 只剩自己', () => {
    const g = full(['a', 'z'], [['a', 'z']]);
    expect(egoSubgraph(g, 'missing').nodes).toEqual([]);
    const solo = egoSubgraph(full(['a', 'b'], [['a', 'b']]), 'a', 0);
    expect(solo.nodes.map((n) => n.id)).toEqual(['a']);
    expect(solo.edges).toEqual([]);
  });

  it('cap 触顶：截断并标记，节点数不超 cap', () => {
    const star = full(['hub', ...Array.from({ length: 10 }, (_, i) => `s${i}`)], Array.from({ length: 10 }, (_, i) => ['hub', `s${i}`] as [string, string]));
    const r = egoSubgraph(star, 'hub', 3, 5);
    expect(r.nodes.length).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it('全图本身 truncated 时子集继承标记（不能假装没截断）', () => {
    const g = { ...full(['a', 'b'], [['a', 'b']]), truncated: true };
    expect(egoSubgraph(g, 'a').truncated).toBe(true);
  });

  it('确定性：同输入两次调用逐位一致', () => {
    const g = full(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
    expect(egoSubgraph(g, 'a')).toEqual(egoSubgraph(g, 'a'));
  });
});
