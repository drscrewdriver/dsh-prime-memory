/**
 * 第 5 路融合与装配测(计划 T1.10/T1.11 判据的 provider 侧半边)。
 * 钉五条性质:
 * ① 多驱动并发全出:allSettled 语义,单家抛错不沉其余,失败家进熔断计数;
 * ② rank 交错确定性:跨家按 driverId 定序、名次轮转(不比 score);
 * ③ 跨家内容去重:归一化指纹相同只留一条;
 * ④ 族隔离:family 过滤的单族档请求整路空(auto 档才出);
 * ⑤ 熔断开路:连续失败达阈值后不再被调用,openMs 到期后半开恢复。
 * 装配半边:总闸关 = extLane undefined;非法 type warn 跳过;装配失败不拖垮其余。
 */
import { describe, expect, it, vi } from 'vitest';
import { makeExtLane, interleaveByRank, type ExtLaneConfig } from '../src/ext-memory/lane.js';
import { ExtDriverRegistry } from '../src/ext-memory/registry.js';
import { buildExtAssembly } from '../src/ext-memory/assembly.js';
import { EXT_DRIVER_SPECS } from '../src/ext-memory/types.js';
import type { ExternalHit, ExternalMemoryDriver, ExtSpace } from '../src/ext-memory/types.js';
import { memorySchema, readExtMemory } from '../src/config.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function hit(externalId: string, content: string, score = 0.5): ExternalHit {
  return { driverId: '', spaceId: '', externalId, content, score };
}

function fakeDriver(id: string, impl: Partial<ExternalMemoryDriver>): ExternalMemoryDriver {
  return {
    id,
    typeId: 'mem0',
    capabilities: EXT_DRIVER_SPECS.mem0.capabilities,
    scoreSemantics: 'normalized-relevance',
    status: async () => ({ healthy: true }),
    search: async () => ({ results: [], hasMore: false }),
    remember: async () => ({ completion: 'committed' }),
    forget: async () => ({ completion: 'committed' }),
    list: async () => [],
    ...impl,
  } as ExternalMemoryDriver;
}

const sp = (driverId: string): ExtSpace => ({ spaceId: `${driverId}:s`, driverId, externalId: 's', name: '', description: '' });

function laneWith(drivers: ExternalMemoryDriver[], over: Partial<ExtLaneConfig> = {}) {
  const registry = new ExtDriverRegistry();
  const spaces = new Map<string, ExtSpace[]>();
  for (const d of drivers) {
    registry.register(d);
    spaces.set(d.id, [sp(d.id)]);
  }
  const cfg: ExtLaneConfig = {
    maxItemsPerDriver: 10,
    requestTimeoutMs: 5000,
    maxContentChars: 4000,
    failureThreshold: 3,
    openMs: 300_000,
    ...over,
  };
  return makeExtLane({ registry, spacesOf: (id) => spaces.get(id) ?? [], cfg: () => cfg, logger: noopLogger });
}

describe('ext lane(T1.10)', () => {
  it('多家并发全出 + rank 交错(不比 score)+ ext: 前缀 id', async () => {
    const lane = laneWith([
      fakeDriver('a-mem0', { search: async () => ({ results: [hit('a1', '甲一', 0.99), hit('a2', '甲二')], hasMore: false }) }),
      fakeDriver('b-mem0', { search: async () => ({ results: [hit('b1', '乙一', 0.97)], hasMore: false }) }),
    ]);
    const hits = await lane.provider('部署', 10);
    // 交错序:a1,b1,a2(每家第1名先轮完再第2名)
    expect(hits.map((h) => h.id)).toEqual(['ext:a-mem0:a-mem0:s:a1', 'ext:b-mem0:b-mem0:s:b1', 'ext:a-mem0:a-mem0:s:a2']);
    expect(hits[0]!.type).toBe('external');
  });

  it('一家抛错不沉其余;失败家进熔断计数,成功家不受影响', async () => {
    const dead = fakeDriver('dead', { search: vi.fn(async () => { throw new Error('boom'); }) });
    const alive = fakeDriver('alive', { search: async () => ({ results: [hit('x', '内容')], hasMore: false }) });
    const lane = laneWith([dead, alive]);
    const hits = await lane.provider('q', 5);
    expect(hits.map((h) => h.externalId ?? h.id)).toEqual(['ext:alive:alive:s:x']);
    expect(lane.statusOf().find((s) => s.driverId === 'dead')!.failStreak).toBe(1);
    expect(lane.statusOf().find((s) => s.driverId === 'alive')!.failStreak).toBe(0);
  });

  it('跨家内容去重(归一化指纹)+ 单家贡献封顶 maxItemsPerDriver', async () => {
    const lane = laneWith([
      fakeDriver('a', { search: async () => ({ results: [hit('a1', '同一句话'), hit('a2', '第三句')], hasMore: false }) }),
      fakeDriver('b', { search: async () => ({ results: [hit('b1', '  同一句话  '), hit('b2', '另一句')], hasMore: false }) }),
    ], { maxItemsPerDriver: 2 });
    const hits = await lane.provider('q', 10);
    // b1 与 a1 归一化指纹相同(normContentKey 折叠空白)→ b 组去重后只剩 b2;
    // 交错去重后:a=[a1,a2], b=[b2] → rank0 先轮(a1,b2)再 rank1(a2)
    expect(hits.map((h) => h.id)).toEqual(['ext:a:a:s:a1', 'ext:b:b:s:b2', 'ext:a:a:s:a2']);
  });

  it('族隔离:family 过滤请求整路空;undefined(auto)照常出', async () => {
    const lane = laneWith([fakeDriver('a', { search: async () => ({ results: [hit('x', 'y')], hasMore: false }) })]);
    expect(await lane.provider('q', 5, { family: 'work' })).toEqual([]);
    expect((await lane.provider('q', 5, { family: undefined })).length).toBe(1);
  });

  it('熔断开路:连续失败达阈值后 search 不再被调用;openMs 到期后半开恢复', async () => {
    let ok = false;
    const flaky = fakeDriver('flaky', { search: vi.fn(async () => { if (!ok) throw new Error('down'); return { results: [hit('z', '恢复')], hasMore: false }; }) });
    const lane = laneWith([flaky], { failureThreshold: 2, openMs: 50 });
    await lane.provider('q', 5);
    await lane.provider('q', 5);
    expect(lane.statusOf()[0]!.circuit).toBe('open');
    const callsBefore = (flaky.search as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await lane.provider('q', 5); // 熔断期内不再调用
    expect((flaky.search as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsBefore);
    ok = true;
    await new Promise((r) => setTimeout(r, 70));
    const hits = await lane.provider('q', 5); // 半开:到期自然放行一次
    expect(hits.map((h) => h.id)).toEqual(['ext:flaky:flaky:s:z']);
    expect(lane.statusOf()[0]!.circuit).toBe('closed');
  });

  it('interleaveByRank 纯函数:driverId 定序稳定可复现', () => {
    const g = [
      { driverId: 'z', hits: [hit('z1', 'a'), hit('z2', 'b')] },
      { driverId: 'a', hits: [hit('a1', 'c')] },
    ];
    expect(interleaveByRank(g).map((x) => x.hit.externalId)).toEqual(['a1', 'z1', 'z2']);
  });
});

describe('ext assembly(T1.11)', () => {
  const baseCfg = () => memorySchema({}) as ReturnType<typeof memorySchema>;

  it('总闸关(默认):不装配、extLane undefined、probe 报未开启', async () => {
    const a = await buildExtAssembly({ cfg: baseCfg(), logger: noopLogger as never });
    expect(a.enabled).toBe(false);
    expect(a.extLane).toBeUndefined();
    expect(a.registry.size).toBe(0);
    await expect(a.probe('whatever')).resolves.toMatchObject({ healthy: false });
  });

  it('非法 type warn 跳过;端点缺配不炸装配(首用才报)', async () => {
    const cfg = baseCfg();
    // extMemory 节已标 volatile(解算结果是 `{ get }`);这里直接赋**值对象**，
    // 顺带走 readExtMemory 的老线兜底分支(无 .get() 当冻结快照读)。
    const base = readExtMemory(cfg.extMemory)!;
    cfg.extMemory = {
      ...base,
      enabled: true,
      drivers: [
        { id: 'good', type: 'mem0', enabled: true, endpoint: 'https://x.test', apiKey: '', space: '', extra: '' },
        { id: 'bad', type: 'nope', enabled: true, endpoint: '', apiKey: '', space: '', extra: '' },
      ],
    } as never;
    const warn = vi.fn();
    const a = await buildExtAssembly({ cfg, logger: { info: () => {}, warn, error: () => {} } as never });
    expect(a.enabled).toBe(true);
    expect(a.registry.size).toBe(1);
    expect(a.registry.get('good')).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nope'));
    expect(a.extLane).toBeTypeOf('function');
    await a.dispose();
  });
});
