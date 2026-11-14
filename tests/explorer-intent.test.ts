/**
 * 记忆库跳转意图：单调 token / 取走即清空 / 订阅退订 / 最新覆盖。
 *
 * 这是跨 bundle 深链在 prime 侧的半条命：侧栏只负责发事件，真正驱动面板的是
 * 这份模块级意图。它在 node 下可纯测，不需要 DOM。
 */
import { describe, expect, it } from 'vitest';
import { explorerIntent } from '../client/src/explorer/intent.js';
import type { ExplorerIntentRequest } from '../client/src/explorer/intent.js';

describe('explorerIntent', () => {
  it('request 返回单调 token，take 取走即清空', () => {
    // 同一模块单例：先清掉可能残留的 pending。
    explorerIntent.take();
    const first = explorerIntent.request({ mode: 'entry' });
    expect(first).toBeGreaterThan(0);
    expect(explorerIntent.take()?.intent).toEqual({ mode: 'entry' });
    expect(explorerIntent.take()).toBeUndefined();
  });

  it('连续请求：token 递增，take 只得到最新一条', () => {
    explorerIntent.take();
    const a = explorerIntent.request({ mode: '2d' });
    const b = explorerIntent.request({ mode: '3d', recordId: 'mem_x' });
    expect(b).toBeGreaterThan(a);
    const pending = explorerIntent.take();
    expect(pending?.token).toBe(b);
    expect(pending?.intent).toEqual({ mode: '3d', recordId: 'mem_x' });
  });

  it('订阅者即时收到请求；退订后不再收到', () => {
    explorerIntent.take();
    const seen: ExplorerIntentRequest[] = [];
    const off = explorerIntent.subscribe((request) => { seen.push(request); });
    explorerIntent.request({ mode: '2d' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.intent.mode).toBe('2d');
    off();
    explorerIntent.request({ mode: '3d' });
    expect(seen).toHaveLength(1);
    explorerIntent.take();
  });
});
