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
  const known = ['person', 'project', 'organization', 'tool', 'place'].filter((t) => seen.has(t));
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
/** 聚类分组轴：type = 既有五类；hall = 生活域八维 + general 兜底。 */
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
 * 形态参数化的簇布局。组键序复用 groupOrder(axis),簇内散布种子前缀 `c:`/`r:`/`a:`/`b:`/`s:`
 * **一个不改**——同一节点 id 在任意形态/轴组合下球内角度分量保持一致,形态切换过渡读作
 * 「同一批点换队形」而不是「满屏乱飞」。
 *
 * - sphere: 与 buildClusterLayoutByAxis 逐位一致(既有球面堆,竖向偏多是 y 铺开的固有特征);
 * - disk: 双臂螺旋(偶数序簇走臂 A、奇数序簇走臂 B,臂内半径递推成 S 弧),盘面 = x-z 平面,
 *   簇内点沿臂向长散布 + 垂直臂向窄 + y 薄层 ±28(横向盘状展开,z→y 稍微错开);
 * - lemniscate: 簇心沿 ∞ 曲线 x=A·cos t / z=A·sin t·cos t 均布,簇内沿环向散布 + y 薄层。
 */
export function buildClusterShapeLayout(nodes: readonly LayoutNode[], axis: ClusterAxis, shape: ClusterShape, diskStyle: DiskStyle = 'spiral'): Map<string, Vec3> {
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
  if (axis === 'type') {
    for (const [b, c] of baseCount) {
      if (c >= Math.max(50, sumAll * 0.22) && baseCount.size > 1) splitSet.add(b);
    }
  }
  /** 形态布局内的组键:type 轴超大组拆半,其余同 groupKeyOf。 */
  const keyOf = (n: LayoutNode): string => {
    const b = groupKeyOf(n, axis);
    if (!splitSet.has(b)) return b;
    return `${b}#${rand01(`x:${n.id}`) < 0.5 ? 0 : 1}`;
  };
  const groups = groupOrder(nodes.map(keyOf), axis);
  const centers = new Map<string, Vec3>();
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
  const R0 = 115;
  const REND = 640;
  const armSpan = new Map<string, { base: number; chord: number; s0: number; s1: number }>();
  const placeOnArms = (bins: string[][], chord: number): void => {
    const N = bins.length;
    bins.forEach((bin, arm) => {
      const base = (arm / N) * Math.PI * 2 + rand01(`c:arm${arm}`) * 0.16;
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
        armSpan.set(key, { base, chord, s0, s1 });
        // 簇心取弧段中点(标签/拾取用)
        const sm = (s0 + s1) / 2;
        const theta = base + sm * chord;
        const radius = R0 * Math.pow(REND / R0, sm); // 对数螺线:径向指数外推
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
    // ── 圆盘:簇按黄金角铺满整个盘面(不是环带、不是臂) ──
    // 黄金角 2.39996 rad 保证任意簇数下角向都不出现"扎堆/留空";半径按 √(i/N) 取,
    // 于是簇在**面积**上均匀——读作一张匀致实心的圆盘,而不是同心圆串。
    // 配合下面 disc 的等向散布,相邻簇边界互相咬合成一整片(混合盘)。
    const GA = Math.PI * (3 - Math.sqrt(5));
    groups.forEach((key, i) => {
      const theta = i * GA + rand01(`c:${key}`) * 0.35;
      const rr = Math.sqrt((i + 0.5) / total);
      const radius = 120 + rr * 520 + rand01(`r:${key}`) * 40;
      centers.set(key, {
        x: Math.cos(theta) * radius,
        y: (rand01(`r:${key}:y`) - 0.5) * 34,
        z: Math.sin(theta) * radius * 0.82,
      });
    });
  }
  if (shape === 'disk' && diskStyle === 'spiral') {
    // 六臂星系:6 臂共用同一扫掠 θ=base+s·1.55 → 任意半径处臂距恒为 2π/6=1.047 rad,
    // 永不交缠;1.55 rad 卷曲 ≈ 23° 螺旋角,是典型星系的放射-旋纹折中。
    placeOnArms(binPack(6), 1.55);
  }
  if (shape === 'disk' && diskStyle === 'legacy') {
    // 双臂螺旋:相位差 π、共用扫掠 1.55 rad → 两条分明旋臂,绝不并成一条
    placeOnArms(binPack(2), 1.55);
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
    groups.forEach((key, i) => {
      const jitter = rand01(`c:${key}`) * 0.5;
      const t8 = (i / total) * Math.PI * 2 + jitter;
      const A = 560 + rand01(`r:${key}`) * 80;
      centers.set(key, {
        x: Math.cos(t8) * A,
        y: (rand01(`r:${key}:y`) - 0.5) * 36,
        z: Math.sin(t8) * Math.cos(t8) * A * 0.72,
      });
    });
  }
  for (const n of nodes) {
    const gk = keyOf(n);
    if (shape === 'disk') {
      const span = armSpan.get(gk);
      if (span) {
        // 臂段分布:点在自己的弧段内独立取 s → 簇铺成弧,相邻簇首尾相接成连续星流带
        const { base, chord, s0, s1 } = span;
        // 半径均匀重采样:对数螺线下 dr/ds ∝ r 会把点堆在内圈;先均匀取 r 再反解 s,
        // 臂的每一段密度一致,整条臂才一路连续长到外沿。
        const K = REND / R0;
        const rr0 = R0 * Math.pow(K, s0);
        const rr1 = R0 * Math.pow(K, s1);
        const rt = rr0 + rand01(`s:${n.id}`) * (rr1 - rr0);
        const s = Math.log(rt / R0) / Math.log(K);
        const radius = rt + (rand01(`a:${n.id}`) - 0.5) * 2 * (12 + 22 * (s1 - s0));
        const theta = base + s * chord + (rand01(`b:${n.id}`) - 0.5) * (0.02 + 0.06 * (s1 - s0));
        out.set(n.id, {
          x: Math.cos(theta) * radius,
          y: (rand01(`s:${n.id}:y`) - 0.5) * 34,
          z: Math.sin(theta) * radius * 0.82,
        });
      } else {
        // 圆盘/平铺:簇心团块散布。disc 的散布更大且更扁 → 相邻簇边界咬合成一整片圆盘(混合观感);
        // flat 保持小块状,好让"平铺环带"的层次读得出来。
        const c = centers.get(gk) ?? { x: 0, y: 0, z: 0 };
        const a = rand01(`a:${n.id}`) * Math.PI * 2;
        const b = Math.acos(2 * rand01(`b:${n.id}`) - 1);
        const discMode = diskStyle === 'disc';
        // disc 用 sqrt 分布(面积均匀,盘内密度一致、外沿收得干净);flat 保持小块状。
        // disc:散布半径 ∝ 盘面/√N(每簇应占的等效面积半径)×1.7——相邻簇边界互相咬合,
        // 整张盘读作连成一片的混合圆盘;平铺保持小块状以保留环带层次。
        const discSpread = discMode ? (520 / Math.sqrt(Math.max(1, total))) * 1.7 : 0;
        const rr2 = discMode
          ? Math.sqrt(rand01(`s:${n.id}`)) * discSpread
          : 16 + Math.pow(rand01(`s:${n.id}`), 0.65) * 90;
        let px2 = c.x + Math.sin(b) * Math.cos(a) * rr2;
        let pz2 = c.z + Math.sin(b) * Math.sin(a) * rr2;
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
      // lemniscate:簇心沿 ∞ 曲线,簇内环向散布 + 法向薄层
      const c = centers.get(gk) ?? { x: 0, y: 0, z: 0 };
      const a = rand01(`a:${n.id}`) * Math.PI * 2;
      const b = Math.acos(2 * rand01(`b:${n.id}`) - 1);
      const rr = 16 + Math.pow(rand01(`s:${n.id}`), 0.65) * 120;
      const len = Math.hypot(c.x, c.z) || 1;
      const tx = -c.z / len;
      const tz = c.x / len;
      const ring = Math.sin(b) * Math.cos(a) * rr;
      const cross = Math.sin(b) * Math.sin(a) * rr * 0.6;
      out.set(n.id, {
        x: c.x + tx * ring + (c.x / len) * cross,
        y: c.y + (rand01(`s:${n.id}:y`) - 0.5) * 52,
        z: c.z + tz * ring + (c.z / len) * cross,
      });
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
export type FlowStyle = 'spin' | 'eight';

/**
 * 形态动画帧变换（炫技档）。样式与形态解耦——任意盘/环都可选自转或 8 字流：
 * - spin: 差速自转（内圈快外圈慢，星系感的关键），对 disk/lemniscate 通用；
 * - eight: 真 8 字轨道流（点沿 ∞ 曲线 x=A·cosφ / z=A·sinφ·cosφ 连续推进），对任意形态通用。
 * 纯几何驱动，只吃 (t, 布局, 参数)，不含状态 → 同一 t 必得同一帧（可回放）。
 */
export function flowShape(
  base: ReadonlyMap<string, Vec3>,
  t: number,
  shape: ClusterShape,
  speed = 1,
  amp = 1,
  flowStyle?: FlowStyle,
): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  if (shape === 'sphere') return out; // 球面堆不流转(调用方直接跳过)
  const style: FlowStyle = flowStyle ?? (shape === 'lemniscate' ? 'eight' : 'spin');
  // 统一时相:ts = t × speed。speed=0 时整体冻结(含幅度摆动),调速度也不会让相位跳。
  const ts = t * speed;
  for (const id of base.keys()) {
    const p = base.get(id)!;
    if (style === 'spin') {
      // **刚体自转**:全盘同一角速度(与半径无关)。这是星臂不变形的唯一前提——
      // 差速旋转(内快外慢)会让任意螺旋臂随 t 无限剪切,转一会儿就缠绕成一团。
      // t 由调用方按 ∫speed·dt 累加,故改速度时相位连续。
      const a = 0.10 * 0.0167 * ts; // rad
      const cy = Math.cos(a); const sy = Math.sin(a);
      // 幅度:整体**径向呼吸**(角向相位差 → 星臂像在轻微伸展,±7% 半径脉动),
      // 加垂直波。有界、不累积 → 不会破坏"臂不缠绕"的前提。
      const ang = Math.atan2(p.z, p.x);
      const pulse = amp > 0 ? 1 + Math.sin(ts * 0.0006 + ang * 2) * 0.22 * amp : 1;
      const breathe = amp > 0 ? Math.sin(ts * 0.0009 + ang * 3) * 26 * amp : 0;
      out.set(id, {
        x: (p.x * cy - p.z * sy) * pulse,
        y: p.y + breathe,
        z: (p.x * sy + p.z * cy) * pulse,
      });
    } else {
      // 8 字真轨道流:反解每点固有轨道相位 φ0,φ = φ0 + om·t 沿 ∞ 曲线推进。
      const om = ts / 20000;
      const off = (rand01('f:' + id) - 0.5) * 0.6; // 点级小偏移,带子错落
      const r0 = Math.hypot(p.x, p.z) || 1;
      const ct = Math.max(-1, Math.min(1, p.x / r0));
      let t8 = Math.acos(ct);
      if (Math.sin(t8) * Math.cos(t8) * (p.z / r0) < 0) t8 = Math.PI * 2 - t8;
      const ph = t8 + om + off;
      // 幅度:放大 A 的个体差(整条星尘带的径向厚度),并放大点级游走
      const jit = (rand01('j:' + id) - 0.5) * (0.06 + 0.9 * amp);
      // 反解 A 时夹到 2.2×r0 上限——否则贴 z 轴的点(|cos|≈0)会算出巨大 A 飞出画面
      const A = Math.min(r0 * 2.2, r0 / Math.max(0.18, Math.abs(Math.cos(t8)) + Math.abs(Math.sin(t8) * Math.cos(t8)))) * (1 + jit);
      const x = Math.cos(ph) * A;
      const z = Math.sin(ph) * Math.cos(ph) * A;
      const wob = 6 + 70 * amp; // 幅度 0→6(几乎不动),2→146(明显荡漾)
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
