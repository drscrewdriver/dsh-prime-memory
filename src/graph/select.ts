/**
 * 记忆库视图的元素选择(读路径纯函数):超上限时按**三层配额**选,而不是单一排序。
 *
 * 为什么不按 degree 从高到低截断:图谱里的老 hub(如"用户本人"、长期项目)度数恒高,
 * 单一排序会把全部名额吃在它们和它们的一度邻居上,**昨天刚沉淀的新记忆永远进不了图**
 * ——而"我刚记的东西在哪"恰恰是查询入口最先被问的问题。故拆三层:
 *   骨架层(60%)  degree + causal×权重  —— 保证结构主干与因果链在画面里;
 *   新鲜层(20%)  updatedAt 倒序,含 degree=0 —— 保证新记忆一定看得见;
 *   长尾层(余量) 剩余按 degree 补 —— 防止只剩几个毛球,保留图的连通观感。
 *
 * 未超限时**全选**,且输出顺序与入参一致(即 `loadGraph` 行序)——与既有
 * `buildFullView` 的截断语义逐位对齐,老消费方不受影响。
 */
import { GRAPH_PREVIEW_CAUSAL_WEIGHT, GRAPH_PREVIEW_FULL_EDGES, GRAPH_PREVIEW_FULL_NODES } from './types.js';
import { GRAPH_CAUSAL_RELATIONS, isGraphNodeVisible } from './constraints.js';
import { degreeMaps, type FullViewEdge, type FullViewNode } from './preview.js';
import type { GraphEdge, GraphNode } from './types.js';

const CAUSAL_SET: ReadonlySet<string> = new Set<string>(GRAPH_CAUSAL_RELATIONS);

/** 骨架层占比(度量为 nodeCap)。 */
export const EXPLORER_QUOTA_SKELETON = 0.6;
/** 新鲜层占比(度量为 nodeCap)。 */
export const EXPLORER_QUOTA_FRESH = 0.2;

export interface ExplorerSelectCaps {
  nodeCap?: number;
  edgeCap?: number;
}

export interface ExplorerSelection {
  nodes: FullViewNode[];
  edges: FullViewEdge[];
  /** 任一维触顶(渲染侧必须据此提示"仅画部分",不得静默少画)。 */
  truncated: boolean;
  /** 各层实际入选数(合计 === nodes.length;诊断与单测断言用)。 */
  counts: { skeleton: number; fresh: number; tail: number };
  /** 截断前的可见节点总数(页面显示 "M/N 节点")。 */
  totalVisible: number;
  totalEdges: number;
}

/** 与预览/关联同源的可见性判据(单源在 constraints)。 */
const visible = isGraphNodeVisible;

/**
 * 主函数。纯计算:不查库、不落库。`nodes`/`edges` 由调用方一次性装载
 * (GraphStore.loadGraph),与 buildFullView 共享同一份入参。
 */
export function selectExplorerNodes(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  caps: ExplorerSelectCaps = {},
): ExplorerSelection {
  const nodeCap = Math.max(1, Math.floor(caps.nodeCap ?? GRAPH_PREVIEW_FULL_NODES));
  const edgeCap = Math.max(1, Math.floor(caps.edgeCap ?? GRAPH_PREVIEW_FULL_EDGES));
  const dm = degreeMaps(nodes, edges);
  const visNodes = nodes.filter(visible);
  const scoreOf = (n: GraphNode): number =>
    (dm.degree.get(n.id) ?? 0) + (dm.causal.get(n.id) ?? 0) * GRAPH_PREVIEW_CAUSAL_WEIGHT;

  // ── 节点选择 ──────────────────────────────────────────────
  const chosen = new Set<string>();
  let skeleton = 0;
  let fresh = 0;
  let tail = 0;
  let nodesTruncated = false;

  if (visNodes.length <= nodeCap) {
    for (const n of visNodes) chosen.add(n.id);
  } else {
    nodesTruncated = true;
    const byScore = (a: GraphNode, b: GraphNode): number => {
      const s = scoreOf(b) - scoreOf(a);
      if (s !== 0) return s;
      return a.id < b.id ? -1 : 1;
    };
    const byFresh = (a: GraphNode, b: GraphNode): number => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    };

    // 每层至少留 1 个名额:cap 很小时 floor(cap×0.2)=0 会让新鲜层直接消失,
    // 于是“刚记的东西看不见”这个要防的问题反而在最需要它的窄预算下发生。
    const skeletonQuota = Math.max(1, Math.floor(nodeCap * EXPLORER_QUOTA_SKELETON));
    const freshQuota = Math.max(1, Math.floor(nodeCap * EXPLORER_QUOTA_FRESH));

    // 1) 骨架层:score 降序(孤立点 score=0 自然沉底,不会白占主干名额)
    for (const n of [...visNodes].sort(byScore)) {
      if (skeleton >= skeletonQuota) break;
      if (chosen.has(n.id)) continue;
      chosen.add(n.id);
      skeleton += 1;
    }
    // 2) 新鲜层:updatedAt 倒序,含 degree=0 的新点
    for (const n of [...visNodes].sort(byFresh)) {
      if (fresh >= freshQuota) break;
      if (chosen.has(n.id)) continue;
      chosen.add(n.id);
      fresh += 1;
    }
    // 3) 长尾层:剩余名额按 score 补满
    for (const n of [...visNodes].sort(byScore)) {
      if (chosen.size >= nodeCap) break;
      if (chosen.has(n.id)) continue;
      chosen.add(n.id);
      tail += 1;
    }
  }

  // 输出保持入参顺序(loadGraph 行序),与 buildFullView 的截断语义同形
  const outNodes: FullViewNode[] = visNodes
    .filter((n) => chosen.has(n.id))
    .map((n) => ({ id: n.id, name: n.name, type: n.type }));

  // ── 边选择:两端入选 → 因果优先 → 两端 score 和降序 → id 升序兜底 ──
  const candidates = edges.filter(
    (e) => e.status === 'active' && chosen.has(e.fromNodeId) && chosen.has(e.toNodeId),
  );
  const totalEdges = candidates.length;
  const ranked = [...candidates].sort((a, b) => {
    const ca = CAUSAL_SET.has(a.relation) ? 1 : 0;
    const cb = CAUSAL_SET.has(b.relation) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    const sa =
      (dm.degree.get(a.fromNodeId) ?? 0) + (dm.degree.get(a.toNodeId) ?? 0)
      + ((dm.causal.get(a.fromNodeId) ?? 0) + (dm.causal.get(a.toNodeId) ?? 0)) * GRAPH_PREVIEW_CAUSAL_WEIGHT;
    const sb =
      (dm.degree.get(b.fromNodeId) ?? 0) + (dm.degree.get(b.toNodeId) ?? 0)
      + ((dm.causal.get(b.fromNodeId) ?? 0) + (dm.causal.get(b.toNodeId) ?? 0)) * GRAPH_PREVIEW_CAUSAL_WEIGHT;
    if (sa !== sb) return sb - sa;
    return a.id < b.id ? -1 : 1;
  });
  const edgesTruncated = ranked.length > edgeCap;
  const outEdges: FullViewEdge[] = ranked.slice(0, edgeCap).map((e) => ({
    from: e.fromNodeId,
    to: e.toNodeId,
    relation: e.relation,
    causal: CAUSAL_SET.has(e.relation),
  }));

  return {
    nodes: outNodes,
    edges: outEdges,
    truncated: nodesTruncated || edgesTruncated,
    counts: { skeleton, fresh, tail },
    totalVisible: visNodes.length,
    totalEdges,
  };
}
