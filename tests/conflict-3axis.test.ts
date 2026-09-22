/**
 * prime-memory-conflict-3axis:三轴(validFrom/validTo/persistence)注入 §C 矛盾冻结。
 *
 * 钉三件事:
 * ① 检测侧:`formatBatchConflictPrompt` 的候选池透传三轴字段;
 * ② 裁决侧:`listConflictPairs` 的视图带双方三轴,且渲染出对比;
 * ③ 零漂移:三轴判定条款仅在 conflictFreeze 开启时注入,关闭态 base 逐字不变。
 */
import { createHash } from 'node:crypto';
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

  /**
   * golden 锚(task_a.5):关闭态 user prompt 的 sha1 常量,取自**升级前**
   * `445c89f:src/prompts/l1-dedup.ts` 在同一夹具上的实跑输出(长度 513)。
   * 这是「关闭态零漂移」的机械护栏——三轴键若漏了门控,此断言必红。
   */
  const CLOSED_STATE_SHA1 = '249236e45a55be1c1c1c9cc553d5a85aa6872c4b';
  /** 开启态候选池的 sha1(同一夹具):与关闭态必须不同,防「门控写反/恒开」。 */
  const ENABLED_STATE_SHA1 = '179e2c477a39e32b8082e6564b0d3aba148f5f96';
  const sha1 = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex');

  it('关闭态候选池不含三轴键:user prompt 与改动前逐字节相同', () => {
    const off = formatBatchConflictPrompt(matches);
    expect(off).not.toContain('"valid_from_ms"');
    expect(off).not.toContain('"valid_to_ms"');
    expect(off).not.toContain('"persistence"');
    // 三轴取值本身也不得泄漏进关闭态 prompt
    expect(off).not.toContain(String(T + 1000));
    expect(sha1(off)).toBe(CLOSED_STATE_SHA1);
    // 显式 false 与省略 opts 等价(调用点按开关取值,两种写法都须零漂移)
    expect(sha1(formatBatchConflictPrompt(matches, { conflictFreeze: false }))).toBe(CLOSED_STATE_SHA1);
  });

  it('开启态候选池含三轴键且值正确透传', () => {
    const on = formatBatchConflictPrompt(matches, { conflictFreeze: true });
    expect(on).toContain('"valid_from_ms"');
    expect(on).toContain('"valid_to_ms"');
    expect(on).toContain('"persistence"');
    // 候选记录带的值被正确透传
    expect(on).toContain(String(T + 1000));
    expect(sha1(on)).toBe(ENABLED_STATE_SHA1);
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
