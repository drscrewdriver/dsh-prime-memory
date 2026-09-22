/**
 * prime-memory-conflict-3axis:三轴(validFrom/validTo/persistence)注入 §C 矛盾冻结。
 *
 * 钉三件事:
 * ① 检测侧:`formatBatchConflictPrompt` 的候选池透传三轴字段;
 * ② 裁决侧:`listConflictPairs` 的视图带双方三轴,且渲染出对比;
 * ③ 零漂移:三轴判定条款仅在 conflictFreeze 开启时注入,关闭态 base 逐字不变。
 */
import { describe, expect, it } from 'vitest';
import {
  formatBatchConflictPrompt,
  getConflictDetectionSystemPrompt,
  type CandidateMatch,
} from '../src/prompts/l1-dedup.js';
import { listConflictPairs } from '../src/conflict-service.js';
import type { ConflictPair } from '../src/store/conflicts.js';
import type { ExtractedMemory, MemoryRecord } from '../src/types.js';

const T = 1_700_000_000_000;

function rec(
  id: string,
  content: string,
  axis?: Partial<Pick<MemoryRecord, 'validFrom' | 'validTo' | 'persistence'>>,
): MemoryRecord {
  return {
    id,
    content,
    type: 'episodic',
    priority: 50,
    scene_name: '日常',
    timestamps: [T],
    createdAt: T,
    updatedAt: T,
    version: 0,
    metadata: {},
    sessionId: 'default',
    family: 'chat',
    ...axis,
  };
}

describe('检测侧:候选池透传三轴(conflict-3axis)', () => {
  const matches: CandidateMatch[] = [
    {
      newMemory: {
        record_id: 'n1',
        content: '新',
        type: 'episodic',
        priority: 50,
        source_message_ids: [],
        metadata: {},
        scene_name: 's',
      } as ExtractedMemory & { record_id: string },
      candidates: [rec('c1', '旧', { validFrom: T + 1000, validTo: undefined, persistence: 'o' })],
    },
  ];

  it('formatBatchConflictPrompt 的候选池含 valid_from_ms / valid_to_ms / persistence', () => {
    const prompt = formatBatchConflictPrompt(matches);
    expect(prompt).toContain('"valid_from_ms"');
    expect(prompt).toContain('"valid_to_ms"');
    expect(prompt).toContain('"persistence"');
    // 候选记录带的值被正确透传
    expect(prompt).toContain(String(T + 1000));
  });

  it('关闭态 prompt 文案逐字不变(零漂移):不含三轴条款', () => {
    const off = getConflictDetectionSystemPrompt('auto', {});
    expect(off).not.toContain('三轴');
    expect(off).not.toContain('valid_from_ms');
  });

  it('开启态注入三轴判定条款', () => {
    const on = getConflictDetectionSystemPrompt('auto', { conflictFreeze: true });
    expect(on).toContain('三轴');
    expect(on).toContain('valid_from_ms');
    expect(on).toContain('persistence');
  });
});

describe('裁决侧:待裁决视图带三轴(conflict-3axis)', () => {
  const pair: ConflictPair = {
    pairId: 'pair-1',
    runId: 'run-1',
    winnerId: 'w-1',
    loserId: 'l-1',
    createdAt: new Date(T).toISOString(),
    resolvedAt: '',
    resolution: '',
  };
  function fakeL1(records: MemoryRecord[]) {
    return {
      listConflictPending: () => [pair],
      countConflictPendingUnresolved: () => 1,
      getByIds: (ids: string[]) => records.filter((r) => ids.includes(r.id)),
    };
  }

  it('视图带双方三轴,值正确透传', () => {
    const records = [
      rec('w-1', '胜方', { validFrom: T + 1000, validTo: T + 2000, persistence: 'o' }),
      rec('l-1', '败方', { validFrom: T, validTo: undefined, persistence: 's' }),
    ];
    const v = listConflictPairs({ l1: fakeL1(records), conflictFreezeEnabled: true });
    const it0 = v.items[0]!;
    expect(it0.winner_valid_from_ms).toBe(T + 1000);
    expect(it0.winner_valid_to_ms).toBe(T + 2000);
    expect(it0.winner_persistence).toBe('o');
    expect(it0.loser_valid_from_ms).toBe(T);
    expect(it0.loser_valid_to_ms).toBeNull();
    expect(it0.loser_persistence).toBe('s');
  });

  it('记录缺三轴 → 字段为 null,不报错', () => {
    const v = listConflictPairs({ l1: fakeL1([rec('w-1', 'A'), rec('l-1', 'B')]), conflictFreezeEnabled: true });
    const it0 = v.items[0]!;
    expect(it0.winner_valid_from_ms).toBeNull();
    expect(it0.winner_valid_to_ms).toBeNull();
    expect(it0.winner_persistence).toBeNull();
    expect(it0.loser_valid_from_ms).toBeNull();
    expect(it0.loser_valid_to_ms).toBeNull();
    expect(it0.loser_persistence).toBeNull();
  });
});
