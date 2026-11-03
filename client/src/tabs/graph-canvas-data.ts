/**
 * 全图星图的纯数据层(GraphCanvas.tsx 的可测面):度数/半径/伪随机/G6 数据装配。
 *
 * 拆层理由(遵循 conflicts-view.ts 先例):纯函数放 .ts 才能被 vitest(node 环境)直接
 * 导入单测——留在 .tsx 里会连带加载 @antv/g6 与 JSX 运行时,测试环境得先有 DOM。
 *
 * 确定性口径(契约 R6):同节点集 → 同初始坐标、同星点、同 PRNG 播种,
 * 一切散列走 FNV-1a(跨引擎稳定),不碰 Math.random。
 */
import type { GraphPreviewResponse } from '../../../src/contract.js';
import { seedPositions } from './graph-seed-layout.js';

export type GraphFull = NonNullable<GraphPreviewResponse['full']>;

/** 标签显示宽度预算(半角单位):≥20 英文字符可见、≥10 CJK 可见。
 *  旧版写死 8 字——英文实体名(如 “dsh-prime-memory”)整个被…掉,
 *  只有悬浮 tooltip 才能看全称;而用户要求“不悬浮也能读”。 */
export const LABEL_WIDTH_BUDGET = 20;

/**
 * 按显示宽度截断(CJK=2 单位、latin=1 单位)。
 * 超预算时截并加…，不超则原样返回。
 */
export function clipByWidth(name: string, budget: number = LABEL_WIDTH_BUDGET): string {
  let w = 0;
  for (let i = 0; i < name.length; i++) {
    const cw = name.charCodeAt(i) > 0x7f ? 2 : 1;
    if (w + cw > budget) return `${name.slice(0, i)}\u2026`;
    w += cw;
  }
  return name;
}
/** 星点条数(纯装饰层;再多会拖 DOM,再少不像星空)。 */
export const STAR_COUNT = 90;

/** 2D ego 聚焦的默认跳数：与 3D 同心壳同源（EGO_HOPS_MAX），两端“看到多大邻域”必须一致。 */
export const EGO_SUBGRAPH_HOPS = 3;
/** 2D ego 子图节点软上限：与服务端 graph-ego-subgraph 同量级（hub 三跳可爆千级，触顶即截并标记）。 */
export const EGO_SUBGRAPH_CAP = 400;

/**
 * 2D 图的 ego 子集（纯函数）：从 root 沿无向边 BFS ≤hops 跳，只留可达节点与两端都入选的边。
 *
 * 为什么在客户端算而不是再发一次请求：full 块已在手（≤1500 节点），千级邻域扫描
 * 零成本；且与当前画布元素集天然同源——服务端 ego 端点吃全图，可能包含被截断
 * 预算排除的节点，两套判据对不齐会出现“子图里有根却没有邻居”。
 * 确定性：同输入同输出（BFS 发现序 + 邻接表按边入参序），无 Math.random。
 */
export function egoSubgraph(
  full: GraphFull,
  rootId: string,
  hops: number = EGO_SUBGRAPH_HOPS,
  cap: number = EGO_SUBGRAPH_CAP,
): GraphFull {
  const byId = new Map(full.nodes.map((n) => [n.id, n]));
  const root = byId.get(rootId);
  if (!root) return { nodes: [], edges: [], truncated: false };
  // 无向邻接表（重复边保留不影响 BFS）。
  const adj = new Map<string, string[]>();
  for (const e of full.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }
  const depth = new Map<string, number>([[rootId, 0]]);
  const order: string[] = [rootId];
  let cutByCap = false;
  for (let i = 0; i < order.length; i++) {
    const cur = order[i]!;
    const d = depth.get(cur)!;
    if (d >= hops) continue;
    for (const nb of adj.get(cur) ?? []) {
      if (depth.has(nb)) continue;
      if (order.length >= cap) {
        cutByCap = true;
        break;
      }
      depth.set(nb, d + 1);
      order.push(nb);
    }
  }
  const keep = new Set(order);
  return {
    nodes: order.map((id) => byId.get(id)!),
    edges: full.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    truncated: full.truncated || cutByCap,
  };
}
/** 星点半径/透明度钳制区间(视觉下限:再小就看不见;上限:再大就成光斑)。 */
const STAR_R_MIN = 0.12;
const STAR_O_MIN = 0.12;

/** 度数 → 半径 3~7px,sqrt 压缩(hub 线性放大会吞掉整屏)。 */
export function radiusForDegree(deg: number): number {
  const r = 3 + Math.sqrt(Math.max(0, deg)) * 1.6;
  return Math.round(Math.min(7, r) * 10) / 10;
}

/** FNV-1a 32bit(与 graph-seed-layout 同式:跨引擎确定性,不依赖 Math.random)。 */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32:可播种 PRNG,喂给 d3-force 的 randomSource(同图同收敛形)。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** full 边表 → 节点度数(active 边两端各计一次;与服务端 degreeMaps 同判据)。 */
export function degreeMapOf(full: GraphFull): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of full.edges) {
    m.set(e.from, (m.get(e.from) ?? 0) + 1);
    m.set(e.to, (m.get(e.to) ?? 0) + 1);
  }
  return m;
}

/** 节点集指纹(id 拼接):星点与 PRNG 的共同种子源。 */
export function nodeKeyOf(full: GraphFull): string {
  return full.nodes.map((n) => n.id).join('|');
}

/** 喂给 G6 的边条目（用 type 别名而非 interface：G6 EdgeData 带索引签名，只有别名能隐式匹配）。 */
export type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  data: { relation: string; causal: boolean };
  /** 同对节点多边时逐条改曲线并错开偏移（默认 line 会把它们画成完全重合的一条）。 */
  type?: 'quadratic';
  style?: { curveOffset?: number };
};

/**
 * full 块 → G6 数据：节点带 type 扇区初始坐标（同图同开局），边带 causal 标记。
 * 坐标原点 (0,0) = 世界中心，取景由渲染层 autoFit 负责；度数在此一次性算好塞进 data，
 * 渲染层样式回调只读不算（样式函数每帧都跑，别在里面做聚合）。
 *
 * 平行边处理：同一对节点可以有多条关系（服务端按边下发），直线会把它们叠成一条、
 * 两个关系词也重在一个中点——按出现序给第 2 条起交替弯向两侧并逐条加大偏移。
 */
export function toGraphData(full: GraphFull, width: number, height: number): {
  nodes: Array<{ id: string; data: { name: string; type: string; degree: number }; style: { x: number; y: number } }>;
  edges: CanvasEdge[];
} {
  const deg = degreeMapOf(full);
  const seeds = seedPositions(
    full.nodes.map((n) => ({ id: n.id, type: n.type })),
    width,
    height,
  );
  const pos = new Map(seeds.map((s) => [s.id, s]));
  const seen = new Map<string, number>();
  const edges: CanvasEdge[] = full.edges.map((e, i) => {
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const base: CanvasEdge = {
      id: `e${i}-${e.from}-${e.to}`,
      source: e.from,
      target: e.to,
      data: { relation: e.relation, causal: e.causal },
    };
    if (nth === 0) return base; // 首条保持直线
    // 第 2 条起弯开：±30、±60……两侧交替，不互遮
    const mag = 30 * Math.ceil(nth / 2);
    base.type = 'quadratic';
    base.style = { curveOffset: nth % 2 === 1 ? mag : -mag };
    return base;
  });
  return {
    nodes: full.nodes.map((n) => ({
      id: n.id,
      data: { name: n.name, type: n.type, degree: deg.get(n.id) ?? 0 },
      style: { x: pos.get(n.id)?.x ?? 0, y: pos.get(n.id)?.y ?? 0 },
    })),
    edges,
  };
}

export interface Star {
  x: number;
  y: number;
  r: number;
  o: number;
}

/** 星点背层:确定性伪随机点阵(同节点集恒同图),用 viewBox 100×100 百分比坐标。 */
export function starField(seedKey: string): Star[] {
  const rnd = seededRandom(hash32(seedKey));
  const out: Star[] = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    out.push({
      x: Math.round(rnd() * 1000) / 10,
      y: Math.round(rnd() * 1000) / 10,
      r: Math.round((STAR_R_MIN + rnd() * 0.28) * 100) / 100,
      o: Math.round((STAR_O_MIN + rnd() * 0.3) * 100) / 100,
    });
  }
  return out;
}
