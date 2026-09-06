/**
 * 预算键 'graph' 全链波及测试(评审 C 节坑①②的回归面):
 * - effectiveCfg 守卫漏 graph = 只配图谱预算时整个 budgets 子树被静默丢弃(坑①);
 * - layerKeyFor/resolveLayerTokens 把 graph 落进 l1 = 误用 L1 层链与放大档(坑②);
 * - settings-set 写入门白名单含 graph 键;LAYER_DEFAULT_BUDGETS.graph 默认值。
 */
import { describe, expect, it } from 'vitest';
import { LAYER_DEFAULT_BUDGETS, layerEffortTrigger, layerKeyFor, resolveLayerTokens } from '../src/llm.js';
import { effectiveCfg } from '../src/pipeline/runner.js';
import type { MemoryConfig, MemoryLiveSettings } from '../src/contract.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { LayerRouteCfgView } from '../src/llm.js';

function liveHandle(over: Partial<MemoryLiveSettings> = {}): LiveSettingsHandle {
  const s: MemoryLiveSettings = {
    enabled: true, capture: true, distill: true, recall: true,
    reasoningEffort: '', distillProvider: '', distillModel: '', distillChain: [],
    distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0, graph: 0 }, distillMaxInputChars: 0,
    distillLayerChains: { l1: [], l2: [], l3: [] }, distillMode: '', directBaseURL: '', directApiKey: '',
    embedRemoteBaseURL: '', embedRemoteApiKey: '', embedRemoteModel: '', embedRemoteDimensions: 0, memoryMutate: false,
    ...over,
  };
  return { supported: true, get: () => s, update: async (patch) => Object.assign(s, patch) };
}

function cfgView(over: Partial<NonNullable<LayerRouteCfgView['llm']>> = {}): LayerRouteCfgView {
  return { llm: { reasoningEffort: 'low', ...over } };
}

const base = {
  dataDir: '', family: 'auto',
  capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 },
  extract: { enabled: true, minMessages: 6, idleSeconds: 300, backgroundMessages: 10, candidatePool: 5 },
  l2: { enabled: true, minNewMemories: 5, maxScenes: 12, sceneContextLimit: 3 },
  l3: { enabled: true, interval: 20 },
  recall: { enabled: true, maxResults: 5, maxCharsPerMemory: 500, maxTotalRecallChars: 2000, timeoutMs: 5000, includePersona: true, includeSceneNav: true, strategy: 'hybrid', scoreThreshold: 0.3, decayHalfLifeDays: 30 },
  embedding: { enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 0, maxInputChars: 5000, timeoutMs: 10000, allowLocalModels: true, mirror: '', proxy: '' },
  llm: { provider: '', model: '', mode: 'host', baseURL: '', apiKey: '', maxTokens: 65536, reasoningEffort: '', maxInputChars: 700000, timeoutMs: 120000 },
  hall: { enabled: [] },
  tokenCost: { retentionDays: 365 },
  tools: true,
  benchControl: false,
} as unknown as MemoryConfig;

describe('graph 预算键:默认值与解析', () => {
  it('LAYER_DEFAULT_BUDGETS.graph = 8000(五键齐备)', () => {
    expect(LAYER_DEFAULT_BUDGETS.graph).toBe(8000);
    expect(Object.keys(LAYER_DEFAULT_BUDGETS).sort()).toEqual(['dedup', 'extract', 'graph', 'l2', 'l3']);
  });

  it('layerKeyFor:graph 显式返回 null,绝不落 l1;l1 两调用点同属 l1', () => {
    expect(layerKeyFor('graph')).toBeNull();
    expect(layerKeyFor('l1-extract')).toBe('l1');
    expect(layerKeyFor('l1-dedup')).toBe('l1');
    expect(layerKeyFor('l2')).toBe('l2');
    expect(layerKeyFor('l3')).toBe('l3');
  });

  it('resolveLayerTokens:graph 覆盖值生效,0 回默认,高档 ×4 放大照常', () => {
    expect(resolveLayerTokens(cfgView({ budgets: { graph: 5000 } }), 'graph')).toBe(5000);
    expect(resolveLayerTokens(cfgView(), 'graph')).toBe(8000);
    // 全局档位 high → ×4 放大(graph 恒走全局候选)
    expect(resolveLayerTokens(cfgView({ reasoningEffort: 'high', budgets: { graph: 5000 } }), 'graph')).toBe(20_000);
  });

  it('坑②回归:配了 l1 层链(max 档)时 graph 不继承该链,走全局档位', () => {
    const cfg = cfgView({
      reasoningEffort: 'low',
      layerRoutes: { l1: [{ provider: 'p', model: 'm', reasoningEffort: 'max' }] },
    });
    // l1 层:放大触发档 = 层链头 max → ×4;graph 层:全局 low → 不放大
    expect(layerEffortTrigger(cfg, 'l1')).toBe('max');
    expect(layerEffortTrigger(cfg, null)).toBe('low');
    expect(resolveLayerTokens(cfg, 'graph')).toBe(8000);
    expect(resolveLayerTokens(cfg, 'extract')).toBe(16_000 * 4);
  });
});

describe('graph 预算键:effectiveCfg 守卫', () => {
  it('坑①回归:只配 graph 预算时 budgets 子树仍被注入(不再整体丢弃)', () => {
    const live = liveHandle({ distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0, graph: 9000 } });
    const eff = effectiveCfg(base, live);
    expect(eff.llm.budgets).toEqual({ graph: 9000 });
  });

  it('混合覆盖:l2 与 graph 同时注入;全 0 不注入(跟随内置默认)', () => {
    const live = liveHandle({ distillBudgets: { extract: 0, dedup: 0, l2: 100, l3: 0, graph: 9000 } });
    expect(effectiveCfg(base, live).llm.budgets).toEqual({ l2: 100, graph: 9000 });
    const liveZero = liveHandle();
    expect(effectiveCfg(base, liveZero).llm.budgets).toBeUndefined();
  });
});

describe('graph 预算键:settings-set 写入门', () => {
  it('graph 键随整组校验写入;非法值整组拒绝', async () => {
    // 轻量 harness:settings-set 只触 live 与 logger,stores 用最小桩
    const writes: Array<Partial<MemoryLiveSettings>> = [];
    const live = liveHandle();
    const wrapped: LiveSettingsHandle = { ...live, update: async (patch) => { writes.push(patch); await live.update(patch); } };
    let handler: ((endpoint: string, payload: unknown) => Promise<unknown>) | undefined;
    const ctx = {
      get: () => ({ rpc: { handle: (_e: string, h: typeof handler) => { handler = h; return async () => {}; } } }),
      on: () => () => {},
      effect: (fn: () => void) => fn(),
    } as unknown as Parameters<typeof import('../src/stats.js').registerMemoryRpc>[0];
    const { registerMemoryRpc } = await import('../src/stats.js');
    registerMemoryRpc(ctx, base, {} as never, { info: () => {}, warn: () => {}, error: () => {} }, undefined, wrapped);
    const call = async (payload: unknown): Promise<unknown> => (await handler!('dsh-memory/settings-set', payload)) as unknown;

    await call({ distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0, graph: 1234 } });
    expect(wrapped.get().distillBudgets.graph).toBe(1234);

    // 写入门拒绝走 RPC 错误信封(ok:false),不落半写
    const rejected = (await call({ distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0, graph: -1 } })) as {
      ok: boolean;
      error?: { message: string };
    };
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.message).toContain('graph');
    expect(wrapped.get().distillBudgets.graph).toBe(1234);
  });
});
