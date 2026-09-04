/**
 * 管线单元测试:effectiveCfg 六层优先级决策表(头号必测项)、任务优先级、
 * 重建分组/调用数估算、settings 防御解析与链校验。
 */
import { describe, expect, it } from 'vitest';
import { effectiveCfg, pickNextTaskIndex, type PipelineTask } from '../src/pipeline/runner.js';
import { estimateCalls, groupL0Sessions } from '../src/pipeline/rebuild.js';
import { DISTILL_CHAIN_MAX, projectDistillChain, validateDistillChain } from '../src/settings.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryConfig, MemoryLiveSettings } from '../src/contract.js';
import type { MemoryLiveSettings as LiveShape } from '../src/contract.js';

function cfg(over: Partial<MemoryConfig['llm']> = {}): MemoryConfig {
  return {
    dataDir: '', family: 'auto',
    capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 },
    extract: { enabled: true, minMessages: 6, idleSeconds: 300, backgroundMessages: 10, candidatePool: 5 },
    l2: { enabled: true, minNewMemories: 5, maxScenes: 12, sceneContextLimit: 3 },
    l3: { enabled: true, interval: 20 },
    recall: { enabled: true, maxResults: 5, maxCharsPerMemory: 500, maxTotalRecallChars: 2000, timeoutMs: 5000, includePersona: true, includeSceneNav: true, strategy: 'hybrid', scoreThreshold: 0.3, decayHalfLifeDays: 30 },
    embedding: { enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 0, maxInputChars: 5000, timeoutMs: 10000, allowLocalModels: true, mirror: 'https://hf-mirror.com', proxy: '' },
    llm: { provider: '', model: '', mode: 'host', baseURL: '', apiKey: '', maxTokens: 65536, reasoningEffort: 'medium', maxInputChars: 700000, timeoutMs: 120000, ...over },
    hall: { enabled: ['work'] },
    tokenCost: { retentionDays: 365 },
    tools: true,
    benchControl: false,
  } as MemoryConfig;
}

function live(over: Partial<MemoryLiveSettings>): LiveSettingsHandle {
  const s: MemoryLiveSettings = {
    enabled: true, capture: true, distill: true, recall: true,
    reasoningEffort: '', distillProvider: '', distillModel: '', distillChain: [],
    distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0 }, distillMaxInputChars: 0,
    distillLayerChains: { l1: [], l2: [], l3: [] }, distillMode: '', directBaseURL: '', directApiKey: '',
    embedRemoteBaseURL: '', embedRemoteApiKey: '', embedRemoteModel: '', embedRemoteDimensions: 0, memoryMutate: false,
    ...over,
  };
  return { supported: true, get: () => s, update: async () => {} };
}

describe('effectiveCfg priority table', () => {
  it('no live / empty overrides returns the original cfg reference', () => {
    const c = cfg();
    expect(effectiveCfg(c, undefined)).toBe(c);
    // live 在场时思考档位整体接管:运行时空值 = auto,覆盖静态 medium(新对象)
    const out = effectiveCfg(c, live({}));
    expect(out).not.toBe(c);
    expect(out.llm.reasoningEffort).toBe('');
    // 静态档位本就为空时无注入 → 原引用
    const emptyEffort = cfg({ reasoningEffort: '' });
    expect(effectiveCfg(emptyEffort, live({}))).toBe(emptyEffort);
  });

  it('deploy pin (provider+model) overrides runtime chain and legacy keys', () => {
    const c = cfg({ provider: 'pin-p', model: 'pin-m' });
    const out = effectiveCfg(c, live({
      distillChain: [{ provider: 'chain-p', model: 'chain-m', reasoningEffort: 'high' }],
      distillProvider: 'old-p', distillModel: 'old-m', reasoningEffort: 'low',
    }));
    expect(out.llm.provider).toBe('pin-p');
    expect(out.llm.model).toBe('pin-m');
    expect(out.llm.primaryEffort).toBeUndefined(); // 链随 pin 失效
    expect(out.llm.fallbacks).toBeUndefined();
  });

  it('chain mode: head becomes primary route, tail becomes fallbacks, head effort → primaryEffort', () => {
    const c = cfg({ fallbacks: [{ provider: 'sf', model: 'sm', reasoningEffort: 'low' }] });
    const out = effectiveCfg(c, live({
      distillChain: [
        { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
        { provider: 'p2', model: 'm2', reasoningEffort: '' },
      ],
      reasoningEffort: 'low',
    }));
    expect(out.llm.provider).toBe('p1');
    expect(out.llm.model).toBe('m1');
    expect(out.llm.primaryEffort).toBe('high');
    // 单条目档位为空 → 跟随静态全局 medium(非链内旧键)
    expect(out.llm.fallbacks).toEqual([{ provider: 'p2', model: 'm2', reasoningEffort: '' }]);
  });

  it('single-entry chain = explicit no-fallback (static fallbacks cleared)', () => {
    const c = cfg({ fallbacks: [{ provider: 'sf', model: 'sm' }] });
    const out = effectiveCfg(c, live({ distillChain: [{ provider: 'p1', model: 'm1', reasoningEffort: 'high' }] }));
    expect(out.llm.fallbacks).toEqual([]);
  });

  it('legacy pair keys apply only without chain and without pin', () => {
    const c = cfg();
    const out = effectiveCfg(c, live({ distillProvider: 'lp', distillModel: 'lm', reasoningEffort: 'low' }));
    expect(out.llm.provider).toBe('lp');
    expect(out.llm.model).toBe('lm');
    expect(out.llm.reasoningEffort).toBe('low');
    // 接管语义:静态回退条目被盖章为运行时档位
    const c2 = cfg({ fallbacks: [{ provider: 'a', model: 'b', reasoningEffort: 'high' }] });
    const out2 = effectiveCfg(c2, live({ reasoningEffort: 'max' }));
    expect(out2.llm.fallbacks?.[0].reasoningEffort).toBe('max');
  });

  it('budgets: nonzero per-layer overrides only', () => {
    const out = effectiveCfg(cfg(), live({ distillBudgets: { extract: 100, dedup: 0, l2: 200, l3: 0 } }));
    expect(out.llm.budgets).toEqual({ extract: 100, l2: 200 });
    expect(effectiveCfg(cfg(), live({ distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0 } })).llm.budgets).toBeUndefined();
  });

  it('input budget and layer chains inject; pinned kills layer chains', () => {
    const out = effectiveCfg(cfg(), live({ distillMaxInputChars: 5000, distillLayerChains: { l1: [{ provider: 'a', model: 'b', reasoningEffort: 'high' }], l2: [], l3: [] } }));
    expect(out.llm.maxInputChars).toBe(5000);
    expect(out.llm.layerChainsRuntime?.l1?.[0].provider).toBe('a');
    const pinned = cfg({ provider: 'pp', model: 'pm' });
    expect(effectiveCfg(pinned, live({ distillLayerChains: { l1: [{ provider: 'a', model: 'b', reasoningEffort: '' }], l2: [], l3: [] }, distillMaxInputChars: 1 })).llm.layerChainsRuntime).toBeUndefined();
  });

  it('channel overrides: mode lock + direct endpoint/key (independent of pin)', () => {
    const pinned = cfg({ provider: 'pp', model: 'pm', mode: 'host', baseURL: 'http://deploy/v1', apiKey: 'deploy' });
    const out = effectiveCfg(pinned, live({ distillMode: 'direct', directBaseURL: 'http://local:11434/v1', directApiKey: 'local-key' }));
    expect(out.llm.mode).toBe('direct');
    expect(out.llm.baseURL).toBe('http://local:11434/v1');
    expect(out.llm.apiKey).toBe('local-key');
    expect(out.llm.provider).toBe('pp'); // pin 仍生效(正交)
  });

  it('embed runtime overrides inject into embedding subtree and force-enable', () => {
    const c = cfg({ reasoningEffort: '' });
    c.embedding = { ...c.embedding, enabled: false, baseUrl: 'http://deploy-embed/v1', apiKey: 'dk', model: 'dm', dimensions: 0 };
    const out = effectiveCfg(c, live({ embedRemoteBaseURL: 'http://ui/v1', embedRemoteModel: 'ui-model', embedRemoteDimensions: 1024 }));
    expect(out.embedding.enabled).toBe(true); // 任一覆盖字段非空即放行 remoteCeiling
    expect(out.embedding.baseUrl).toBe('http://ui/v1');
    expect(out.embedding.model).toBe('ui-model');
    expect(out.embedding.dimensions).toBe(1024);
    expect(out.embedding.apiKey).toBe('dk'); // 未覆盖保留部署值
    // 空覆盖 → 原引用
    expect(effectiveCfg(c, live({}))).toBe(c);
  });
});

describe('task priority', () => {
  it('earliest live wins over rebuild; queue head when all rebuild', () => {
    const t = (kind: PipelineTask['kind']): PipelineTask => ({ kind, run: async () => {} });
    const tasks = [t('rebuild'), t('rebuild'), t('live'), t('rebuild'), t('live')];
    expect(pickNextTaskIndex(tasks)).toBe(2);
    expect(pickNextTaskIndex([t('rebuild'), t('rebuild')])).toBe(0);
  });
});

describe('rebuild grouping and estimation', () => {
  it('groupL0Sessions drops invalid rows, sorts members and sessions by time', () => {
    const chunks = groupL0Sessions([
      { sessionId: 's2', recordedAt: '', id: '5', role: 'user', content: 'b', timestamp: 20 },
      { sessionId: 's1', recordedAt: '', id: '2', role: 'user', content: 'z', timestamp: 30 },
      { sessionId: 's1', recordedAt: '', id: '1', role: 'user', content: 'a', timestamp: 10 },
      { sessionId: 's1', recordedAt: '', id: '3', role: 'system', content: 'x', timestamp: 15 }, // 非法 role 剔除
      { sessionId: 's1', recordedAt: '', id: '4', role: 'user', content: '  ', timestamp: 16 }, // 空内容剔除
      { sessionId: '', recordedAt: '', id: '6', role: 'assistant', content: 'd', timestamp: 5 }, // 归 default
    ]);
    expect(chunks.map((c) => c.sessionId)).toEqual(['default', 's1', 's2']);
    expect(chunks[1].messages.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('estimateCalls is the lower bound of session count and char-budget chunks', () => {
    expect(estimateCalls(3, 0, 0, 700_000)).toBe(0);
    expect(estimateCalls(3, 10, 1000, 700_000)).toBe(3); // 会话数主导
    // (1000 + 64*100)/20000 = 0.4 → 1 块;两会话 → 2
    expect(estimateCalls(2, 100, 1000, 62_000)).toBe(2);
    // perChunk=20000;(100000 + 64*100)/20000 = 5.32 → 6 块(脚手架开销计入)
    expect(estimateCalls(1, 100, 20_000 * 5, 62_000)).toBe(6);
  });
});

describe('settings defenses', () => {
  it('validateDistillChain enforces shape, pair, dedup and cap', () => {
    expect(validateDistillChain('nope')).toContain('数组');
    expect(validateDistillChain([{ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' }])).toContain('重复');
    expect(validateDistillChain([{ provider: 'a', model: '' }])).toContain('成对');
    expect(validateDistillChain([{ provider: 'a', model: 'b' }, { provider: 'c', model: '' }])).toContain('显式');
    expect(validateDistillChain([{ provider: 'a', model: 'b', reasoningEffort: 'bogus' }])).toContain('非法');
    expect(validateDistillChain(Array.from({ length: DISTILL_CHAIN_MAX + 1 }, () => ({ provider: 'x', model: 'y' })))).toContain('最多');
    expect(validateDistillChain([{ provider: 'a', model: 'b', reasoningEffort: 'high' }])).toBeNull();
    // 层链:头行必须双显式
    expect(validateDistillChain([{ provider: '', model: '' }], { requireExplicitHead: true })).toContain('显式');
  });

  it('projectDistillChain falls back to legacy pair projection', () => {
    expect(projectDistillChain({ distillChain: [{ provider: 'a', model: 'b', reasoningEffort: 'low' }] }).length).toBe(1);
    expect(projectDistillChain({ distillProvider: 'p', distillModel: 'm', reasoningEffort: 'off' as LiveShape['reasoningEffort'] })).toEqual([
      { provider: 'p', model: 'm', reasoningEffort: 'off' },
    ]);
    expect(projectDistillChain({})).toEqual([]);
  });
});
