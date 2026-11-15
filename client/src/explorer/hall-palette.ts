/**
 * hall(生活域八维)配色纯函数层——3D 记忆海 hall 视角的数据面。
 *
 * **零依赖纪律**(与 theme.ts 只 import memory-types.ts 同款):本文件不 import
 * 任何服务端模块——client bundle 不吃 `src/types.ts` 整条链。词表用本地字面量,
 * 与 `WING_CATALOG` 的一致性由 `tests/client-hall-palette.test.ts` 的防漂移钉
 * (逐项相等断言)兜住,漂移即测试红。
 *
 * 色彩纪律:颜色全部来自既有 `--dsh-mem-chart-1..8` 令牌(服务端不下发颜色,
 * 客户端按序号取令牌再 getComputedStyle 解实色),变异用 HSL——RGB 通道抖动
 * 会让色相漂移不可控,HSL 上色相/明度正交、幅度可解释(±18° 色相 / ±12% 明度)。
 */

/** 八维序:与服务端 WING_CATALOG 逐项一致(防漂移钉钉住;居家在健康之前,用户 2026-09-23 对调)。 */
export const HALL_ORDER = [
  'work',
  'relationships',
  'learning',
  'creative',
  'home',
  'health',
  'finance',
  'journey',
] as const;

/** 跨域兜底:无归属节点落此组(语义 = 跨域/未打标,不该抢眼)。 */
export const HALL_FALLBACK = 'general';

/** hall → 中文名兜底表(正常由服务端 wing-overview 下发 label,此处只兜底)。 */
export const HALL_LABELS: Record<string, string> = {
  work: '工作',
  relationships: '人际',
  learning: '学习',
  creative: '创作娱乐',
  home: '居家',
  health: '健康',
  finance: '财务',
  journey: '出行',
  general: '跨域',
};

/**
 * hall → 图表系列令牌。八维按序吃 chart-1..8;general 不占新位、复用 chart-8
 * (中性灰,语义上就是"跨域/无归属",默认不参与高亮也不抢眼——findings R4 定案)。
 */
export function defaultHallToken(hall: string): string {
  const i = (HALL_ORDER as readonly string[]).indexOf(hall);
  if (i >= 0) return `--dsh-mem-chart-${i + 1}`;
  return '--dsh-mem-chart-8';
}

/**
 * hall 星系色板(深空底优化)——3D hall 视角专用,不吃 chart 令牌。
 * 设计:等距色相环(210° 起步每 45°),统一 s≈68/l≈62(深底上鲜而不刺、八色亮度拉平,
 * 图表令牌组里 #8892a6 那种中性灰在新色板里只留给 general);跨域兜底沿用中性灰。
 * 变异层(variantOf)照常在这组基准色上做 HSL 抖动。
 */
export const HALL_GALAXY_COLORS: Record<string, string> = {
  work: '#638ee3',
  relationships: '#9863e3',
  learning: '#e363ce',
  creative: '#e3636e',
  home: '#e3b963',
  health: '#aee363',
  finance: '#63e378',
  journey: '#63e3d9',
  general: '#6b7480',
};

/** hall → 中文名(兜底表缺项回落 id 本身,不猜)。 */
export function hallLabel(hall: string): string {
  return HALL_LABELS[hall] ?? hall;
}

// ── HSL 色彩空间:往返必须逐字节稳定 ─────────────────────────────

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** #rgb/#rrggbb → HSL(h∈[0,360), s/l∈[0,100])。非法输入返 null(调用方回落令牌原色)。 */
export function hexToHsl(hex: string): Hsl | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let body = m[1]!;
  if (body.length === 3) body = body.split('').map((c) => c + c).join('');
  const r = parseInt(body.slice(0, 2), 16) / 255;
  const g = parseInt(body.slice(2, 4), 16) / 255;
  const b = parseInt(body.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

const byte = (v: number): string => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

/** HSL → #rrggbb(小写,与令牌实色同形;分量钳 [0,1] 不外溢)。 */
export function hslToHex(h: number, s: number, l: number): string {
  const ss = Math.min(100, Math.max(0, s)) / 100;
  const ll = Math.min(100, Math.max(0, l)) / 100;
  const hh = ((h % 360) + 360) % 360;
  if (ss === 0) {
    const v = byte(ll);
    return `#${v}${v}${v}`;
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const r = hueToRgb(p, q, hh / 360 + 1 / 3);
  const g = hueToRgb(p, q, hh / 360);
  const b = hueToRgb(p, q, hh / 360 - 1 / 3);
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

// ── 确定性变异 ──────────────────────────────────────────────────

/** FNV-1a 32bit(与 projection/graph-canvas-data 同式;本文件零依赖故自持一份,单测钉等价性)。 */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 色相抖动半幅(度):strength=1 时 ±18°。 */
const HUE_SPAN = 18;
/** 明度抖动半幅(%):strength=1 时 ±12%。 */
const LIGHT_SPAN = 12;

/**
 * 基准色上的确定性变异:色相与明度各由**独立双路散列**派生(hash32(id) 与
 * hash32(id+':l')——单路会让两者强相关,同批点呈一条斜色带)。
 * strength=0 时**逐字节返回原串**(不经过浮点转换,避免 #4d6bfe→#4d6bfd 尾差)。
 * 非法基准色(令牌解色失败的兜底色等)原样返回,不猜。
 */
export function variantOf(baseHex: string, id: string, strength: number): string {
  const k = Math.min(1, Math.max(0, strength));
  if (k === 0) return baseHex;
  const hsl = hexToHsl(baseHex);
  if (!hsl) return baseHex;
  const hueJitter = ((hash32(id) % 2000) / 1000 - 1) * HUE_SPAN * k;
  const lightJitter = ((hash32(id + ':l') % 2000) / 1000 - 1) * LIGHT_SPAN * k;
  return hslToHex(hsl.h + hueJitter, hsl.s, hsl.l + lightJitter);
}
