/**
 * 记忆库视图存储缝(GraphStore.buildExplorer)验收面。
 *
 * 钉住的性质(spec S2 / 决策 D5):
 * ① db 未就绪 → 三块(preview / view / links)全空结构不抛——展示面永不拖垮端点;
 * ② **一次 loadGraph 供三算**:种子榜、元素选择、关联反查必须共用同一次装载,
 *    否则会出现"画布上有这个节点、关联清单里查不到"的对不齐,而且是三倍的全表读;
 * ③ 三块同源:同一份图下 view 的节点集 = 可见节点集,links 的实体/邻居都取自它;
 * ④ links 反查按 sourceRecordIds 命中,邻居排序因果优先。
 */
import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { GraphStore } from '../src/store/graph-store.js';

const NODE_SQL = `INSERT INTO graph_nodes (node_id, name, type, aliases_json, tags_json, current_state, facts_json,
   status, confidence, source_record_ids_json, families_json, created_time, updated_time)
  VALUES (?, ?, ?, '[]', '[]', '', '[]', ?, 0.8, ?, '["work"]', '', '')`;
const EDGE_SQL = `INSERT INTO graph_edges (edge_id, from_node_id, to_node_id, relation, status, valid_from, valid_to,
   confidence, source_record_ids_json, created_time, updated_time)
  VALUES (?, ?, ?, ?, 'active', '', '', 0.8, '[]', '', '')`;

/** n1(r1) --导致--> n2(r2) --依赖--> n3(r3)；外加一个不可见的 n4 与一条 superseded 边。 */
function storeWithGraph(): { db: DatabaseSync; g: GraphStore } {
  const db = new DatabaseSync(':memory:');
  const g = new GraphStore();
  g.init(db, undefined, { dimensions: 0 });
  const ins = db.prepare(NODE_SQL);
  ins.run('n1', '甲项目', 'project', 'active', '["r1"]');
  ins.run('n2', '乙工具', 'tool', 'active', '["r2"]');
  ins.run('n3', '丙地点', 'place', 'active', '["r3"]');
  ins.run('n4', '丁历史', 'person', 'superseded', '["r4"]');
  db.prepare(EDGE_SQL).run('e1', 'n1', 'n2', '导致');
  db.prepare(EDGE_SQL).run('e2', 'n2', 'n3', '依赖');
  db.prepare(EDGE_SQL).run('e3', 'n1', 'n4', '使用');
  return { db, g };
}

describe('GraphStore.buildExplorer —— 降级缝', () => {
  it('db 未 init → 三块全空结构,不抛', () => {
    const g = new GraphStore();
    const r = g.buildExplorer('r1');
    expect(r.preview).toEqual({
      seeds: [],
      stats: { nodes: 0, edges: 0, causalEdges: 0, pendingJobs: 0, jobsTotal: 0 },
    });
    expect(r.view.nodes).toEqual([]);
    expect(r.view.edges).toEqual([]);
    expect(r.view.counts).toEqual({ skeleton: 0, fresh: 0, tail: 0 });
    expect(r.view.truncated).toBe(false);
    expect(r.links).toEqual({ entities: [], neighbors: [], neighborRecordIds: [], truncated: false });
  });

  it('recordId 缺省时 links 为空但 view/preview 照常(入口首屏不选记录也能出图)', () => {
    const { db, g } = storeWithGraph();
    try {
      const r = g.buildExplorer();
      expect(r.links.entities).toEqual([]);
      expect(r.view.nodes.length).toBeGreaterThan(0);
      expect(r.preview.stats.nodes).toBe(3); // n4 不可见不计
    } finally {
      db.close();
    }
  });
});

describe('GraphStore.buildExplorer —— 一次装载供三算', () => {
  it('loadGraph 只被调用一次(不是种子榜/选择/反查各读一遍三表)', () => {
    const { db, g } = storeWithGraph();
    try {
      const spy = vi.spyOn(g as unknown as { loadGraph: () => unknown }, 'loadGraph');
      g.buildExplorer('r1');
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    } finally {
      db.close();
    }
  });

  it('三块同源:view 的节点集与 preview.stats 的可见节点集一致,不可见节点两边都不出现', () => {
    const { db, g } = storeWithGraph();
    try {
      const r = g.buildExplorer('r1');
      const ids = r.view.nodes.map((n) => n.id).sort();
      expect(ids).toEqual(['n1', 'n2', 'n3']);
      expect(r.preview.stats.nodes).toBe(ids.length);
      expect(r.view.edges.map((e) => `${e.from}-${e.to}`)).toEqual(['n1-n2', 'n2-n3']); // e3 端点不可见 → 剔除
      expect(r.links.neighbors.map((n) => n.id)).not.toContain('n4');
    } finally {
      db.close();
    }
  });
});

describe('GraphStore.buildExplorer —— 关联反查', () => {
  it('recordId=r1 反查到实体 n1,邻居 n2 排在 n3 之前(因果优先)', () => {
    const { db, g } = storeWithGraph();
    try {
      const r = g.buildExplorer('r1');
      expect(r.links.entities.map((e) => e.id)).toEqual(['n1']);
      expect(r.links.entities[0]).toMatchObject({ degree: 1, causalDegree: 1 });
      expect(r.links.neighbors[0]).toMatchObject({ id: 'n2', relation: '导致', causal: true, viaEntityId: 'n1', hop: 1 });
      // 回落记录:邻居来源 r2 + 一跳可达的 n3 来源 r3(hops 缺省 1 时 n3 不进 links)
      expect(r.links.neighborRecordIds).toContain('r2');
      expect(r.links.neighborRecordIds).not.toContain('r1');
    } finally {
      db.close();
    }
  });

  it('hops=2 时第二跳实体(r3)也进回落集', () => {
    const { db, g } = storeWithGraph();
    try {
      const r = g.buildExplorer('r1', { hops: 2 });
      expect(r.links.neighbors.map((n) => n.id).sort()).toEqual(['n2', 'n3']);
      expect(r.links.neighborRecordIds.sort()).toEqual(['r2', 'r3']);
    } finally {
      db.close();
    }
  });

  it('悬挂 recordId(未被投影) → links 全空,view/preview 照常出图', () => {
    const { db, g } = storeWithGraph();
    try {
      const r = g.buildExplorer('rec-never-projected');
      expect(r.links.entities).toEqual([]);
      expect(r.links.neighbors).toEqual([]);
      expect(r.view.nodes.length).toBe(3);
    } finally {
      db.close();
    }
  });
});
