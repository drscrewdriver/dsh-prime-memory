/**
 * conflicts-view.ts 纯函数单测（遵循 dimensions.test.ts 先例：client/src 纯模块可由 vitest 直接导入）。
 *
 * 测什么：分段、复看文案、三轴文案、claim 键文案、类型兜底。
 * 不测什么：React 组件渲染（本项目无组件测试夹具）。
 */
import { describe, it, expect } from 'vitest';
import {
  conflictTypeOf,
  groupConflictsByType,
  reviewLabel,
  isDeferred,
  axisText,
  claimLabel,
  CONFLICT_TYPE_SECTIONS,
} from '../client/src/tabs/conflicts-view.js';
import type { ConflictPairView } from '../src/contract.js';

// ── 测试夹具 ──

function mkPair(overrides: Partial<ConflictPairView> = {}): ConflictPairView {
  return {
    pair_id: 'pair-001',
    run_id: 'run-001',
    winner_id: 'w1',
    winner_content: 'winner content',
    loser_id: 'l1',
    loser_content: 'loser content',
    created_at: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

// ── conflictTypeOf ──

describe('conflictTypeOf', () => {
  it('returns "hard" for undefined conflict_type (default)', () => {
    expect(conflictTypeOf(mkPair())).toBe('hard');
  });
  it('returns "hard" for explicit "hard"', () => {
    expect(conflictTypeOf(mkPair({ conflict_type: 'hard' }))).toBe('hard');
  });
  it('returns "conditional"', () => {
    expect(conflictTypeOf(mkPair({ conflict_type: 'conditional' }))).toBe('conditional');
  });
  it('returns "supersession"', () => {
    expect(conflictTypeOf(mkPair({ conflict_type: 'supersession' }))).toBe('supersession');
  });
});

// ── groupConflictsByType ──

describe('groupConflictsByType', () => {
  it('returns empty array for empty input', () => {
    expect(groupConflictsByType([])).toEqual([]);
  });

  it('groups items by type with fixed section order (hard → conditional → supersession)', () => {
    const items = [
      mkPair({ pair_id: 'p1', conflict_type: 'supersession' }),
      mkPair({ pair_id: 'p2', conflict_type: 'hard' }),
      mkPair({ pair_id: 'p3', conflict_type: 'conditional' }),
      mkPair({ pair_id: 'p4', conflict_type: 'hard' }),
    ];
    const sections = groupConflictsByType(items);
    expect(sections).toHaveLength(3);
    expect(sections[0]!.type).toBe('hard');
    expect(sections[0]!.items).toHaveLength(2);
    expect(sections[0]!.items[0]!.pair_id).toBe('p2');
    expect(sections[0]!.items[1]!.pair_id).toBe('p4');
    expect(sections[1]!.type).toBe('conditional');
    expect(sections[1]!.items).toHaveLength(1);
    expect(sections[1]!.items[0]!.pair_id).toBe('p3');
    expect(sections[2]!.type).toBe('supersession');
    expect(sections[2]!.items).toHaveLength(1);
    expect(sections[2]!.items[0]!.pair_id).toBe('p1');
  });

  it('omits empty sections', () => {
    const items = [
      mkPair({ pair_id: 'p1', conflict_type: 'conditional' }),
    ];
    const sections = groupConflictsByType(items);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.type).toBe('conditional');
  });

  it('preserves insertion order within each section', () => {
    const items = [
      mkPair({ pair_id: 'p-a', conflict_type: 'hard' }),
      mkPair({ pair_id: 'p-b', conflict_type: 'hard' }),
      mkPair({ pair_id: 'p-c', conflict_type: 'hard' }),
    ];
    const sections = groupConflictsByType(items);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.items.map((p) => p.pair_id)).toEqual(['p-a', 'p-b', 'p-c']);
  });

  it('treats missing conflict_type as "hard"', () => {
    const items = [
      mkPair({ pair_id: 'p1' }),  // no conflict_type → 'hard'
      mkPair({ pair_id: 'p2', conflict_type: 'hard' }),
    ];
    const sections = groupConflictsByType(items);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.type).toBe('hard');
    expect(sections[0]!.items).toHaveLength(2);
  });

  it('each section has label and hint from CONFLICT_TYPE_SECTIONS', () => {
    const items = [
      mkPair({ conflict_type: 'hard' }),
      mkPair({ conflict_type: 'conditional' }),
      mkPair({ conflict_type: 'supersession' }),
    ];
    const sections = groupConflictsByType(items);
    for (const sec of sections) {
      const def = CONFLICT_TYPE_SECTIONS.find((s) => s.type === sec.type);
      expect(def).toBeDefined();
      expect(sec.label).toBe(def!.label);
      expect(sec.hint).toBe(def!.hint);
    }
  });
});

// ── reviewLabel / isDeferred ──

describe('reviewLabel', () => {
  it('returns empty string for unseen (default)', () => {
    expect(reviewLabel(mkPair())).toBe('');
  });
  it('returns empty string for explicit unseen', () => {
    expect(reviewLabel(mkPair({ review_state: 'unseen' }))).toBe('');
  });
  it('returns "已复看 0 次" for deferred with defer_count 0', () => {
    expect(reviewLabel(mkPair({ review_state: 'deferred', defer_count: 0 }))).toBe('已复看 0 次');
  });
  it('returns "已复看 3 次" for deferred with defer_count 3', () => {
    expect(reviewLabel(mkPair({ review_state: 'deferred', defer_count: 3 }))).toBe('已复看 3 次');
  });
});

describe('isDeferred', () => {
  it('returns false for unseen', () => {
    expect(isDeferred(mkPair())).toBe(false);
    expect(isDeferred(mkPair({ review_state: 'unseen' }))).toBe(false);
  });
  it('returns true for deferred', () => {
    expect(isDeferred(mkPair({ review_state: 'deferred' }))).toBe(true);
  });
});

// ── axisText ──

describe('axisText', () => {
  it('returns empty string when all fields are null/undefined', () => {
    expect(axisText(mkPair(), 'winner')).toBe('');
    expect(axisText(mkPair(), 'loser')).toBe('');
  });

  it('formats validFrom only', () => {
    const p = mkPair({ winner_valid_from_ms: 1700000000000 });
    const t = axisText(p, 'winner');
    expect(t).toContain('有效期起');
    expect(t).toContain('2023-11-14'); // 1700000000000 ms → 2023-11-14T22:13:20.000Z → 2023-11-14 in UTC
  });

  it('formats validTo only', () => {
    const p = mkPair({ loser_valid_to_ms: 1700000000000 });
    const t = axisText(p, 'loser');
    expect(t).toContain('有效期止');
  });

  it('formats persistence only', () => {
    const p = mkPair({ winner_persistence: 'o' });
    expect(axisText(p, 'winner')).toBe('持续性 o');
  });

  it('formats all three fields with " / " separator', () => {
    const p = mkPair({
      winner_valid_from_ms: 1700000000000,
      winner_valid_to_ms: 1800000000000,
      winner_persistence: 't',
    });
    const t = axisText(p, 'winner');
    expect(t).toContain('有效期起');
    expect(t).toContain('有效期止');
    expect(t).toContain('持续性 t');
    expect(t).toContain(' / ');
  });

  it('does not leak loser fields when querying winner side', () => {
    const p = mkPair({
      winner_valid_from_ms: 1700000000000,
      loser_valid_from_ms: 1800000000000,
    });
    const wt = axisText(p, 'winner');
    const lt = axisText(p, 'loser');
    expect(wt).toContain('2023');
    expect(lt).toContain('2027');
  });
});

// ── claimLabel ──

describe('claimLabel', () => {
  it('returns empty string for empty claim_key', () => {
    expect(claimLabel(mkPair())).toBe('');
    expect(claimLabel(mkPair({ claim_key: '' }))).toBe('');
  });
  it('returns "claim <key>" for non-empty claim_key', () => {
    expect(claimLabel(mkPair({ claim_key: 'location' }))).toBe('claim location');
  });
});
