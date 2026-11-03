/**
 * 3D 记忆海的纯函数层：布局 / 透视投影 / 深度排序 / 标签 LOD / 亮度合成 / 拾取。
 *
 * 拆层理由（遵循 graph-canvas-data.ts 先例）：纯函数放 .ts 才能被 vitest(node 环境)
 * 直接导入单测——留在 .tsx 里会连带加载 @antv/g6 与 JSX 运行时，测试环境得先有 DOM。
 * 渲染组件 `Scene3D.tsx` 只做「取这些函数的输出 + 逐帧画」，不调任何业务判断。
 *
 * 数学与观感先在一次性基准页里实测过（1500 点 / 3000 边、辉光+边+标签+漂移全开
 * 跑到 fps 60，纯计算单帧 0.534ms）才搬进来。**不用 WebGL**：3D 是投影数学，
 * 不是渲染 API；千级点 Canvas 2D 足够，且 client bundle 已被 G6 的 UMD 抬到 2.5MB。
 *
 * 三条不变式：
 *   1) 确定性：一切散列走 FNV-1a（复用 hash32），不碰 Math.random——同一份图两次
 *      打开位置逐位一致。用户对「这张图长什么样」的心智必须能积累；
 *   2) 与 2D 同源：本层只吃已选好的元素集合（服务端 selectExplorerNodes 的结果），
 *      自己不做任何「谁该显示」的判断，所以 2D/3D 切换时元素集合必然一致；
 *   3) 通道分离：亮度只表达老化，半径只表达度数，颜色只表达类型——不在这里
 *      把两个语义挤进同一个数（基准页上一版就是这么把老化差异吞掉的，见 brightnessFor）。
 */
import { hash32 } from '../tabs/graph-canvas-data.js';

// ── 相机与交互常量（渲染层与单测共用同一组数字） ──────────────────
/** 透视焦距：越大越接近平视，越小纵深越夸张。 */
export const FOCAL = 1100;
/** 初始相机。yaw/pitch 取"斜上方俯视"，球状团簇在这个角度下层次最清楚。 */
export const CAM_DEFAULT = { yaw: 0.45, pitch: -0.3, dist: 1200, panX: 0, panY: 0 };
export const DIST_MIN = 380;
export const DIST_MAX = 3200;
/** 俯仰角限位：超过 ±1.35rad 后屏幕上下方向与 z 轴几乎重合，旋转会失去意义。 */
export const PITCH_LIMIT = 1.35;
/** 滚轮单步缩放系数（乘法而非加法：近距离时同样像素位移要更小的距离变化）。 */
export const ZOOM_STEP = 1.08;
/** 拾取阈值（屏幕像素）：比点半径大，保证小点也点得着。 */
export const PICK_PX = 16;
/** ego 壳层跳数上限：3 跳在百级图上已是主干全貌，再深就是噪声与满屏。 */
export const EGO_HOPS_MAX = 3;
/** ego 壳层间距（世界单位）：每跳一层球壳。 */
export const SHELL_GAP = 300;
/** cluster ↔ ego 位置过渡时长。3D 里瞬时跳变会让人彻底丢掉空间定向。 */
export const TRANSITION_MS = 520;

// ── 标签 LOD 常量 ────────────────────────────────────────────────
/** 标签占位网格（屏幕像素）：同格内只留 rank 高者，避免字压字。 */
export const LABEL_CELL_W = 104;
export const LABEL_CELL_H = 14;
/** 透视系数低于此值（即太远）就不标——留给近景。 */
export const LABEL_MIN_F = 0.55;
/** 预算 = LABEL_BUDGET_BASE × (初始距离 / 当前距离)，再钳进 [MIN, MAX]。 */
export const LABEL_BUDGET_BASE = 72;
export const LABEL_BUDGET_MIN = 24;
export const LABEL_BUDGET_MAX = 280;

// ── 亮度通道常量 ─────────────────────────────────────────────────
/** 深度明暗的上限：刻意留出一段，专供老化通道使用（见 brightnessFor 的注释）。 */
export const DEPTH_LIGHT_CAP = 0.85;
/** 全图最低 alpha：低于它就等于看不见，“淡出”不该变成“消失”。 */
export const ALPHA_FLOOR = 0.06;
/** 亮度拉伸的老化下限：与数据侧 GRAPH_AGING_CULL_FLOOR 同值（aging 低于此不渲染，此处只拉 [0.2,1] 段）。 */
export const AGING_STRETCH_MIN = 0.2;

/** 由 id 派生的稳定 [0,1) 随机数（不是序列 PRNG：任何时刻重算都得同值）。 */
function rand01(salt: string): number {
  return (hash32(salt) % 100000) / 100000;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 布局只需要 id 与 type；不要求调用方传名字（省带宽，标签文本在渲染层拿）。 */
export interface LayoutNode {
  id: string;
  type: string;
}

/** 投影后的屏幕项。`f` 是透视系数（近大远小的那个"倍率"），`depth` 用于排序。 */
export interface Projected {
  id: string;
  x: number;
  y: number;
  f: number;
  depth: number;
}

/**
 * 簇顺序：先按固定表（与 2D 的 TYPE_COLORS 同一族语义），未知类型按 hash 升序追加。
 * 单列出来是为了**与入参顺序无关**——同一节点集换个输入次序也必须同形（契约 R6）。
 */
export function clusterOrder(types: Iterable<string>): string[] {
  const seen = new Set<string>(types);
  const known = ['person', 'project', 'organization', 'tool', 'place'].filter((t) => seen.has(t));
  const rest = [...seen].filter((t) => !known.includes(t)).sort((a, b) => hash32(a) - hash32(b));
  return [...known, ...rest];
}

/**
 * cluster 布局：每个类型簇在球面取一个方向（斐波那契球面，簇间尽量等距），
 * 簇内点在自己那层薄壳里散开。**没有全局中心**——这正是 prime-memory 要的形态。
 */
export function buildClusterLayout(nodes: readonly LayoutNode[]): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  const types = clusterOrder(nodes.map((n) => n.type));
  const centers = new Map<string, Vec3>();
  const total = Math.max(1, types.length);
  types.forEach((type, i) => {
    // 斐波那契球面：y 线性铺开，phi 用黄金角递推；再叠一层按簇名派生的抖动，
    // 避免两个簇恰好落在同一方向上糊成一坨。
    const y = total === 1 ? 0 : 1 - (i / (total - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * Math.PI * (3 - Math.sqrt(5)) + rand01(`c:${type}`) * 0.6;
    const radius = 230 + rand01(`r:${type}`) * 190;
    centers.set(type, {
      x: Math.cos(phi) * ring * radius,
      y: y * radius * 0.82, // 纵向压扁：正球在俯视时上下层会互相挡住
      z: Math.sin(phi) * ring * radius,
    });
  });
  for (const n of nodes) {
    const c = centers.get(n.type) ?? { x: 0, y: 0, z: 0 };
    const a = rand01(`a:${n.id}`) * Math.PI * 2;
    const b = Math.acos(2 * rand01(`b:${n.id}`) - 1);
    // pow(…,0.65) 把分布往壳外推：纯均匀会让中心一坨密到看不出结构。
    const rr = 16 + Math.pow(rand01(`s:${n.id}`), 0.65) * 120;
    out.set(n.id, {
      x: c.x + Math.sin(b) * Math.cos(a) * rr,
      y: c.y + Math.cos(b) * rr * 0.72,
      z: c.z + Math.sin(b) * Math.sin(a) * rr,
    });
  }
  return out;
}

/**
 * ego 布局：焦点在球心，**BFS 跳数决定壳层半径**（第 k 跳在 r = k×SHELL_GAP 的壳上），
 * 同壳内按 id 派生方向均匀散布。
 *
 * 为什么不用力导重排：3D 力导要自写 Barnes-Hut，而且收敛过程不可控——每次点进去
 * 形状不同，用户无法积累"谁在哪"的记忆。同心壳把「第几跳」直接读成「第几层壳」，
 * 语义与几何一一对应，且确定性。
 *
 * 只返回可达节点：调用方据此裁剪绘制集合（跳数外的点这一帧不画，而不是画在远处）。
 */
export function buildEgoLayout(
  adj: ReadonlyMap<string, readonly string[]>,
  focusId: string,
  hops: number,
): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  const depth = Math.min(Math.max(Math.floor(hops), 1), EGO_HOPS_MAX);
  const hopOf = new Map<string, number>([[focusId, 0]]);
  let frontier: readonly string[] = [focusId];
  const byHop = new Map<number, string[]>();
  byHop.set(0, [focusId]);
  for (let h = 1; h <= depth; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of adj.get(id) ?? []) {
        if (hopOf.has(other)) continue;
        hopOf.set(other, h);
        next.push(other);
      }
    }
    if (next.length > 0) byHop.set(h, next);
    frontier = next;
    if (next.length === 0) break;
  }
  for (const [h, ids] of byHop) {
    const R = h * SHELL_GAP;
    const total = ids.length;
    ids.forEach((id, i) => {
      if (h === 0) {
        out.set(id, { x: 0, y: 0, z: 0 });
        return;
      }
      const y = total === 1 ? 0 : 1 - (i / (total - 1)) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * Math.PI * (3 - Math.sqrt(5)) + rand01(`e:${id}`) * 0.7;
      const jitter = 1 + (rand01(`j:${id}`) - 0.5) * 0.18;
      out.set(id, {
        x: Math.cos(phi) * ring * R * jitter,
        y: y * R * 0.85 * jitter,
        z: Math.sin(phi) * ring * R * jitter,
      });
    });
  }
  return out;
}

/**
 * 透视投影：绕 Y 转 yaw → 绕 X 转 pitch → 透视除法。
 * 返回顺序即**远→近**，渲染层照它画就有正确遮挡（近点压住远点）。
 *
 * @param ids 只投影这些 id（ego 模式裁剪用）；缺省投影 layout 全集
 * @param t   毫秒时刻，供缓慢漂移用（"活着"但不抖：周期 2.7~4.1s、幅度 ≤7 世界单位）
 * @param drift 关掉漂移（ego 模式下壳层半径本身就是语义，不该抖）
 */
export function projectAll(
  layout: ReadonlyMap<string, Vec3>,
  cam: { yaw: number; pitch: number; dist: number; panX: number; panY: number },
  viewport: { w: number; h: number },
  ids?: readonly string[],
  t = 0,
  drift = true,
): Projected[] {
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const out: Projected[] = [];
  const walk = (id: string) => {
    const p = layout.get(id);
    if (!p) return;
    const d = drift ? 1 : 0;
    const phase = rand01(`p:${id}`) * Math.PI * 2;
    const wx = p.x + Math.sin(t / 3200 + phase) * 7 * d + cam.panX;
    const wy = p.y + Math.cos(t / 4100 + phase) * 5 * d + cam.panY;
    const wz = p.z + Math.sin(t / 2700 + phase * 1.3) * 7 * d;
    const x1 = wx * cy - wz * sy;
    const z1 = wx * sy + wz * cy;
    const y1 = wy * cp - z1 * sp;
    const z2 = wy * sp + z1 * cp;
    const depth = cam.dist + z2;
    // max(140,…) 防除零/负深度：相机钻进点堆里时不能炸出天大的 f。
    const f = FOCAL / Math.max(140, depth);
    out.push({ id, x: viewport.w / 2 + x1 * f, y: viewport.h / 2 + y1 * f, f, depth });
  };
  if (ids) for (const id of ids) walk(id);
  else for (const id of layout.keys()) walk(id);
  out.sort((a, b) => b.depth - a.depth);
  return out;
}

/**
 * 亮度合成：**深度与老化两个通道各自封顶再相乘**。
 *
 * 基准页上一版写成 `min(1, (0.22 + f×1.05) × aging)`，拉近后 f≈1.4 → 括号里就 1.7，
 * 而 aging 的定义域只有 0.5~1，于是只要 aging>0.59 结果就饱和成 1——老化差异被深度
 * 通道整块吞掉，肉眼看就是"看不出谁老谁新"。所以这里让深度通道**最亮只到 0.85**，
 * 把 0.85~1.0 之上那段留给老化，保证任何 f 下 aging 都还有可见区间。
 *
 * @param agingWeight 服务端 UiRecord.agingWeight（0.5~1）；null/undefined = 衰减关闭 → 按 1 处理
 * @param agingOn 关掉时老化项恒 1（全亮），用于肉眼对比
 */
export function brightnessFor(f: number, agingWeight: number | null | undefined, agingOn = true): number {
  const depthLight = Math.min(DEPTH_LIGHT_CAP, 0.2 + f * 0.55);
  // 老化项把 [AGING_STRETCH_MIN,1] 线性拉到 [0.12,1]：0.2 足够暗、1 全亮，中间分得出梯度。
  // （数据下限已降到 0.2；不拉伸时 0.2~1 乘深度后全挤在高段，肉眼分不开。）
  const rawAging = agingWeight == null ? 1 : agingWeight;
  const stretched = AGING_STRETCH_MIN >= 1
    ? 1
    : 0.12 + 0.88 * Math.max(0, Math.min(1, (rawAging - AGING_STRETCH_MIN) / (1 - AGING_STRETCH_MIN)));
  const agingLight = agingOn ? stretched : 1;
  return Math.max(ALPHA_FLOOR, depthLight * agingLight);
}

/** 点半径（屏幕像素）：度数决定粗细，焦点/悬停/选中放大 1.9 倍。 */
export function radiusFor(base: number, f: number, emphasized: boolean): number {
  return Math.max(0.8, base * (emphasized ? 1.9 : 1) * f * 1.75);
}

/** 标签预算：拉得越近标得越多（同 2D 的观感约定），并钳进 [24, 280]。 */
export function labelBudget(camDist: number): number {
  const raw = Math.round(LABEL_BUDGET_BASE * (CAM_DEFAULT.dist / Math.max(1, camDist)));
  return Math.min(LABEL_BUDGET_MAX, Math.max(LABEL_BUDGET_MIN, raw));
}

export interface LabelCandidate {
  id: string;
  /** 屏幕坐标（已投影）。 */
  x: number;
  y: number;
  /** 透视系数：低于 LABEL_MIN_F 的远点不标。 */
  f: number;
  /** 排序分：焦点/悬停/选中加权 + 老化或度数权重，由调用方算（本层不认识业务）。 */
  rank: number;
}

/**
 * 标签挑选：按 rank 降序，**屏幕网格占位去重**，超预算即止。
 *
 * @param widthOf 文本宽度测量（渲染层传 ctx.measureText 包装；单测传纯计算函数）
 * @param viewportW 视口宽：越界的标签直接不占名额
 */
export function pickLabels(
  candidates: readonly LabelCandidate[],
  budget: number,
  widthOf: (id: string) => number,
  viewportW: number,
  cellW = LABEL_CELL_W,
  cellH = LABEL_CELL_H,
): string[] {
  const picked: string[] = [];
  const occupied = new Set<string>();
  for (const c of [...candidates].sort((a, b) => b.rank - a.rank)) {
    if (picked.length >= budget) break;
    if (c.f < LABEL_MIN_F) continue;
    const w = widthOf(c.id);
    const x = Math.round(c.x + 7);
    const y = Math.round(c.y - 5);
    if (x + w > viewportW - 4 || x < -2) continue;
    const cell = `${Math.floor(x / cellW)}:${Math.floor(y / cellH)}`;
    if (occupied.has(cell)) continue;
    occupied.add(cell);
    picked.push(c.id);
  }
  return picked;
}

/** 屏幕最近点拾取：投影结果已由近到远排序，故**先命中即最近**，取阈值内第一个。 */
export function pickNearest(projected: readonly Projected[], mx: number, my: number, threshold = PICK_PX): string | null {
  for (const p of projected) {
    if (Math.hypot(p.x - mx, p.y - my) < threshold) return p.id;
  }
  return null;
}

/** ease-in-out（二次）：过渡头尾慢、中间快，观感上"被放下去"而不是"弹过去"。 */
export function easeInOut(p: number): number {
  const k = Math.min(1, Math.max(0, p));
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}

/**
 * 两套布局间插值。缺项处理：只在一边出现的点（ego 裁剪掉的）按"贴到对侧最后位置"
 * 处理——直接消失会闪，从焦点位置长出来才读得懂。
 */
export function lerpLayout(
  from: ReadonlyMap<string, Vec3>,
  to: ReadonlyMap<string, Vec3>,
  k: number,
): Map<string, Vec3> {
  const e = easeInOut(k);
  const out = new Map<string, Vec3>();
  for (const [id, b] of to) {
    const a = from.get(id) ?? b;
    out.set(id, { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, z: a.z + (b.z - a.z) * e });
  }
  return out;
}

/** 滚轮缩放：乘法步进 + 钳制。 */
export function zoomBy(dist: number, deltaY: number): number {
  const next = dist * (deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  return Math.min(DIST_MAX, Math.max(DIST_MIN, next));
}
