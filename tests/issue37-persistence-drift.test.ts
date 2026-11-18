/**
 * #37 诊断回归:开关重启后回落 → settings-get 必须给出「运行时 vs 持久化」对照。
 *
 * 背景:用户报三个 live 开关(高权限/技能结晶/知识图谱)重启后自动关。宿主装配链
 * (schemastery resolve + loader fiber)对 true patch 已静态验证保真——回落无法在
 * 插件侧静态复现。本测试钉住的是插件侧能做的确定性部分:
 * 1. settings-get 带 persistence 对照:readConfig 可用时逐键比对,drift 给明细;
 * 2. readConfig 不可用时显式 unavailable,不留猜测空间;
 * 3. resolveSettings 对非 boolean 形状的持久化值发诊断(写删门宁紧勿松,判值方向不变)。
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveSettings } from '../src/settings.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryLiveSettings } from '../src/contract.js';

function liveHandle(over: Partial<MemoryLiveSettings> = {}, readBack?: Record<string, unknown>): LiveSettingsHandle {
  const s = {
    enabled: true, capture: true, distill: true, recall: true,
    reasoningEffort: '', distillProvider: '', distillModel: '', distillChain: [],
    distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0, graph: 0 }, distillMaxInputChars: 0,
    distillLayerChains: { l1: [], l2: [], l3: [] }, distillMode: '', directBaseURL: '', directApiKey: '',
    embedRemoteBaseURL: '', embedRemoteApiKey: '', embedRemoteModel: '', embedRemoteDimensions: 0,
    memoryMutate: false, conflictFreeze: false, skillsEnabled: false, graphEnabled: false,
    ...over,
  } as MemoryLiveSettings;
  return {
    supported: true,
    get: () => s,
    update: async (patch) => { Object.assign(s, patch); },
    configWritable: true,
    updateConfig: async () => {},
    ...(readBack !== undefined ? { readConfig: (key: string) => (key === 'live' ? readBack : undefined) } : {}),
  };
}

/** 最小 cfg 桩:settings-get 读 cfg.llm.* / ceilings,形状对齐 rpc.test 的 cfg()。 */
function minCfg(): never {
  return {
    dataDir: '', family: 'auto',
    capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 },
    extract: { enabled: true, minMessages: 6, idleSeconds: 300, backgroundMessages: 10, candidatePool: 5 },
    l2: { enabled: true, minNewMemories: 5, maxScenes: 12, sceneContextLimit: 3 },
    l3: { enabled: true, interval: 20 },
    recall: { enabled: true, maxResults: 5, maxCharsPerMemory: 500, maxTotalRecallChars: 2000, timeoutMs: 5000, includePersona: true, includeSceneNav: true, strategy: 'hybrid', scoreThreshold: 0.3, decayHalfLifeDays: 30 },
    embedding: { enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 0, maxInputChars: 5000, timeoutMs: 10000, allowLocalModels: true, mirror: '', proxy: '' },
    llm: { provider: '', model: '', mode: 'host', baseURL: '', apiKey: '', maxTokens: 65536, reasoningEffort: '', maxInputChars: 700000, timeoutMs: 120000 },
    hall: { enabled: ['work'] },
    tokenCost: { retentionDays: 365 },
    tools: true,
    benchControl: false,
  } as never;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function deps(live: LiveSettingsHandle, logger = noopLogger): never {
  return {
    cfg: minCfg(), stores: {} as never, status: undefined, modes: undefined,
    dataDir: undefined, rebuild: undefined, ruminate: undefined, embedManager: undefined,
    sessionInfo: undefined, roomRegistry: undefined, memorySources: undefined,
    skillStore: undefined, skillProducer: undefined, extAssembly: undefined,
    live, logger,
  } as never;
}

describe('#37 settings-get 持久化对照诊断', () => {
  it('运行时与持久化不一致时返回 drift 并列出漂移键', async () => {
    const warn = vi.fn();
    const { handleEndpoint } = await import('../src/stats.js');
    const live = liveHandle(
      { memoryMutate: false, skillsEnabled: false, graphEnabled: false },
      { memoryMutate: true, skillsEnabled: true, graphEnabled: true },
    );
    const resp = await handleEndpoint('dsh-memory/settings-get', {}, deps(live, { info: () => {}, warn, error: () => {} })) as { persistence?: { state: string; detail?: string } };
    expect(resp.persistence?.state).toBe('drift');
    expect(resp.persistence?.detail).toContain('memoryMutate: 运行时=false / 持久化=true');
    expect(resp.persistence?.detail).toContain('skillsEnabled');
    expect(resp.persistence?.detail).toContain('graphEnabled');
    expect(warn).toHaveBeenCalled();
  });

  it('两层一致时返回 match', async () => {
    const { handleEndpoint } = await import('../src/stats.js');
    const live = liveHandle(
      { memoryMutate: true, skillsEnabled: true, graphEnabled: true },
      { memoryMutate: true, skillsEnabled: true, graphEnabled: true },
    );
    const resp = await handleEndpoint('dsh-memory/settings-get', {}, deps(live)) as { persistence?: { state: string } };
    expect(resp.persistence?.state).toBe('match');
  });

  it('宿主不供 forms.get 时显式 unavailable(不给猜测留位置)', async () => {
    const { handleEndpoint } = await import('../src/stats.js');
    // 无 readConfig 字段 = 宿主缺 forms.get
    const live = liveHandle();
    const resp = await handleEndpoint('dsh-memory/settings-get', {}, deps(live)) as { persistence?: { state: string; detail?: string } };
    expect(resp.persistence?.state).toBe('unavailable');
    expect(resp.persistence?.detail).toContain('forms.get');
  });
});

describe('#37 resolveSettings 布尔形状异常诊断(判值方向不变)', () => {
  it('持久化值是字符串 "true" 时仍按关闭处理(写删门宁紧勿松),但发 console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolveSettings({ memoryMutate: 'true', skillsEnabled: 1 } as never);
    expect(resolved.memoryMutate).toBe(false);
    expect(resolved.skillsEnabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('memoryMutate');
    expect(warn.mock.calls[0][0]).toContain('形状异常');
    warn.mockRestore();
  });

  it('正常 boolean 值不发诊断', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveSettings({ memoryMutate: true, skillsEnabled: false } as never);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('undefined(键缺席 = 用户从未设置)不算异常,不发诊断', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveSettings({} as never);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
