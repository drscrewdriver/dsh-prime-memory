/**
 * TurnInjectGate 单测(issue #35)。
 *
 * 零 IO、零 mock:这个闸的全部逻辑就是"同 agent 同回合只放行一次 + 两种作废路径",
 * 把它测透比在 hook 层反复搭脚手架划算。
 */
import { describe, expect, it } from 'vitest';
import { TurnInjectGate } from '../src/hooks/turn-inject-gate.js';

describe('TurnInjectGate 基本语义', () => {
  it('同 agent 同回合:首次放行,后续拒绝', () => {
    const gate = new TurnInjectGate();
    expect(gate.claim('a', 1, 's')).toBe(true);
    expect(gate.claim('a', 1, 's')).toBe(false);
    expect(gate.claim('a', 1, 's')).toBe(false);
  });

  it('回合递增后重新放行', () => {
    const gate = new TurnInjectGate();
    expect(gate.claim('a', 1, 's')).toBe(true);
    expect(gate.claim('a', 2, 's')).toBe(true);
    expect(gate.claim('a', 2, 's')).toBe(false);
    expect(gate.claim('a', 3, 's')).toBe(true);
  });

  it('不同 agent 各算各的(子代理不互相遮蔽)', () => {
    const gate = new TurnInjectGate();
    expect(gate.claim('a', 1, 's')).toBe(true);
    expect(gate.claim('b', 1, 's')).toBe(true);
    expect(gate.claim('a', 1, 's')).toBe(false);
    expect(gate.claim('b', 1, 's')).toBe(false);
  });

  it('回合号回退(如宿主重置)视为新回合', () => {
    const gate = new TurnInjectGate();
    expect(gate.claim('a', 5, 's')).toBe(true);
    expect(gate.claim('a', 1, 's')).toBe(true);
  });
});

describe('TurnInjectGate 边界:拿不到回合号时放行(不劣于修复前)', () => {
  it('NaN / Infinity / undefined 一律放行', () => {
    const gate = new TurnInjectGate();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      expect(gate.claim('a', bad, 's')).toBe(true);
      expect(gate.claim('a', bad, 's')).toBe(true); // 不记账,故永远放行
    }
  });

  it('合法回合仍能正常去重(坏值不污染记账)', () => {
    const gate = new TurnInjectGate();
    expect(gate.claim('a', Number.NaN, 's')).toBe(true);
    expect(gate.claim('a', 1, 's')).toBe(true);
    expect(gate.claim('a', 1, 's')).toBe(false);
  });
});

describe('TurnInjectGate 作废路径', () => {
  it('invalidateSession 只清该会话,返回作废条数', () => {
    const gate = new TurnInjectGate();
    gate.claim('a1', 1, 's1');
    gate.claim('a2', 1, 's1');
    gate.claim('b1', 1, 's2');
    expect(gate.invalidateSession('s1')).toBe(2);
    expect(gate.claim('a1', 1, 's1')).toBe(true); // 已作废 → 同回合可重注
    expect(gate.claim('b1', 1, 's2')).toBe(false); // 另一会话不受影响
  });

  it('invalidateSession 无人在册时返回 0', () => {
    const gate = new TurnInjectGate();
    gate.claim('a', 1, 's1');
    expect(gate.invalidateSession('nope')).toBe(0);
    expect(gate.size).toBe(1);
  });

  it('reset 只清单个 agent', () => {
    const gate = new TurnInjectGate();
    gate.claim('a', 1, 's');
    gate.claim('b', 1, 's');
    gate.reset('a');
    expect(gate.claim('a', 1, 's')).toBe(true);
    expect(gate.claim('b', 1, 's')).toBe(false);
  });
});

describe('TurnInjectGate 容量', () => {
  it('超 cap 淘汰最旧(置尾刷新保证淘汰的是最久未活跃者)', () => {
    const gate = new TurnInjectGate(2);
    gate.claim('a', 1, 's');
    gate.claim('b', 1, 's');
    gate.claim('a', 2, 's'); // a 置尾刷新 → 淘汰顺序变为 b 在前
    gate.claim('c', 1, 's'); // 触发淘汰:b 被踢
    expect(gate.size).toBe(2);
    expect(gate.claim('a', 2, 's')).toBe(false); // a 仍在册且同回合(未被淘汰)
    expect(gate.claim('c', 1, 's')).toBe(false); // c 仍在册
    expect(gate.claim('b', 1, 's')).toBe(true); // b 已被淘汰 → 重新放行
  });

  it('cap 非法时至少为 1(不因 0 或负数退化成无去重)', () => {
    const zero = new TurnInjectGate(0);
    expect(zero.cap).toBe(1);
    expect(zero.claim('a', 1, 's')).toBe(true);
    expect(zero.claim('a', 1, 's')).toBe(false);
  });
});
