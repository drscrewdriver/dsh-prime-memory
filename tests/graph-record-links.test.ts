/**
 * 记忆库关联跳转(buildRecordLinks)验收面。
 *
 * 钉住的性质(spec S2):
 * ① 反查走 sourceRecordIds 内存匹配:起点记录命中零实体 → 全空结构不抛(图谱未启用/未投影都是正常态);
 * ② 判据与预览同源:superseded/archived 节点既不作实体、也不作邻居、也不计度;
 * ③ 平行关系不合并(同对节点两条关系 = 两行,合并就丢关系);
 * ④ 排序:因果优先 → hop 升 → degree 降 → updatedAt 新 → id 升 → viaEntityId 升(确定性兜底);
 * ⑤ 回落记录去重、排除起点自身、按节点排名序、≤limit;
 * ⑥ hops 钳制 1..2、limit 钳制 1..200;环状图不死循环;
 * ⑦ 同输入两次调用逐位一致。
 */
import { describe, expect, it } from 'vitest';
import {
  buildRecordLinks,
  RECORD_LINKS_HOPS_MAX,
  RECORD_LINKS_LIMIT_DEFAULT,
  RECORD_LINKS_LIMIT_MAX,
} from '../src/graph/record-links.js';
import type { GraphEdge, GraphNode } from '../src/graph/types.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';

function node(id: string, opts: {
  status?: GraphNode['status'];
  updatedAt?: string;
  sources?: string[];
  type?: GraphNode['type'];
} = {}): GraphNode {
  return {
    id,
    name: `n-${id}`,
    type: opts.type ?? 'tool',
    aliases: [],
    tags: [],
    currentState: '',
    facts: [],
    status: opts.status ?? 'active',
    confidence: 1,
    sourceRecordIds: opts.sources ?? [`${id}-rec`],
    families: [],
    createdAt: T0,
    updatedAt: opts.updatedAt ?? T0,
  };
}

function edge(from: string, to: string, relation = '依赖', status: GraphEdge['status'] = 'active', id?: string): GraphEdge {
  return {
    id: id ?? `e-${from}-${to}-${relation}`,
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

describe('buildRecordLinks —— 起点反查', () => {
  it('recordId 空白 → 全空结构,不抛', () => {
    const r = buildRecordLinks([node('a')], [], '   ');
    expect(r).toEqual({ entities: [], neighbors: [], neighborRecordIds: [], truncated: false });
  });

  it('记录未被投影进图(命中零实体) → 全空结构,不抛', () => {
    const r = buildRecordLinks([node('a'), node('b')], [edge('a', 'b')], 'rec-not-projected');
    expect(r.entities).toEqual([]);
    expect(r.neighbors).toEqual([]);
    expect(r.neighborRecordIds).toEqual([]);
  });

  it('起点实体按 degree 降序;不可见节点不作实体', () => {
    const nodes = [
      node('solo', { sources: ['R'] }),
      node('hub', { sources: ['R'] }),
      node('h1'), node('h2'), node('h3'),
      node('dead', { sources: ['R'], status: 'superseded' }),
    ];
    const edges = [edge('hub', 'h1'), edge('hub', 'h2'), edge('hub', 'h3'), edge('dead', 'h1')];
    const r = buildRecordLinks(nodes, edges, 'R');
    expect(r.entities.map((e) => e.id)).toEqual(['hub', 'solo']); // dead 不可见、solo 度 0 排后
    expect(r.entities[0]).toMatchObject({ degree: 3, causalDegree: 0 });
  });

  it('实体自身来源里的其它记录也进回落集(同实体的相邻记忆),且排除起点自身', () => {
    const nodes = [node('a', { sources: ['R', 'R2'] }), node('b', { sources: ['R3'] })];
    const r = buildRecordLinks(nodes, [edge('a', 'b')], 'R');
    expect(r.neighborRecordIds.sort()).toEqual(['R2', 'R3']);
    expect(r.neighborRecordIds).not.toContain('R');
  });

  it('实体与邻居各自随带来源记录预览（≤5、保最新、排除起点）——第三层跳转的落点', () => {
    // leaf 不带 R0：带了它就变成“起点实体”而不是邻居（上一版就踩了这个数据错）。
    const nodes = [
      node('hub', { sources: ['R0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'] }),
      node('leaf', { sources: ['c1', 'b1', 'b2'] }),
    ];
    const r = buildRecordLinks(nodes, [edge('hub', 'leaf')], 'R0');
    expect(r.entities[0]!.recordIds).toEqual(['a3', 'a4', 'a5', 'a6', 'a7']);
    expect(r.neighbors[0]!.recordIds).toEqual(['c1', 'b1', 'b2']);
  });
});

describe('buildRecordLinks —— 邻居展开与排序', () => {
  it('平行关系各占一行(同对节点两条关系不合并)', () => {
    const nodes = [node('a', { sources: ['R'] }), node('b')];
    const edges = [edge('a', 'b', '依赖'), edge('a', 'b', '导致')];
    const r = buildRecordLinks(nodes, edges, 'R');
    expect(r.neighbors).toHaveLength(2);
    expect(r.neighbors.map((n) => n.relation)).toEqual(['导致', '依赖']); // 因果优先
    expect(r.neighbors.every((n) => n.viaEntityId === 'a')).toBe(true);
  });

  it('排序:因果 → hop 升 → degree 降 → updatedAt 新 → id 升', () => {
    const nodes = [
      node('a', { sources: ['R'] }),
      node('c1'), node('c2'), node('c3'), node('c4'), node('c5'),
      node('far', { updatedAt: T1 }),
    ];
    const edges = [
      edge('a', 'c1', '导致'),
      edge('a', 'c2', '依赖'), edge('c2', 'far'),
      edge('a', 'c3', '依赖'), edge('c3', 'far'),
    ];
    const r = buildRecordLinks(nodes, edges, 'R', { hops: 1 });
    expect(r.neighbors[0]).toMatchObject({ id: 'c1', causal: true, hop: 1 });
    expect(r.neighbors.every((n) => n.hop === 1)).toBe(true);
  });

  it('hops=2 扩到第二跳并标 hop=2;hops 超界钳到上限', () => {
    const nodes = [node('a', { sources: ['R'] }), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const r1 = buildRecordLinks(nodes, edges, 'R', { hops: 1 });
    expect(r1.neighbors.map((n) => n.id)).toEqual(['b']);
    const r2 = buildRecordLinks(nodes, edges, 'R', { hops: 2 });
    expect(r2.neighbors.map((n) => n.id).sort()).toEqual(['b', 'c']);
    expect(r2.neighbors.find((n) => n.id === 'c')).toMatchObject({ hop: 2, viaEntityId: 'b' });
    // 钳制:hops=9 等价于上限值
    const rMax = buildRecordLinks(nodes, edges, 'R', { hops: 9 });
    expect(rMax.neighbors).toEqual(buildRecordLinks(nodes, edges, 'R', { hops: RECORD_LINKS_HOPS_MAX }).neighbors);
  });

  it('环状图不死循环、不重复展开(起点实体不重新入列)', () => {
    const nodes = [node('a', { sources: ['R'] }), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    const r = buildRecordLinks(nodes, edges, 'R', { hops: 2 });
    expect(r.neighbors.filter((n) => n.id === 'a')).toEqual([]);
    expect(r.neighbors.map((n) => n.id).sort()).toEqual(['b', 'b', 'c', 'c']); // 平行行可多,但不含起点自身
  });

  it('非 active 边不展开;指向不可见节点的边不出现', () => {
    const nodes = [node('a', { sources: ['R'] }), node('b'), node('gone', { status: 'archived' })];
    const edges = [edge('a', 'b', '依赖', 'superseded'), edge('a', 'gone')];
    const r = buildRecordLinks(nodes, edges, 'R');
    expect(r.neighbors).toEqual([]);
  });
});

describe('buildRecordLinks —— 名额与确定性', () => {
  it('邻居触顶 → truncated=true 且长度等于 limit', () => {
    const nodes = [node('hub', { sources: ['R'] }), ...Array.from({ length: 5 }, (_, i) => node(`n${i}`))];
    const edges = nodes.slice(1).map((n) => edge('hub', n.id));
    const r = buildRecordLinks(nodes, edges, 'R', { limit: 3 });
    expect(r.neighbors).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(r.neighborRecordIds.length).toBeLessThanOrEqual(3);
  });

  it('limit 缺省与钳制:0/负数 → 1;超大 → 上界', () => {
    const nodes = [node('a', { sources: ['R'] }), node('b')];
    const edges = [edge('a', 'b')];
    expect(buildRecordLinks(nodes, edges, 'R', { limit: 0 }).neighbors).toHaveLength(1);
    const wide = [node('hub', { sources: ['R'] }), ...Array.from({ length: 250 }, (_, i) => node(`m${i}`))];
    const wideEdges = wide.slice(1).map((n) => edge('hub', n.id));
    expect(buildRecordLinks(wide, wideEdges, 'R', { limit: 99999 }).neighbors).toHaveLength(RECORD_LINKS_LIMIT_MAX);
    expect(buildRecordLinks(wide, wideEdges, 'R').neighbors).toHaveLength(RECORD_LINKS_LIMIT_DEFAULT);
  });

  it('同输入两次调用逐位一致(确定性)', () => {
    const nodes = [node('a', { sources: ['R'] }), node('b'), node('c'), node('d')];
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];
    expect(buildRecordLinks(nodes, edges, 'R', { hops: 2 })).toEqual(buildRecordLinks(nodes, edges, 'R', { hops: 2 }));
  });
});
