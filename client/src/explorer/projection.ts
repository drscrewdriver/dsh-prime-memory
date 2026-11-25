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
import { HALL_FALLBACK, HALL_ORDER } from './hall-palette.js';

// ── 相机与交互常量（渲染层与单测共用同一组数字） ──────────────────
/** 透视焦距：越大越接近平视，越小纵深越夸张。 */
export const FOCAL = 1100;
/** 标签整层跳过的相机距离阈值（取证方向②：文字是最贵的一块，拉远后本就读不清）。 */
export const LABEL_SKIP_DIST = 2600;
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
  /** Wing 生活域归属（hall 轴分组键）；缺值落 general 兜底（键可缺席）。 */
  hall?: string;
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
  const known = ['person', 'project', 'organization', 'tool', 'place', 'activity', 'concept'].filter((t) => seen.has(t));
  const rest = [...seen].filter((t) => !known.includes(t)).sort((a, b) => hash32(a) - hash32(b));
  return [...known, ...rest];
}

/**
 * cluster 布局：每个类型簇在球面取一个方向（斐波那契球面，簇间尽量等距），
 * 簇内点在自己那层薄壳里散开。**没有全局中心**——这正是 prime-memory 要的形态。
 */
export function buildClusterLayout(nodes: readonly LayoutNode[]): Map<string, Vec3> {
  return buildClusterLayoutByAxis(nodes, 'type');
}

// ── 聚类轴参数化（hall 视角）：组键可换，散列种子前缀一个不改 ──────────
/** 聚类分组轴：type = 既有七类；hall = 生活域八维 + general 兜底。 */
export type ClusterAxis = 'type' | 'hall';

/** 节点在给定轴下的组键。hall 轴缺值落 HALL_FALLBACK（不出现 undefined 组键）。 */
export function groupKeyOf(n: LayoutNode, axis: ClusterAxis): string {
  if (axis === 'hall') return n.hall ?? HALL_FALLBACK;
  return n.type;
}

/**
 * hall 轴的组序：按 HALL_ORDER 固定序（与 WING_CATALOG 一致），未知 hall 值按
 * hash 升序追加（同 type 轴的确定性纪律），general（兜底组）殿后——它语义上
 * 是"跨域/无归属"，不挤进八维序列中间。**与入参顺序无关**（同契约 R6）。
 */
export function hallGroupOrder(keys: Iterable<string>): string[] {
  const seen = new Set<string>(keys);
  const known = HALL_ORDER.filter((h) => seen.has(h));
  const rest = [...seen]
    .filter((h) => !(HALL_ORDER as readonly string[]).includes(h) && h !== HALL_FALLBACK)
    .sort((a, b) => hash32(a) - hash32(b));
  const tail = seen.has(HALL_FALLBACK) ? [HALL_FALLBACK] : [];
  return [...known, ...rest, ...tail];
}

/** 按轴取组序：type 轴委托既有 clusterOrder（行为不动）；hall 轴走 hallGroupOrder。 */
export function groupOrder(keys: Iterable<string>, axis: ClusterAxis): string[] {
  return axis === 'hall' ? hallGroupOrder(keys) : clusterOrder(keys);
}

/**
 * buildClusterLayout 的轴参数化版本：把「组键 → 簇心」的斐波那契球面逻辑原样
 * 参数化，簇半径/抖动种子前缀 `c:`/`r:`/`a:`/`b:`/`s:` **一个不改**——
 * 同一节点 id 在两条轴下的球内角度/壳层半径保持一致，轴切换过渡读起来像
 * 「同一批点重新分堆」而不是「满屏乱飞」（findings F3）。
 */
export function buildClusterLayoutByAxis(nodes: readonly LayoutNode[], axis: ClusterAxis): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  const groups = groupOrder(
    nodes.map((n) => groupKeyOf(n, axis)),
    axis,
  );
  const centers = new Map<string, Vec3>();
  const total = Math.max(1, groups.length);
  groups.forEach((key, i) => {
    const y = total === 1 ? 0 : 1 - (i / (total - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * Math.PI * (3 - Math.sqrt(5)) + rand01(`c:${key}`) * 0.6;
    const radius = 230 + rand01(`r:${key}`) * 190;
    centers.set(key, {
      x: Math.cos(phi) * ring * radius,
      y: y * radius * 0.82,
      z: Math.sin(phi) * ring * radius,
    });
  });
  for (const n of nodes) {
    const c = centers.get(groupKeyOf(n, axis)) ?? { x: 0, y: 0, z: 0 };
    const a = rand01(`a:${n.id}`) * Math.PI * 2;
    const b = Math.acos(2 * rand01(`b:${n.id}`) - 1);
    const rr = 16 + Math.pow(rand01(`s:${n.id}`), 0.65) * 120;
    out.set(n.id, {
      x: c.x + Math.sin(b) * Math.cos(a) * rr,
      y: c.y + Math.cos(b) * rr * 0.72,
      z: c.z + Math.sin(b) * Math.sin(a) * rr,
    });
  }
  return out;
}
// ── 聚类形态（星系盘 / 8 字环）：簇心排布可换,种子前缀一个不改 ──────────
/** 聚类形态：sphere = 既有球面堆；disk = 横向星系盘（双臂螺旋,z 薄层错开）；lemniscate = 8 字回环。 */
/** disk 子风格:legacy = 既有双臂轮转;flat = 平铺(全簇环形均布一圈);spiral = 星系悬臂(巨簇独臂+其余双弧段)。 */
export type DiskStyle = 'disc' | 'legacy' | 'flat' | 'spiral';
export type ClusterShape = 'sphere' | 'disk' | 'lemniscate';

/**
 * 8 字**轨道参数**（布局产物）：点在 ∞ 轨道上的固有相位 + 带内固定偏移。
 *
 * 为什么必须在布局期留痕、而不是流转时从坐标反解：
 * 反解对贴轴点（|cos u|≈0）病态——A 会被算成巨大值再夹到 2.2×r0，于是一族大小不同的
 * ∞ 环叠在一起；拖动幅度时 A 与 wob 同时放大，整图直接飞散（真机就是"炸开"）。
 * 留下 (u, A, t, n, y) 后，流转只做「u += ω」一件事：带子沿环整体平移、逐点形状守恒，
 * 这才是参考图那条连续星尘带该有的动作。
 */
export interface EightOrbit {
  /** 曲线相位 u（0~2π）；流转时 u+ω。 */
  u: number;
  /** 该点所属曲线尺度 A（布局定，流转中恒定）。 */
  A: number;
  /** 沿切向的固定偏移（簇沿环的宽度）。 */
  t: number;
  /** 沿法向的固定偏移（带厚方向）。 */
  n: number;
  /** 竖直固定偏移（薄层 / 莫比乌斯扭转分量）。 */
  y: number;
}

/**
 * ∞ 曲线参数化（布局与流转**共用同一函数**，防两边各抄一份导致漂移）：
 * x = A·cos u，z = A·sin u·cos u（横向压到 0.72 保持薄环观感）。
 * 同时给出单位切向与平面内法向：带厚沿法向铺、簇宽沿切向铺。
 */
function eightCurve(u: number, A: number): { x: number; z: number; tx: number; tz: number; nx: number; nz: number } {
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const x = cosU * A;
  const z = sinU * cosU * A * 0.72;
  let tx = -sinU * A;
  let tz = (cosU * cosU - sinU * sinU) * A * 0.72;
  const len = Math.hypot(tx, tz) || 1;
  tx /= len;
  tz /= len;
  return { x, z, tx, tz, nx: -tz, nz: tx };
}

/**
 * 形态参数化的簇布局。组键序复用 groupOrder(axis),簇内散布种子前缀 `c:`/`r:`/`a:`/`b:`/`s:`
 * **一个不改**——同一节点 id 在任意形态/轴组合下球内角度分量保持一致,形态切换过渡读作
 * 「同一批点换队形」而不是「满屏乱飞」。
 *
 * - sphere: 与 buildClusterLayoutByAxis 逐位一致(既有球面堆,竖向偏多是 y 铺开的固有特征);
 * - disk: 双臂螺旋(偶数序簇走臂 A、奇数序簇走臂 B,臂内半径递推成 S 弧),盘面 = x-z 平面,
 *   簇内点沿臂向长散布 + 垂直臂向窄 + y 薄层 ±28(横向盘状展开,z→y 稍微错开);
 * - lemniscate: 簇心沿 ∞ 曲线 x=A·cos t / z=A·sin t·cos t 均布,簇内沿环向散布 + y 薄层。
 */
export function buildClusterShapeLayout(
  nodes: readonly LayoutNode[],
  axis: ClusterAxis,
  shape: ClusterShape,
  diskStyle: DiskStyle = 'spiral',
  /** 悬臂散度 0~1:0 = 等宽细带(均匀),1 = 外沿大幅扇开成稀疏星尘尖端。仅 spiral 生效。 */
  armSpread = 0.55,
  /** 圆盘(吸积盘)的随机种子:决定臂数与整体朝向。0 = 固定默认;每次进入随机 = 每次不同角度。 */
  discSeed = 0,
  /** 8 字子风格:成簇(按簇分段)/ 连续(全体混编成一条扭转带)。仅 lemniscate 生效。 */
  eightStyle: EightStyle = 'cluster',
  /**
   * 8 字轨道参数**输出口**（可选）：lemniscate 形态下为每个点写一条 (u,A,t,n,y)。
   * flowShape 拿到它才能做「沿环推移而不重算半径」的流转；不传则调用方只拿点位。
   */
  orbitsOut?: Map<string, EightOrbit>,
): Map<string, Vec3> {
  if (shape === 'sphere') return buildClusterLayoutByAxis(nodes, axis);
  const out = new Map<string, Vec3>();
  /**
   * type 轴的**超大组拆半**:真实数据里 tool 常常占掉一半以上节点,单簇在盘/环上
   * 会独占一整臂或糊成一坨。超过阈值(≥max(50, 总数 22%))的组按 id 确定性哈希
   * 拆成 `key#0` / `key#1` 两个子簇——平分后两条臂的负载自然均衡,且同一 id
   * 永远落在同一半边(可回放)。hall 轴不拆:八维本身就均衡。
   */
  const baseCount = new Map<string, number>();
  for (const n of nodes) {
    const b = groupKeyOf(n, axis);
    baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
  }
  const sumAll = nodes.length || 1;
  const splitSet = new Set<string>();
  // 拆半阈值对所有轴生效:type 轴 tool 常占一半以上,hall 轴 work 同样能占 50%+。
  // 不拆的话超大簇会独占一整条臂(臂上堆 800 点成实心肥虫,其余臂稀稀拉拉)。
  for (const [b, c] of baseCount) {
    if (c >= Math.max(50, sumAll * 0.22) && baseCount.size > 1) splitSet.add(b);
  }
  /** 形态布局内的组键:type 轴超大组拆半,其余同 groupKeyOf。 */
  /** 每个被拆组拆成几份:占比越高拆得越多(最大 3),避免巨簇独占一条臂。 */
  const splitParts = new Map<string, number>();
  for (const b of splitSet) {
    const frac = (baseCount.get(b) ?? 0) / sumAll;
    splitParts.set(b, frac > 0.4 ? 3 : 2);
  }
  const keyOf = (n: LayoutNode): string => {
    const b = groupKeyOf(n, axis);
    if (!splitSet.has(b)) return b;
    const parts = splitParts.get(b) ?? 2;
    const r = rand01(`x:${n.id}`);
    return `${b}#${Math.min(parts - 1, Math.floor(r * parts))}`;
  };
  const groups = groupOrder(nodes.map(keyOf), axis);
  const centers = new Map<string, Vec3>();
  /** 8 字：簇 → 轨道相位 u / 曲线尺度 A。点级摆放与流转都读这张表（单一事实来源）。 */
  const eightU = new Map<string, number>();
  const eightA = new Map<string, number>();
  const total = Math.max(1, groups.length);
  const countOf = new Map<string, number>();
  for (const n of nodes) {
    const g = keyOf(n);
    countOf.set(g, (countOf.get(g) ?? 0) + 1);
  }
  /**
   * 臂段表:簇 → 它在臂上占据的 [s0,s1] 弧段(连同臂基点与卷角)。
   * 关键设计——**簇不是臂上的一个点,而是臂的一段**。簇内每个点在此弧段内独立取 s,
   * 半径/角向都随 s 连续推进,于是无论只有 9 个 hall 簇还是 40 个簇,
   * 拼起来都是一条从核球连续卷到外沿的星流带,而不是一串孤立的短棒。
   */
  /** 旋臂半径带:核球边缘 150 → 盘外沿 640(对数螺线两端)。 */
  const R0 = 150;
  const REND = 570;
  const armSpan = new Map<string, { base: number; chord: number; s0: number; s1: number; r0: number }>();
  /** disc 用:簇 → 序号(决定它占哪条径向扇区)。 */
  const groupIdx = new Map<string, number>();
  groups.forEach((k, i) => groupIdx.set(k, i));
  const placeOnArms = (bins: string[][], chord: number, rot = 0, r0 = R0): void => {
    const N = bins.length;
    bins.forEach((bin, arm) => {
      const base = (arm / N) * Math.PI * 2 + rot + rand01(`c:arm${arm}`) * 0.16;
      // 臂内按大小降序:大簇占长弧段且靠内(臂头),小簇靠外
      const ordered = [...bin].sort((a, b) => (countOf.get(b) ?? 0) - (countOf.get(a) ?? 0));
      // s 段按「簇数均分 + 权重轻度调制」:纯按权重会让大簇独占内半臂、
      // 外半臂只剩极小簇 → 视觉上臂"长不出去"。取权重的 0.5 次幂做抑制调制。
      const mods = ordered.map((k) => Math.pow(countOf.get(k) ?? 1, 0.5));
      const wSum = mods.reduce((a, b) => a + b, 0) || 1;
      let acc = 0;
      for (let oi = 0; oi < ordered.length; oi++) {
        const key = ordered[oi]!;
        const w = mods[oi] ?? 1;
        // 弧段覆盖整个臂(0.02~0.98),相邻簇首尾相接
        const s0 = 0.02 + (acc / wSum) * 0.96;
        const s1 = 0.02 + ((acc + w) / wSum) * 0.96;
        acc += w;
        armSpan.set(key, { base, chord, s0, s1, r0 });
        // 簇心取弧段中点(标签/拾取用)
        const sm = (s0 + s1) / 2;
        const theta = base + sm * chord;
        const radius = r0 * Math.pow(REND / r0, sm); // 对数螺线:径向指数外推
        centers.set(key, {
          x: Math.cos(theta) * radius,
          y: (rand01(`r:${key}:y`) - 0.5) * 26,
          z: Math.sin(theta) * radius * 0.82,
        });
      }
    });
  };
  // 均衡装箱:大簇先入当前最空的臂(按节点数)
  const binPack = (nArms: number): string[][] => {
    const bins: string[][] = Array.from({ length: nArms }, () => []);
    const load = new Array(nArms).fill(0);
    const sorted = [...groups].sort((a, b) => (countOf.get(b) ?? 0) - (countOf.get(a) ?? 0));
    for (const key of sorted) {
      let mi = 0;
      for (let i2 = 1; i2 < nArms; i2++) if ((load[i2] ?? 0) < (load[mi] ?? 0)) mi = i2;
      const bin = bins[mi];
      if (bin) {
        bin.push(key);
        load[mi] = (load[mi] ?? 0) + (countOf.get(key) ?? 1);
      }
    }
    return bins;
  };
  if (shape === 'disk' && diskStyle === 'disc') {
    // ── 吸积盘(accretion disk)──
    // 与"均匀靶纸"的区别在**差速旋进**:每个点按半径转 Δθ = swirl·ln(r/r0),
    // 内圈卷得紧、外圈拖得开 → 整盘呈对数螺旋纹,这才是吸积盘/旋涡星云的观感。
    // 骨架用黄金角铺满(任意簇数都不留空、不偏心),半径 r^0.72 偏置(中心密外沿疏),
    // 整体朝向与旋进强度由 discSeed 决定 → 每次进入/切换都是不同角度的盘。
    const GA = Math.PI * (3 - Math.sqrt(5));
    const rot = rand01(`disc:${discSeed}:rot`) * Math.PI * 2;
    const seedJ = rand01(`disc:${discSeed}:j`) * 0.5;
    groups.forEach((key, i) => {
      const rr = Math.pow((i + 0.5 + seedJ) / total, 0.72);
      const radius = 110 + rr * 520;
      const theta = i * GA + rot + (rand01(`c:${key}`) - 0.5) * 0.42;
      centers.set(key, {
        x: Math.cos(theta) * radius,
        y: (rand01(`r:${key}:y`) - 0.5) * 30,
        z: Math.sin(theta) * radius * 0.82,
      });
    });
  }
    if (shape === 'disk' && diskStyle === 'spiral') {
    // 六臂星系:6 臂共用同一扫掠 θ=base+s·chord → 任意半径处臂距恒为 2π/6=1.047 rad,永不交缠。
    // 螺旋角 = atan(chord / ln(REND/R0))。1.55 对应 42°——内圈卷成钩、外圈贴切线,
    // 正是"有个臂卷起来 + 向无穷远直射"的病根;2.45 对应 ≈32°,臂舒展而仍有旋纹。
    placeOnArms(binPack(6), 2.45);
  }
  if (shape === 'disk' && diskStyle === 'legacy') {
    // 双臂螺旋:相位差 π、共用扫掠 → 两条分明旋臂,绝不并成一条
    placeOnArms(binPack(2), 2.45);
  }
  if (shape === 'disk' && diskStyle === 'flat') {
    // 平铺:所有簇环形均布一圈,半径随序外推成同心环带,无臂结构
    groups.forEach((key, i) => {
      const theta = (i / total) * Math.PI * 2 + rand01(`c:${key}`) * 0.4;
      const radius = 260 + Math.sqrt(i) * 150 + rand01(`r:${key}`) * 50;
      centers.set(key, {
        x: Math.cos(theta) * radius,
        y: (rand01(`r:${key}:y`) - 0.5) * 40,
        z: Math.sin(theta) * radius * 0.82,
      });
    });
  }
  if (shape === 'lemniscate') {
    // 两种子风格共用同一条 ∞ 曲线参数化:x = A·cosφ, z = A·sinφ·cosφ(A 按簇固定)。
    // cluster:簇心按 φ 分段 → 每个簇聚在曲线的一段(既有行为,保留可回放);
    // continuous:簇心**不按 φ 分段**,全部落在同一条曲线上但 φ 由簇序 + 全局相位打散,
    //            真正"弱化聚类"的部分在点级采样(见下方 continuous 分支)。
    if (eightStyle === 'continuous') {
      // 连续 8 字:簇心只作"带子里的锚",φ 按黄金角铺满整条曲线 → 簇与簇沿环交替,
      // 不形成整段单色块;真正决定形态的是下面点级的连续采样。
      const GA8 = Math.PI * (3 - Math.sqrt(5));
      groups.forEach((key, i) => {
        const phi = (i * GA8) % (Math.PI * 2);
        const A = 560 + rand01(`r:${key}`) * 80;
        eightU.set(key, phi);
        eightA.set(key, A);
        centers.set(key, {
          x: Math.cos(phi) * A,
          y: (rand01(`r:${key}:y`) - 0.5) * 26,
          z: Math.sin(phi) * Math.cos(phi) * A * 0.72,
        });
      });
    } else {
      groups.forEach((key, i) => {
        const jitter = rand01(`c:${key}`) * 0.5;
        const t8 = (i / total) * Math.PI * 2 + jitter;
        const A = 560 + rand01(`r:${key}`) * 80;
        eightU.set(key, t8);
        eightA.set(key, A);
        centers.set(key, {
          x: Math.cos(t8) * A,
          y: (rand01(`r:${key}:y`) - 0.5) * 36,
          z: Math.sin(t8) * Math.cos(t8) * A * 0.72,
        });
      });
    }
  }
  for (const n of nodes) {
    const gk = keyOf(n);
    if (shape === 'lemniscate' && eightStyle === 'continuous') {
      // ── 连续 8 字（混编无限环）──
      // 核心:点的相位 u **不按簇分段**——全体按 id 均匀采样（全局混编），
      // 颜色沿环交织，不形成任何"类型段"。
      // 截面:横向偏移固定沿**平面法向**（不再做莫比乌斯扭转）。扭转会把带子
      // 在某些相位立起来 → 投影后忽粗忽细、看着像偏离轨道；参考图的带子是均匀
      // 的平面环管。
      const A = 560;
      const u = (rand01(`s:${n.id}`) + (rand01(`u2:${n.id}`) - 0.5) * 0.006) * Math.PI * 2;
      // 带半宽取**常量**（≈A 的 3.2%）:端部显蓬松是透视（端部正对视线）的副产物，
      // 不再靠 |cos u| 人为加宽（那会让带子忽粗忽细）。
      const halfW = 18;
      const w = (rand01(`b:${n.id}`) - 0.5) * 2 * halfW;
      const c8 = eightCurve(u, A);
      // 竖向薄层按点独立（旧实现按簇共用 y → 同簇点共面叠成一片，读作聚类）。
      const y8 = (rand01(`y:${n.id}`) - 0.5) * 28;
      out.set(n.id, {
        x: c8.x + c8.nx * w,
        y: y8,
        z: c8.z + c8.nz * w,
      });
      // 轨道留痕:u 是固有相位，A 固定，带厚 w 与竖向 y8 作为固定偏移。
      orbitsOut?.set(n.id, { u, A, t: 0, n: w, y: y8 });
      continue;
    }
    if (shape === 'disk') {
      const span = armSpan.get(gk);
      if (span) {
        // 臂段分布:点在自己的弧段内独立取 s → 簇铺成弧,相邻簇首尾相接成连续星流带
        const { base, chord, s0, s1 } = span;
        const R0 = span.r0; // 本臂内半径(disc 更靠核球)
        // 核球(bulge):按比例抽 12% 的点铺进核心球(半径 0~R0·1.15,密度 ∝ r²)——
        // 否则臂从 R0 才起笔,盘心是一块空洞,读起来像"甜甜圈"而不是星系。
        // 核球点不参与臂的角向/径向抖动,颜色仍按原簇 → 核球是各色混杂的亮核。
        if (rand01(`k:${n.id}`) < 0.2) {
          const rb = R0 * 1.05 * Math.pow(rand01(`k2:${n.id}`), 1.7);
          const ab = rand01(`k3:${n.id}`) * Math.PI * 2;
          out.set(n.id, {
            x: Math.cos(ab) * rb,
            y: (rand01(`s:${n.id}:y`) - 0.5) * 26,
            z: Math.sin(ab) * rb * 0.82,
          });
          continue;
        }
        // 半径均匀重采样:对数螺线下 dr/ds ∝ r 会把点堆在内圈;先均匀取 r 再反解 s,
        // 臂的每一段密度一致,整条臂才一路连续长到外沿。
        const K = REND / R0;
        const rr0 = R0 * Math.pow(K, s0);
        const rr1 = R0 * Math.pow(K, s1);
        const rt = rr0 + rand01(`s:${n.id}`) * (rr1 - rr0);
        const s = Math.log(rt / R0) / Math.log(K);
        // 散度:内圈紧凑、外沿散开(∝ s²)——臂在盘心是实心星流带,到外沿渐散成稀疏星尘,
        // 这正是参考星系"外部尖端"的形状来源(不是等宽细带)。
        // 散度(armSpread):角向张开量按**绝对 s** 增长(∝ s²),不是按簇自身弧长——
        // 盘心 s≈0 时几乎不张(实心星流带),外沿 s≈1 张开到 ±0.16rad(≈9°),
        // 同样多的点摊在更宽的扇面上 → 外沿自然稀疏、读作"星尘尖端"而不是等宽细带。
        // 散度:盘心 s≈0 收紧成实心星流带,s→1 逐渐摊宽成稀疏星尘。
        // 张开量按 s² 走(外沿才明显),径向抖动同步放大——但都有上限,不会把点甩出臂外。
        const isDisc = diskStyle === 'disc';
        // 吸积盘的纹路靠"密绕"读出来,抖动必须收紧(否则糊成一团失掉旋涡纹);
        // 悬臂则吃散度参数,外沿扇开成稀疏星尘。
        const fan = isDisc ? s * s * 0.12 : s * s * armSpread;
        const rJit = (isDisc ? 7 : 10 + 16 * (s1 - s0)) * (1 + fan * 1.9);
        let radius = rt + (rand01(`a:${n.id}`) - 0.5) * 2 * rJit;
        let theta = base + s * chord + (rand01(`b:${n.id}`) - 0.5) * (isDisc ? 0.05 + fan * 0.5 : 0.035 + fan * 0.5);

        // 尖端收束:外沿最外侧 12% 的点把横向抖动压回去(1/(1+ext*5))——
        // 臂末端是"渐渐收细的星尘尾",不是越往外越宽的扇面、更不是射向无穷远的射线。
        if (s > 0.88) {
          const k2 = 1 / (1 + (s - 0.88) * 26);
          radius = rt + (radius - rt) * k2;
          theta = base + s * chord + (theta - (base + s * chord)) * k2;
        }
        out.set(n.id, {
          x: Math.cos(theta) * radius,
          y: (rand01(`s:${n.id}:y`) - 0.5) * 34,
          z: Math.sin(theta) * radius * 0.82,
        });
      } else {
        // 圆盘/平铺:簇心团块散布。disc 的散布更大且更扁 → 相邻簇边界咬合成一整片圆盘(混合观感);
        // flat 保持小块状,好让"平铺环带"的层次读得出来。
        // disc 核球:同样按 20% 铺进核心球(否则吸积盘中心是空洞,不像盘)。
        if (diskStyle === 'disc' && rand01(`k:${n.id}`) < 0.2) {
          const rb = 115 * Math.pow(rand01(`k2:${n.id}`), 1.7);
          const ab = rand01(`k3:${n.id}`) * Math.PI * 2;
          out.set(n.id, {
            x: Math.cos(ab) * rb,
            y: (rand01(`s:${n.id}:y`) - 0.5) * 26,
            z: Math.sin(ab) * rb * 0.82,
          });
          continue;
        }
        const c = centers.get(gk) ?? { x: 0, y: 0, z: 0 };
        const a = rand01(`a:${n.id}`) * Math.PI * 2;
        const b = Math.acos(2 * rand01(`b:${n.id}`) - 1);
        const discMode = diskStyle === 'disc';
        // disc 用 sqrt 分布(面积均匀,盘内密度一致、外沿收得干净);flat 保持小块状。
        // disc:散布半径 ∝ 盘面/√N(每簇应占的等效面积半径)×1.7——相邻簇边界互相咬合,
        // 整张盘读作连成一片的混合圆盘;平铺保持小块状以保留环带层次。
        const discSpread = discMode ? (520 / Math.sqrt(Math.max(1, total))) * 1.7 : 0;
        // 吸积盘旋涡纹:把点沿其半径再转一个 Δθ = swirl·ln(r/110)(差速)——
        // 簇心与簇内点同吃同一变换,整盘才是连贯的对数螺旋纹,而不是"各转各的"。
        const swirlD = discMode ? 1.9 + rand01(`disc:${discSeed}:sw`) * 1.1 : 0;
        const rr2 = discMode
          ? Math.sqrt(rand01(`s:${n.id}`)) * discSpread
          : 16 + Math.pow(rand01(`s:${n.id}`), 0.65) * 90;
        let px2 = c.x + Math.sin(b) * Math.cos(a) * rr2;
        let pz2 = c.z + Math.sin(b) * Math.sin(a) * rr2;
        if (discMode && swirlD > 0) {
          const rp0 = Math.hypot(px2, pz2) || 1;
          const dth = swirlD * Math.log(rp0 / 110);
          const cs = Math.cos(dth), sn = Math.sin(dth);
          const nx = px2 * cs - pz2 * sn;
          const nz = px2 * sn + pz2 * cs;
          px2 = nx; pz2 = nz;
        }
        if (discMode) {
          // 外沿裁剪:超出盘半径的点沿径向夹回 → 圆盘边界干净,不散成云
          const rp = Math.hypot(px2, pz2);
          const RMAX = 640;
          if (rp > RMAX) {
            const k2 = RMAX / rp;
            px2 *= k2;
            pz2 *= k2;
          }
        }
        out.set(n.id, {
          x: px2,
          y: c.y + Math.cos(b) * rr2 * (discMode ? 0.16 : 0.5),
          z: pz2,
        });
      }
    } else {
      // lemniscate:簇心沿 ∞ 曲线,簇内沿**曲线切向**铺簇宽、沿**曲线法向**铺带厚 + 竖直薄层。
      // 旧实现用「以原点为心的圆切向」，簇在 ∞ 曲线上是歪的；改成曲线自身的切/法向后，
      // 成簇形态也贴合同一条轨道，流转时整簇沿环平移不会散架。
      const orbU = eightU.get(gk) ?? 0;
      const orbA = eightA.get(gk) ?? 560;
      const c8 = eightCurve(orbU, orbA);
      const a = rand01(`a:${n.id}`) * Math.PI * 2;
      const b = Math.acos(2 * rand01(`b:${n.id}`) - 1);
      // 簇内散布半径同步收窄（旧 16+120 会让法向偏移达 ±81，= 半径的 14%，
      // 成簇版 8 字看起来像一圈粗棍而不是贴轨星团）。
      const rr = 10 + Math.pow(rand01(`s:${n.id}`), 0.65) * 85;
      const ring = Math.sin(b) * Math.cos(a) * rr; // 切向（簇沿环的宽度）
      const cross = Math.sin(b) * Math.sin(a) * rr * 0.3; // 法向（带厚）
      const y8 = (rand01(`s:${n.id}:y`) - 0.5) * 28;
      out.set(n.id, {
        x: c8.x + c8.tx * ring + c8.nx * cross,
        y: y8,
        z: c8.z + c8.tz * ring + c8.nz * cross,
      });
      orbitsOut?.set(n.id, { u: orbU, A: orbA, t: ring, n: cross, y: y8 });
    }
  }
  return out;
}
/**
 * 形态动画帧变换（炫技档）：disk = 差速自转（内圈快外圈慢，星系感的关键）；
 * lemniscate = 8 字轨道流转（整条星尘带沿 ∞ 环连续流动）。
 * 纯几何驱动——只吃点位，不需要簇归属信息；确定性：同一帧同一批点位置恒定。
 * 纯函数:base 布局不动,返回新 Map;主循环每帧调用(开销 = 一次 Map 遍历,千点级无感)。
 */
export type FlowStyle = 'spin' | 'eight' | 'accretion';

/**
 * 8 字子风格:
 * - cluster:    按簇分角度成团，每个簇在 ∞ 曲线的一段上成块（看归属用，流转时是大块平移）；
 * - continuous: **连续混编**——所有点按 id 独立均匀采样相位，沿 ∞ 曲线铺满；
 *   颜色沿环交织、不构成类型段；截面固定沿平面法向（不做扭转）。UI 默认此档。
 */
export type EightStyle = 'cluster' | 'continuous';

/**
 * 形态动画帧变换（炫技档）。样式与形态解耦——任意盘/环都可选自转或 8 字流：
 * - spin: 刚体自转（与半径无关 → 螺旋臂永不被剪切）；
 * - eight: 真 8 字轨道流——**只推进固有相位**（u += ω），点相对轨道的偏移原样保留，
 *   所以带子沿 ∞ 环整体流动、形状守恒（传 orbits 时）；无轨道参数时兜底按坐标反解。
 * 幅度：盘状 = 悬臂带长（静态，见 applyArmLength）；8 字 = 带厚/簇宽缩放（0.3~1.7×）。
 * 纯几何驱动，只吃 (t, 布局, 参数)，不含状态 → 同一 t 必得同一帧（可回放）。
 */
/**
 * 幅度 = 悬臂**带子的长度**(纯静态几何参数,不吃时间)。
 *
 * 悬臂是几条超长的带子按对数螺线卷起来,幅度控制"带子多长":
 *   amp = 1 → 原始长度(中性,逐点原样返回)
 *   amp = 0 → 缩短 45%;amp = 2 → 拉长 45%
 *
 * 实现:沿自身螺线加一段额外弧长 ds = s·(L−1),半径与卷角同步推进:
 *   r2 = rr · K^ds,θ2 = ang + ds·chord
 * 点相对螺线的偏移(带厚、散度)原样保留,所以带子不会被撕开。
 *
 * **与流转的隔离**:这里不接收 t,也不接收 speed —— 幅度只改形状,不改动态。
 * (旧实现用 sin(ts·0.0007·amp) 让带子呼吸,于是"转速拉到最低几乎不转,画面却还在伸缩",
 * 那是把吸积盘/8字流的动态特性错给了悬臂。)
 */
export function applyArmLength(
  base: ReadonlyMap<string, Vec3>,
  amp: number,
): Map<string, Vec3> {
  const L = Math.max(0.35, 1 + (amp - 1) * 0.45);
  if (Math.abs(L - 1) < 1e-6) return new Map(base);
  const R0 = 150;
  const lnK = Math.log(570 / R0);
  const chord = 2.45;
  const out = new Map<string, Vec3>();
  for (const [id, p] of base) {
    const rr = Math.hypot(p.x, p.z / 0.82);
    if (rr <= R0 * 1.02) { out.set(id, p); continue; }
    const s = Math.log(rr / R0) / lnK;
    const ds = s * (L - 1);
    const r2 = rr * Math.exp(ds * lnK);
    const th2 = Math.atan2(p.z / 0.82, p.x) + ds * chord;
    out.set(id, { x: Math.cos(th2) * r2, y: p.y, z: Math.sin(th2) * r2 * 0.82 });
  }
  return out;
}

export function flowShape(
  base: ReadonlyMap<string, Vec3>,
  t: number,
  shape: ClusterShape,
  speed = 1,
  amp = 1,
  flowStyle?: FlowStyle,
  /** 8 字轨道参数（buildClusterShapeLayout 的 orbitsOut 产物）：有则沿环推移，无则兜底反解。 */
  orbits?: ReadonlyMap<string, EightOrbit>,
): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  if (shape === 'sphere') return out; // 球面堆不流转(调用方直接跳过)
  const style: FlowStyle = flowStyle ?? (shape === 'lemniscate' ? 'eight' : 'spin');
  // 统一时相:ts = t × speed。speed=0 时整体冻结(含幅度摆动),调速度也不会让相位跳。
  const ts = t * speed;
  // speed=0 且相位为 0 = 真正的"静止"态:直接返回 base 副本。
  // (点级相位 jp 在 ts=0 时仍会给出非零偏移,若不早退,speed=0 就不是原样,违背冻结语义。)
  if (ts === 0) {
    for (const id of base.keys()) out.set(id, base.get(id)!);
    return out;
  }
  for (const id of base.keys()) {
    const p = base.get(id)!;
    if (style === 'accretion') {
      // ── 吸积盘流(accretion)──
      // 与刚体自转的根本区别:**每个粒子有自己的轨道**。三层随机叠加:
      //  ① 开普勒差速 ω ∝ r^-1.5 —— 内圈快、外圈慢,盘面自然剪出旋涡纹;
      //  ② 点级角速度个体差(±18%)—— 同半径的点也不同步,读作"散粒在流动"而不是整盘刚性转;
      //  ③ 点级相位偏移 + 不同周期的径向游走 / 垂直起伏 —— 每颗粒子有自己的呼吸节奏。
      // 圆盘是黄金角铺满、没有臂结构,所以差速剪切只会让纹路更旋涡,**不会**像悬臂那样被缠成一团
      // (这正是悬臂必须用刚体的原因,两者约束不同)。
      const r0 = Math.hypot(p.x, p.z) || 1;
      const jp = rand01('f2:' + id) * Math.PI * 2; // 点级相位
      const jp2 = rand01('f3:' + id) * Math.PI * 2; // 第二相位(漂移用,与 jp 不同步)
      const jw = (rand01('f:' + id) - 0.5) * 0.9; // 点级角速度个体差 ±45%
      // 开普勒差速:基准角速度对齐刚体自转量级(0.0011 rad/ms @ r=180),
      // 再乘 (180/r)^0.9 —— 内圈快约 1.8 倍、外沿慢到 0.3 倍,差速比 6:1,
      // 盘面剪出清晰旋涡纹;指数取 0.9 而非 1.5,避免内圈快到糊成一团。
      // ts 由调用方累加 → 改速度相位连续。
      const om = 0.0011 * Math.pow(180 / Math.max(60, r0), 0.9) * (1 + jw);
      const a = om * ts;
      const cy = Math.cos(a); const sy = Math.sin(a);
      // 径向游走:每点自己的周期(0.6~1.4 倍频)与相位 → 盘面像在"吸气",不是整体缩放
      const fr = 0.6 + rand01('f4:' + id) * 0.8;
      const rw = 1 + Math.sin(ts * 0.0008 * fr + jp) * (0.08 + 0.16 * amp);
      // 垂直起伏:点级不同步,幅度放大
      const dy = Math.sin(ts * 0.0011 * fr + jp * 2.3) * (6 + 30 * amp);
      // **随机游走(布朗式抖动)**:每颗粒子沿盘面切向 + 径向各叠一个独立的小幅漂移,
      // 频率与相位都按点不同(0.5~1.8 倍频)→ 读作"一群散粒各自游动",而不是一块整盘在转。
      // 幅度按半径缩放(内圈小、外圈大),避免盘心糊成一团。
      const rScale = 0.35 + 0.65 * Math.min(1, r0 / 480);
      const fw = 0.5 + rand01('f5:' + id) * 1.3;
      const tang = Math.sin(ts * 0.0016 * fw + jp2) * (4 + 13 * amp) * rScale;
      const rad = Math.cos(ts * 0.0013 * fw + jp2 * 1.7) * (4 + 13 * amp) * rScale;
      // 切向 = 半径方向的垂直;径向 = 半径方向
      const ux = p.x / r0, uz = p.z / r0;
      const bx = (p.x * cy - p.z * sy) * rw - uz * tang + ux * rad;
      const bz = (p.x * sy + p.z * cy) * rw + ux * tang + uz * rad;
      out.set(id, { x: bx, y: p.y + dy, z: bz });
      continue;
    }
    if (style === 'spin') {
      // **刚体自转**:全盘同一角速度(与半径无关)。这是星臂不变形的唯一前提——
      // 差速旋转(内快外慢)会让任意螺旋臂随 t 无限剪切,转一会儿就缠绕成一团。
      // t 由调用方按 ∫speed·dt 累加,故改速度时相位连续。
      //
      // 幅度(带子长度)不在这里:它是**纯静态几何**,由调用方在 layout 上先施加
      // applyArmLength(base, amp) 完成。spin 只负责转,不吃 amp、不吃形变,
      // 所以转速再低形状也静止 —— 不会出现盘几乎不动却还在伸缩。
      const a = 0.10 * 0.0167 * ts; // rad
      const cy = Math.cos(a); const sy = Math.sin(a);
      out.set(id, {
        x: p.x * cy - p.z * sy,
        y: p.y,
        z: p.x * sy + p.z * cy,
      });
    } else {
      // ── 8 字真轨道流：只推进**固有相位**，不重算半径 ──
      // 点 = C(u+ω) + 切向·t + 法向·n + 竖向 y。带子（或簇）沿 ∞ 环整体平移，
      // 逐点偏移量保持 → 形状守恒；幅度只缩放带厚/簇宽（0.3~1.7×），永远拉不出画面。
      // 这是参考图那条连续星尘带的动作；旧的「反解 A + wob 摆动」在贴轴点会把
      // A 算成巨大值，拖幅度时整图飞散（用户报的"炸开"）。
      const om = ts / 20000;
      const orb = orbits?.get(id);
      if (orb) {
        const k = 0.3 + 0.7 * amp; // 幅度 = 带厚/簇宽的比例（1 → 原尺寸）
        const c8 = eightCurve(orb.u + om, orb.A);
        out.set(id, {
          x: c8.x + c8.tx * orb.t * k + c8.nx * orb.n * k,
          y: orb.y * k,
          z: c8.z + c8.tz * orb.t * k + c8.nz * orb.n * k,
        });
        continue;
      }
      // 兜底：非 lemniscate 布局（如盘）显式选 8 字流时按坐标反解轨道。
      // A 与 wob 都夹死上限——宁可转得保守，也不能把点甩到画外。
      const off = (rand01('f:' + id) - 0.5) * 0.6; // 点级小偏移,带子错落
      const r0 = Math.hypot(p.x, p.z) || 1;
      const ct = Math.max(-1, Math.min(1, p.x / r0));
      let t8 = Math.acos(ct);
      if (Math.sin(t8) * Math.cos(t8) * (p.z / r0) < 0) t8 = Math.PI * 2 - t8;
      const ph = t8 + om + off;
      const jit = (rand01('j:' + id) - 0.5) * (0.06 + 0.25 * amp);
      const A = Math.min(r0 * 1.6, r0 / Math.max(0.18, Math.abs(Math.cos(t8)) + Math.abs(Math.sin(t8) * Math.cos(t8)))) * (1 + jit);
      const x = Math.cos(ph) * A;
      const z = Math.sin(ph) * Math.cos(ph) * A;
      const wob = 8 + 26 * amp; // 幅度 0→不超过±8,2→不超过±60（旧值 146 是炸开主因）
      out.set(id, {
        x: x + Math.sin(ph * 3.1) * wob,
        y: p.y + Math.cos(ph * 2.3) * wob * 0.8,
        z: z + Math.sin(ph * 2.7) * wob,
      });
    }
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
  /**
   * 散度（聚拢密度）：1 = 既有壳层（±9% 层内抖动）；<1 更聚拢（层间距与层内抖动同收），
   * >1 更散开。只作用于焦点展示——全图流转不吃它（用户裁定：全图不需要散度）。
   */
  spread = 1,
): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  const k = Math.min(2.4, Math.max(0.35, spread));
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
    const R = h * SHELL_GAP * k;
    const total = ids.length;
    ids.forEach((id, i) => {
      if (h === 0) {
        out.set(id, { x: 0, y: 0, z: 0 });
        return;
      }
      const y = total === 1 ? 0 : 1 - (i / (total - 1)) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * Math.PI * (3 - Math.sqrt(5)) + rand01(`e:${id}`) * 0.7;
      // 层内抖动随散度缩放：聚拢时同壳点贴得更紧，散开时更像星尘（spread=1 逐位回到原值）
      const jitter = 1 + (rand01(`j:${id}`) - 0.5) * 0.18 * (0.5 + 0.5 * k);
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

// ── 激活元素呼吸（时间项脉冲）────────────────────────────
/** 呼吸周期（ms）：260ms 接近“反光”而非“加载动画”的节奏。
 *  只作用于激活元素（hover 命中/焦点）；背景星恒静——
 *  早先的 90px proximity 激活场被真机否决：鼠标随便一动全场闪跳。 */
export const BREATH_PERIOD_MS = 260;

/** 每点相位由 id 散列派生（0~2π）：同图恒同相位；焦点与 hover 错相呼吸——
 *  齐闪会读成加载动画，错相才读成星空（单测钉住这条反例门禁）。 */
export function phaseOf(id: string): number {
  return (hash32(id) % 6283) / 1000;
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
