/**
 * T0.2 判据:缺方法 → 装配期拒绝注册。
 *
 * 用**构造器造合法 mem0 实例再逐刀破坏**的手法,断言 `assertRuntime` 的每条
 * 拒绝分支:谎报能力、缺条件核方法、typeId 越界、scoreSemantics 谎报、重复 id。
 * 这些分支在 Phase 1 之后都是线上故障的形状(运行期才炸的 TypeError 会炸穿
 * pusher 批次循环),所以必须在装配期就以「拒绝注册」的形态钉死。
 */
import { describe, expect, it, vi } from 'vitest';
import { DriverContractError, ExtDriverRegistry, assertRuntime } from '../src/ext-memory/registry.js';
import { EXT_DRIVER_SPECS } from '../src/ext-memory/types.js';
import type { ExternalMemoryDriver } from '../src/ext-memory/types.js';

function mem0Like(overrides: Partial<ExternalMemoryDriver> = {}): ExternalMemoryDriver {
  const cap = EXT_DRIVER_SPECS.mem0.capabilities;
  return {
    id: 'mem0-main',
    typeId: 'mem0',
    capabilities: { ...cap },
    scoreSemantics: 'normalized-relevance',
    status: async () => ({ healthy: true }),
    search: async () => ({ hits: [], hasMore: false }),
    remember: async () => ({ completion: 'accepted' }),
    forget: async () => ({ completion: 'committed' }),
    list: async () => [],
    ...overrides,
  } as ExternalMemoryDriver;
}

describe('ext-memory registry(T0.2)', () => {
  it('合法实例通过校验并注册;enabled() 反映启用位', () => {
    const reg = new ExtDriverRegistry();
    const d = mem0Like();
    reg.register(d);
    expect(reg.size).toBe(1);
    expect(reg.get('mem0-main')).toBe(d);
    expect(reg.enabled()).toEqual([d]);
    reg.setEnabled('mem0-main', false);
    expect(reg.enabled()).toEqual([]);
    // 禁用 ≠ 删除:条目仍在(影子账可重放的前提)
    expect(reg.size).toBe(1);
  });

  it('缺声明要求的条件核方法 → DriverContractError,不注册', () => {
    const broken = mem0Like();
    delete (broken as { forget?: unknown }).forget;
    expect(() => assertRuntime(broken)).toThrow(DriverContractError);
    const reg = new ExtDriverRegistry();
    expect(() => reg.register(broken)).toThrow(/forget/);
    expect(reg.size).toBe(0);
  });

  it('谎报能力(与静态描述符不符)同样拒绝——乐观声明绕不过门禁', () => {
    const lying = mem0Like({
      capabilities: { ...EXT_DRIVER_SPECS.mem0.capabilities, graph: true },
    });
    expect(() => assertRuntime(lying)).toThrow(/graph/);
  });

  it('typeId 越界 / scoreSemantics 谎报 / 重复 id 各自拒绝', () => {
    expect(() => assertRuntime(mem0Like({ typeId: 'not-a-driver' as ExternalMemoryDriver['typeId'] }))).toThrow(/9 家清单/);
    expect(() => assertRuntime(mem0Like({ scoreSemantics: 'none' }))).toThrow(/scoreSemantics/);
    const reg = new ExtDriverRegistry();
    reg.register(mem0Like());
    expect(() => reg.register(mem0Like())).toThrow(/重复注册/);
  });

  it('disposeAll 逐实例 dispose(关池/终止子进程的挂载位),单个失败不阻断其余', async () => {
    const a = vi.fn();
    const b = vi.fn(() => {
      throw new Error('close boom');
    });
    const warn = vi.fn();
    const reg = new ExtDriverRegistry({ info: warn, warn, error: warn } as never);
    reg.register(mem0Like({ id: 'd1', dispose: a }));
    reg.register(mem0Like({ id: 'd2', dispose: b }));
    await reg.disposeAll();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(reg.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});

