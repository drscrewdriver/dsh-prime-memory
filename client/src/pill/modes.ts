/**
 * 会话记忆档位控件（覆写滑轨）的档位词表与几何常量。
 * v5（wing 八边形）：`off` 移出滑轨、由 WingWheel 图形外的关闭闸承载；
 * 滑轨只剩"强制单族"覆写：日常 → 智能 → 工作，默认档"智能"居中。
 * 数组顺序即滑轨顺序（原红线已撤销——2026-09-19 用户授权替代），
 * 配置键沿用英文层 off/chat/work/auto（session-modes.json 键不变）。
 * 档位色是 CSS 变量引用（--dsh-mem-mode-*，Light/Dark 各一组值，
 * 由 theme.ts 注入的样式表定义），取值 = 灰 → 品牌蓝渐变阶。
 */
export interface ModeDef {
  key: string;
  label: string;
  color: string;
}

export const MODES: ModeDef[] = [
  { key: 'chat', label: '日常', color: 'var(--dsh-mem-mode-chat)' },
  { key: 'auto', label: '智能', color: 'var(--dsh-mem-mode-auto)' },
  { key: 'work', label: '工作', color: 'var(--dsh-mem-mode-work)' },
];

/** 滑轨几何（px）。TRACK_W 为默认宽度，调用方可传 `width` 覆盖以适配窄浮层。 */
export const TRACK_W = 200;
export const THUMB = 16;
export const RAIL_H = 22; // 粗滑轨高度 > 圆球直径（圆球被滑轨包裹）

/** 点阵粒子场档位参数（分档场强参考 DSH-Claude-Style-Reasoning-Slider，
 * 配色锁品牌蓝单色系）：density 越大点阵越密、alpha 亮度系数、wave 明暗水波纹、
 * tempo 闪烁节拍倍率。tier0（原关闭档）随 off 移出滑轨一并删除——
 * 覆写滑轨三档恒有场强，不再有"整层不画"的档位。 */
export const FIELD_TIERS = [
  { density: 0.34, alpha: 0.5, wave: 0, tempo: 1 }, // 日常：稀疏微光
  { density: 0.72, alpha: 1, wave: 1, tempo: 1.3 }, // 智能：满场最活跃
  { density: 0.55, alpha: 0.78, wave: 1, tempo: 1.15 }, // 工作：中强 + 水波纹
];

/** smoothstep（粒子场展开/揭示用的 ease 曲线）。 */
export function smStep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 档位定义查找；null/未知（首帧未加载）落默认档（智能）。 */
export function modeInfo(key: string | null | undefined): ModeDef {
  for (let i = 0; i < MODES.length; i++) if (MODES[i]!.key === key) return MODES[i]!;
  return MODES[1]!;
}

/** 面文用完整档名（附族注）。 */
export function modeLabel(key: string): string {
  if (key === 'auto') return '智能（双族）';
  if (key === 'chat') return '日常（个人）';
  if (key === 'work') return '工作（团队）';
  return '关闭';
}

/** 档位 → 滑轨序；未知键落默认档序（智能 = 1）。 */
export function modeIndex(key: string): number {
  for (let i = 0; i < MODES.length; i++) if (MODES[i]!.key === key) return i;
  return 1;
}
