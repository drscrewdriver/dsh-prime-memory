/**
 * L1 priority 归一单源契约（issue #19）。
 *
 * 钉住：负数夹到 0、超界夹到 100、小数 Math.round、非有限回落 fallback（默认 60）、
 * 字符串数字可解析、合法值逐字不变；`isDirtyPriority` 与 `clampPriority` 判定一致。
 */
import { describe, expect, it } from 'vitest';
import { clampPriority, isDirtyPriority, PRIORITY_DEFAULT } from '../src/util/priority.js';

describe('clampPriority', () => {
  it('边界内整数逐字不变', () => {
    expect(clampPriority(0)).toBe(0);
    expect(clampPriority(75)).toBe(75);
    expect(clampPriority(100)).toBe(100);
  });
  it('负数夹到 0、超界夹到 100', () => {
    expect(clampPriority(-1)).toBe(0);
    expect(clampPriority(-999)).toBe(0);
    expect(clampPriority(150)).toBe(100);
    expect(clampPriority(101)).toBe(100);
  });
  it('小数四舍五入', () => {
    expect(clampPriority(72.6)).toBe(73);
    expect(clampPriority(72.4)).toBe(72);
    expect(clampPriority(72.5)).toBe(73);
  });
  it('非有限值回落默认（fallback 形参保留各写点既有缺省）', () => {
    expect(clampPriority(NaN)).toBe(PRIORITY_DEFAULT);
    expect(clampPriority(Infinity)).toBe(PRIORITY_DEFAULT);
    expect(clampPriority(undefined)).toBe(PRIORITY_DEFAULT);
    expect(clampPriority(null)).toBe(PRIORITY_DEFAULT);
    expect(clampPriority('x')).toBe(PRIORITY_DEFAULT);
    expect(clampPriority(undefined, 50)).toBe(50);
  });
  it('字符串数字可解析并夹取', () => {
    expect(clampPriority('80')).toBe(80);
    expect(clampPriority('-3')).toBe(0);
    expect(clampPriority('200')).toBe(100);
  });
});

describe('isDirtyPriority', () => {
  it('合法整数不误判', () => {
    expect(isDirtyPriority(0)).toBe(false);
    expect(isDirtyPriority(50)).toBe(false);
    expect(isDirtyPriority(100)).toBe(false);
  });
  it('负 / 超界 / 小数 / 非有限判脏', () => {
    expect(isDirtyPriority(-1)).toBe(true);
    expect(isDirtyPriority(150)).toBe(true);
    expect(isDirtyPriority(72.5)).toBe(true);
    expect(isDirtyPriority(NaN)).toBe(true);
    expect(isDirtyPriority(undefined)).toBe(true);
  });
});
