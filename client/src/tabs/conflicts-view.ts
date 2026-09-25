/**
 * 冲突面板的**纯呈现逻辑**（无 JSX / 无 React）。
 *
 * 抽出来的理由与 Phase 3 把额度判据抽成纯函数相同：分段与文案是判据，
 * 藏在组件里就只能靠肉眼复核（本项目没有 React 组件测试夹具）。
 */
import type { ConflictPairView } from '../../../src/contract.js';

// ── 类型 ──

export type ConflictTypeView = 'hard' | 'conditional' | 'supersession';

// ── 三类分段定义 ──

/** 三类分段的固定顺序 + 人话标签。顺序不可更改——hard 是唯一占额度的，必须置顶。 */
export const CONFLICT_TYPE_SECTIONS: ReadonlyArray<{
  type: ConflictTypeView;
  label: string;
  hint: string;
}> = [
  {
    type: 'hard',
    label: '硬冲突（占额度）',
    hint: '事实层面直接互斥——两边不可能同时为真，必须由人给出结论。',
  },
  {
    type: 'conditional',
    label: '条件冲突（不占额度）',
    hint: '各自前提不同才显得矛盾（环境/配置/工作区）；先确认前提是否还成立。',
  },
  {
    type: 'supersession',
    label: '新旧取代（不占额度）',
    hint: '线索指向新的更可信、旧的应让位——但机器不自动裁决，仍由人确认。',
  },
];

// ── 纯函数 ──

/** 从 `conflict_type` 字段安全提取类型（缺值/未知值兜底为 'hard'）。 */
export function conflictTypeOf(p: ConflictPairView): ConflictTypeView {
  const t = p.conflict_type;
  return t === 'conditional' || t === 'supersession' ? t : 'hard';
}

export interface ConflictSection {
  type: ConflictTypeView;
  label: string;
  hint: string;
  items: ConflictPairView[];
}

/**
 * 三类分段：只返回**非空**分段（空段是噪声），顺序固定为 hard → conditional → supersession。
 * 每个分段的 items 保持原数组顺序。
 */
export function groupConflictsByType(items: readonly ConflictPairView[]): ConflictSection[] {
  const buckets = new Map<ConflictTypeView, ConflictPairView[]>();
  for (const sec of CONFLICT_TYPE_SECTIONS) {
    buckets.set(sec.type, []);
  }
  for (const p of items) {
    const type = conflictTypeOf(p);
    const arr = buckets.get(type);
    if (arr) arr.push(p);
  }
  const result: ConflictSection[] = [];
  for (const sec of CONFLICT_TYPE_SECTIONS) {
    const arr = buckets.get(sec.type);
    if (arr && arr.length > 0) {
      result.push({ type: sec.type, label: sec.label, hint: sec.hint, items: arr });
    }
  }
  return result;
}

/** R1 复看状态文案：`unseen` → ''（不渲染，"没人看过"就是没有信息）；`deferred` → '已复看 N 次'。 */
export function reviewLabel(p: ConflictPairView): string {
  if ((p.review_state ?? 'unseen') === 'unseen') return '';
  return `已复看 ${String(p.defer_count ?? 0)} 次`;
}

/** R1: 是否被复看过。 */
export function isDeferred(p: ConflictPairView): boolean {
  return (p.review_state ?? 'unseen') === 'deferred';
}

// ── 三轴文案 ──

const D = (ms: number | null | undefined): string =>
  ms == null ? '' : new Date(ms).toISOString().slice(0, 10);

/**
 * 三轴（有效期/持续性）的可读片段；全缺时返回 ''。
 * 注意：`noUncheckedIndexedAccess` 下数组下标是 `T | undefined`，
 * 但这里只操作对象属性（number | null | undefined），不受影响。
 */
export function axisText(p: ConflictPairView, side: 'winner' | 'loser'): string {
  const vf = side === 'winner' ? p.winner_valid_from_ms : p.loser_valid_from_ms;
  const vt = side === 'winner' ? p.winner_valid_to_ms : p.loser_valid_to_ms;
  const ps = side === 'winner' ? p.winner_persistence : p.loser_persistence;
  const parts: string[] = [];
  const vfS = D(vf);
  const vtS = D(vt);
  if (vfS) parts.push(`有效期起 ${vfS}`);
  if (vtS) parts.push(`有效期止 ${vtS}`);
  if (ps) parts.push(`持续性 ${ps}`);
  return parts.join(' / ');
}

/** claim 键展示文案：空键 → ''。 */
export function claimLabel(p: ConflictPairView): string {
  const k = p.claim_key;
  return k ? `claim ${k}` : '';
}
