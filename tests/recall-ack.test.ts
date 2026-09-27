/**
 * Wave 3 测试(memorax-absorb):
 *  - §D recall-ack 两段式:pending 登记 → 日志回执确认才标记;超时降级;容量淘汰;
 *  - §D capture 回执顺序约束(P1-3):source.kind='plugin:memory' 的注入消息必须
 *    能确认(匹配置于 source.kind 过滤之前);
 *  - §E PostCompactionTracker:error 过滤 / 消费即清 / 容量淘汰。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { registerCapture } from '../src/hooks/capture.js';
import {
  confirmInjectionByMessageId,
  expirePendingInjections,
  PENDING_TIMEOUT_MS,
  pendingCount,
  registerPendingInjection,
  resetAckForTests,
  setInjectionMarker,
} from '../src/hooks/recall-ack.js';
import { PostCompactionTracker } from '../src/hooks/recall.js';
import type { MemoryConfig, MemoryLogger } from '../src/types.js';

beforeEach(() => resetAckForTests());

describe('§D recall-ack 两段式', () => {
  it('登记 → 确认:marker 收到 agentId+recordIds,条目移除', () => {
    const marked: Array<[string, string[]]> = [];
    setInjectionMarker((agentId, ids) => marked.push([agentId, ids]));
    registerPendingInjection('agent-1', 'msg-1', ['r1', 'r2']);
    expect(pendingCount()).toBe(1);
    expect(confirmInjectionByMessageId('msg-1')).toBe(true);
    expect(marked).toEqual([['agent-1', ['r1', 'r2']]]);
    expect(pendingCount()).toBe(0);
  });

  it('未确认且未超时 = 不标记(注入被宿主拒绝 → 下轮可重注)', () => {
    const marked: Array<[string, string[]]> = [];
    setInjectionMarker((agentId, ids) => marked.push([agentId, ids]));
    registerPendingInjection('agent-1', 'msg-1', ['r1']);
    const expired = expirePendingInjections(Date.now() + 1000);
    expect(expired).toBe(0);
    expect(marked).toHaveLength(0);
    expect(confirmInjectionByMessageId('msg-1')).toBe(true); // 仍然可被后续回执确认
  });

  it('超时降级:超时 pending 照旧标记并移除;正常确认时延窗口内不动', () => {
    const marked: Array<[string, string[]]> = [];
    setInjectionMarker((agentId, ids) => marked.push([agentId, ids]));
    const now = Date.now();
    registerPendingInjection('agent-1', 'msg-old', ['r1'], now - PENDING_TIMEOUT_MS - 1);
    registerPendingInjection('agent-2', 'msg-new', ['r2'], now);
    const expired = expirePendingInjections(now);
    expect(expired).toBe(1);
    expect(marked).toEqual([['agent-1', ['r1']]]);
    expect(pendingCount()).toBe(1); // msg-new 仍在等回执
  });

  it('容量上限 64:最旧被淘汰', () => {
    setInjectionMarker(() => {});
    for (let i = 0; i < 70; i++) registerPendingInjection('a', `m-${i}`, ['r']);
    expect(pendingCount()).toBe(64);
    expect(confirmInjectionByMessageId('m-0')).toBe(false); // 最旧已淘汰
    expect(confirmInjectionByMessageId('m-69')).toBe(true);
  });

  it('无 marker / 空 ids / 空 messageId 不炸', () => {
    expect(() => registerPendingInjection('a', '', ['r'])).not.toThrow();
    expect(() => registerPendingInjection('a', 'm', [])).not.toThrow();
    expect(() => registerPendingInjection('a', 'm2', ['r'])).not.toThrow();
    expect(confirmInjectionByMessageId('m2')).toBe(true); // marker 缺失 = 确认即丢弃,不抛
  });
});

describe('§D capture 回执顺序约束(P1-3)', () => {
  function harness() {
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const ctx = { on: (name: string, cb: (...args: never[]) => unknown) => handlers.set(name, cb) } as unknown as Context;
    const logger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as MemoryLogger;
    const l0 = {
      append: async () => {},
      maxCapturedTurn: () => undefined as number | undefined,
      hasAnyL0Message: () => false,
    };
    const modes = { get: () => 'off' }; // off 档:确认仍须发生(确认在 off 返回之前)
    const cfg = { capture: { enabled: true, maxMessageChars: 4000, redactSecrets: false } } as unknown as MemoryConfig;
    registerCapture(ctx, cfg, { enqueue: () => {} } as never, l0 as never, logger, { get: () => ({ enabled: true, capture: true }) } as never, modes as never);
    return handlers.get('session/event') as (session: unknown, event: SessionEvent) => void;
  }

  it('source.kind=plugin:memory 的注入消息可触发确认(置于过滤之前)', () => {
    const marked: Array<[string, string[]]> = [];
    setInjectionMarker((agentId, ids) => marked.push([agentId, ids]));
    registerPendingInjection('agent-9', 'inj-1', ['r9']);
    const onEvent = harness();
    // 注入消息事件:v4 署名 + 非用户来源——若匹配被放在 source.kind 过滤之后,这里收不到
    onEvent(
      { id: 's-x' },
      {
        type: 'user/message',
        seq: 1,
        time: Date.now(),
        data: { id: 'inj-1', role: 'user', content: [], source: { kind: 'plugin:memory', form: 'recall' } },
      } as unknown as SessionEvent,
    );
    expect(marked).toEqual([['agent-9', ['r9']]]);
  });

  it('off 档会话的回执也生效(确认先于 off 返回)', () => {
    const marked: Array<[string, string[]]> = [];
    setInjectionMarker((a, ids) => marked.push([a, ids]));
    registerPendingInjection('agent-off', 'inj-off', ['ro']);
    const onEvent = harness(); // harness 的 modes.get 恒 'off'
    onEvent(
      { id: 's-off' },
      { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'inj-off' } } as unknown as SessionEvent,
    );
    expect(marked).toEqual([['agent-off', ['ro']]]);
  });

  it('无关 user/message 不误确认', () => {
    const marked: Array<[string, string[]]> = [];
    setInjectionMarker((a, ids) => marked.push([a, ids]));
    registerPendingInjection('agent-1', 'inj-1', ['r1']);
    const onEvent = harness();
    onEvent(
      { id: 's-x' },
      { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'user-msg', source: { kind: 'user' } } } as unknown as SessionEvent,
    );
    expect(marked).toHaveLength(0);
    expect(pendingCount()).toBe(1);
  });
});

describe('§E PostCompactionTracker', () => {
  it('无 error 的 compaction/end 置标记;带 error 的不置', () => {
    const t = new PostCompactionTracker();
    expect(t.onCompactionEnd('s1', {})).toBe(true);
    expect(t.consume('s1')).toBe(true);
    expect(t.onCompactionEnd('s2', { error: 'boom' })).toBe(false);
    expect(t.consume('s2')).toBe(false);
  });

  it('消费即清(一次性增强)', () => {
    const t = new PostCompactionTracker();
    t.onCompactionEnd('s1', {});
    expect(t.consume('s1')).toBe(true);
    expect(t.consume('s1')).toBe(false);
  });

  it('容量淘汰最旧', () => {
    const t = new PostCompactionTracker(3);
    for (const s of ['a', 'b', 'c', 'd']) t.onCompactionEnd(s, {});
    expect(t.size).toBe(3);
    expect(t.consume('a')).toBe(false);
    expect(t.consume('d')).toBe(true);
  });

  it('重复压缩同一会话 = 置尾刷新,幂等消费一次', () => {
    const t = new PostCompactionTracker();
    t.onCompactionEnd('s1', {});
    t.onCompactionEnd('s1', {});
    expect(t.size).toBe(1);
    expect(t.consume('s1')).toBe(true);
    expect(t.consume('s1')).toBe(false);
  });
});
