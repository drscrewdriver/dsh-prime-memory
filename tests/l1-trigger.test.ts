/**
 * L1 蒸馏触发决策纯函数测试(trigger.ts 决策表)+ 抽取分块纯函数。
 */
import { describe, expect, it } from 'vitest';
import {
  advanceWarmupThreshold,
  effectiveExtractThreshold,
  extractionBackoffMs,
  idleSessionsToFlush,
  modeSwitchAction,
  pickSessionBackground,
} from '../src/pipeline/trigger.js';
import { chunkByCharBudget } from '../src/pipeline/l1.js';
import type { ConversationMessage } from '../src/types.js';

describe('warmup ramp (ADR-0003 渐进阈值)', () => {
  it('effective threshold: min(ramp, steady); graduated uses steady', () => {
    expect(effectiveExtractThreshold(1, 6)).toBe(1);
    expect(effectiveExtractThreshold(4, 6)).toBe(4);
    expect(effectiveExtractThreshold(8, 6)).toBe(6);
    expect(effectiveExtractThreshold(0, 6)).toBe(6); // 0 = 毕业
    expect(effectiveExtractThreshold(Number.NaN, 6)).toBe(6);
  });

  it('advance doubles and graduates at steady; graduated stays 0', () => {
    expect(advanceWarmupThreshold(1, 8)).toBe(2);
    expect(advanceWarmupThreshold(2, 8)).toBe(4);
    expect(advanceWarmupThreshold(4, 8)).toBe(8 >= 8 ? 0 : 8); // 达稳态毕业
    expect(advanceWarmupThreshold(0, 8)).toBe(0);
    expect(advanceWarmupThreshold(Number.NaN, 8)).toBe(0);
  });
});

describe('mode switch action table', () => {
  it('flush between non-off modes, park to off, unpark from off', () => {
    expect(modeSwitchAction('auto', 'chat')).toBe('flush');
    expect(modeSwitchAction('chat', 'work')).toBe('flush');
    expect(modeSwitchAction('work', 'off')).toBe('park');
    expect(modeSwitchAction('off', 'chat')).toBe('unpark');
    expect(modeSwitchAction('chat', 'chat')).toBe('none');
  });
});

describe('session background picking', () => {
  it('excludes slice members and takes the tail n', () => {
    const recent = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }];
    const out = pickSessionBackground(recent, new Set(['3', '2']), 2);
    expect(out.map((m) => m.id)).toEqual(['1', '4']);
    expect(pickSessionBackground(recent, new Set(), 0)).toEqual([]);
  });
});

describe('extraction failure backoff', () => {
  it('doubles from 60s and caps at 30min', () => {
    expect(extractionBackoffMs(0)).toBe(60_000);
    expect(extractionBackoffMs(1)).toBe(60_000);
    expect(extractionBackoffMs(2)).toBe(120_000);
    expect(extractionBackoffMs(3)).toBe(240_000);
    expect(extractionBackoffMs(20)).toBe(30 * 60_000);
    expect(extractionBackoffMs(Number.NaN)).toBe(60_000);
  });
});

describe('idle flush scan', () => {
  it('selects silent sessions with slices; skips off-mode and zero-count', () => {
    const now = 1_000_000;
    const slices = [
      { sessionId: 'a', count: 3, lastMessageAt: now - 500 },
      { sessionId: 'b', count: 1, lastMessageAt: now - 999_999 },
      { sessionId: 'c', count: 2, lastMessageAt: now - 10 },
      { sessionId: 'd', count: 1, lastMessageAt: now - 999_999 },
      { sessionId: 'e', count: 0, lastMessageAt: now - 999_999 },
    ];
    const activity = new Map([['a', now - 10]]); // 运行时记录优先
    const out = idleSessionsToFlush(slices, activity, now, 400, (sid) => sid === 'd');
    expect(out).toEqual(['b']); // a 有新活动;c 未达标;d 是 off 档
    expect(idleSessionsToFlush(slices, activity, now, 0, () => false)).toEqual([]); // 0 = 关闭
  });
});

describe('chunkByCharBudget', () => {
  it('splits by char budget keeping order; oversized message owns a chunk', () => {
    const msg = (id: string, len: number): ConversationMessage => ({ id, role: 'user', content: 'x'.repeat(len), timestamp: 0 });
    const messages = [msg('a', 100), msg('b', 50), msg('c', 300), msg('d', 20)];
    const chunks = chunkByCharBudget(messages, 400);
    expect(chunks.map((c) => c.map((m) => m.id).join(','))).toEqual(['a,b', 'c', 'd']);
    expect(chunkByCharBudget([], 100)).toEqual([]);
  });
});
