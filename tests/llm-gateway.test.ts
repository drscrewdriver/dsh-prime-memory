/**
 * LLM 网关单元测试:路由链组装/层链三级/effort 决策表/分层预算放大/JSON 容错解析/
 * 用量计数器/成本快照(注入假 db)。
 */
import { describe, expect, it } from 'vitest';
import {
  buildRouteChain,
  decideSendableEffort,
  layerChainOrNull,
  layerEffortTrigger,
  layerKeyFor,
  layerMaxTokens,
  LAYER_DEFAULT_BUDGETS,
  parseJson,
  resolveLayerTokens,
  HIGH_EFFORT_TIERS,
  type ModelEffortInfo,
} from '../src/llm.js';
import { recordDistillCall, snapshotDistillUsage } from '../src/llm-usage.js';
import { snapshotTokenCost, initTokenCost, resetTokenCost } from '../src/token-cost.js';
import type { BucketRow, MemoryDb } from '../src/store/sqlite.js';

describe('buildRouteChain (ADR-0004)', () => {
  it('primary first, dedupes by provider::model, drops incomplete entries', () => {
    const routes = buildRouteChain(
      { provider: 'p1', model: 'm1' },
      [
        { provider: 'p1', model: 'm1' }, // 与主路由重复 → 跳过
        { provider: '', model: 'x' }, // 缺 provider → 剔除
        { provider: 'p2', model: 'm2', reasoningEffort: 'low' },
        { provider: 'p2', model: 'm2' }, // 链内重复 → 跳过
      ],
      'medium',
    );
    expect(routes).toEqual([
      { provider: 'p1', model: 'm1', effort: 'medium' },
      { provider: 'p2', model: 'm2', effort: 'low' },
    ]);
  });

  it('primary explicit effort wins over global', () => {
    const routes = buildRouteChain({ provider: 'p', model: 'm', effort: 'high' }, [], 'low');
    expect(routes[0].effort).toBe('high');
  });
});

describe('layer chains (ADR-0005)', () => {
  const base = { llm: { reasoningEffort: 'medium' } };

  it('layerKeyFor maps call points to route keys', () => {
    expect(layerKeyFor('l1-extract')).toBe('l1');
    expect(layerKeyFor('l1-dedup')).toBe('l1');
    expect(layerKeyFor('l2')).toBe('l2');
    expect(layerKeyFor('l3')).toBe('l3');
  });

  it('runtime chain beats static chain; broken head falls back to global', () => {
    const cfg = {
      llm: {
        ...base.llm,
        layerRoutes: { l1: [{ provider: 's', model: 'sm', reasoningEffort: 'low' }] },
        layerChainsRuntime: { l1: [{ provider: 'r', model: 'rm', reasoningEffort: 'high' }] },
      },
    };
    expect(layerChainOrNull(cfg, 'l1')?.[0]).toEqual({ provider: 'r', model: 'rm', effort: 'high' });
    const broken = {
      llm: {
        ...base.llm,
        layerChainsRuntime: { l1: [{ provider: '', model: '', reasoningEffort: 'high' }] },
        layerRoutes: { l1: [{ provider: 's', model: 'sm', reasoningEffort: '' }] },
      },
    };
    // 运行时头残缺 → 静态链接管,档位回退全局
    expect(layerChainOrNull(broken, 'l1')?.[0]).toEqual({ provider: 's', model: 'sm', effort: 'medium' });
    // 全缺 → null(跟随全局解析)
    expect(layerChainOrNull(base, 'l2')).toBeNull();
  });

  it('layerEffortTrigger prefers chain head effort > primaryEffort > global', () => {
    expect(layerEffortTrigger({ llm: { ...base.llm, layerRoutes: { l3: [{ provider: 'a', model: 'b', reasoningEffort: 'max' }] } } }, 'l3')).toBe('max');
    expect(layerEffortTrigger({ llm: { ...base.llm, primaryEffort: 'low' } }, 'l3')).toBe('low');
    expect(layerEffortTrigger(base, 'l3')).toBe('medium');
  });
});

describe('layer budgets', () => {
  it('defaults per layer and override wins', () => {
    expect(resolveLayerTokens({ llm: { reasoningEffort: '' } }, 'dedup')).toBe(LAYER_DEFAULT_BUDGETS.dedup);
    expect(resolveLayerTokens({ llm: { reasoningEffort: '', budgets: { l2: 100 } } }, 'l2')).toBe(100);
    expect(resolveLayerTokens({ llm: { reasoningEffort: '', budgets: { l2: 0 } } }, 'l2')).toBe(LAYER_DEFAULT_BUDGETS.l2); // 0 = 跟随
  });

  it('×4 amplification only for high tiers, trigger follows chain head', () => {
    expect(layerMaxTokens(1000, 'high')).toBe(4000);
    expect(layerMaxTokens(1000, 'xhigh')).toBe(4000);
    expect(layerMaxTokens(1000, 'max')).toBe(4000);
    expect(layerMaxTokens(1000, 'medium')).toBe(1000);
    const cfg = { llm: { reasoningEffort: 'medium', layerRoutes: { l1: [{ provider: 'a', model: 'b', reasoningEffort: 'high' }] } } };
    expect(resolveLayerTokens(cfg, 'extract')).toBe(LAYER_DEFAULT_BUDGETS.extract * 4);
    expect(HIGH_EFFORT_TIERS).toEqual(['high', 'xhigh', 'max']);
  });
});

describe('decideSendableEffort (7-branch decision table)', () => {
  const cap: ModelEffortInfo = { efforts: ['off', 'low', 'high'], defaultEffort: 'low' };
  it('explicit supported / alias / unsupported / no-efforts', () => {
    expect(decideSendableEffort(cap, 'high')).toEqual({ effort: 'high', reason: 'supported' });
    expect(decideSendableEffort({ efforts: ['none'] }, 'off')).toEqual({ effort: 'none', reason: 'alias-none' });
    expect(decideSendableEffort({ efforts: ['low'] }, 'high')).toEqual({ effort: '', reason: 'unsupported' });
    expect(decideSendableEffort({ efforts: [] }, 'high')).toEqual({ effort: '', reason: 'no-efforts' });
  });
  it('auto: default effort > high fallback; no capability passes through', () => {
    expect(decideSendableEffort(cap, '')).toEqual({ effort: 'low', reason: 'auto-default' });
    expect(decideSendableEffort({ efforts: ['high'] }, '')).toEqual({ effort: 'high', reason: 'auto-high' });
    expect(decideSendableEffort({ efforts: ['medium'] }, '')).toEqual({ effort: '', reason: 'no-efforts' });
    expect(decideSendableEffort({ efforts: [] }, '')).toEqual({ effort: '', reason: 'no-efforts' });
    expect(decideSendableEffort(null, 'off')).toEqual({ effort: 'off', reason: 'no-capability' });
  });
});

describe('parseJson (fence tolerant)', () => {
  it('strips ```json fences and surrounding prose', () => {
    expect(parseJson<{ a: number }>('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJson<number[]>('前置说明 [1, 2, 3] 后缀')).toEqual([1, 2, 3]);
    expect(parseJson<{ x: string }>('  {"x": "y"}  ')).toEqual({ x: 'y' });
    expect(() => parseJson(' totally not json ')).toThrow();
  });
});

describe('distill usage counters', () => {
  it('accumulates calls/failures/tokens per layer with deep-copy snapshot', () => {
    recordDistillCall('l1-extract', 100.4, 50, 10, false);
    recordDistillCall('l1-extract', -5, 30, 0, true);
    recordDistillCall('l2', 200, 400, 100, false);
    const snap = snapshotDistillUsage();
    const l1 = snap.layers['l1-extract'];
    expect(l1.calls).toBe(2);
    expect(l1.failures).toBe(1);
    expect(l1.inputChars).toBe(100); // 负数钳 0
    expect(l1.outputTokens).toBe(80);
    const l2 = snap.layers['l2'];
    expect(l2.calls).toBe(1);
    // 深拷贝:后续累计不影响快照
    recordDistillCall('l2', 1, 1, 1, false);
    expect(snapshotDistillUsage().layers['l2'].calls).toBe(2);
    expect(l2.calls).toBe(1);
  });
});

describe('token cost snapshot (fake db)', () => {
  function fakeDb(): MemoryDb {
    const now = Date.now();
    const rows: Array<{ ts: number; provider: string; model: string; layer: string; inputChars: number; outputTokens: number; reasoningTokens: number }> = [
      { ts: now, provider: 'p1', model: 'm1', layer: 'l1-extract', inputChars: 10, outputTokens: 50, reasoningTokens: 1 },
      { ts: now, provider: 'p1', model: 'm1', layer: 'l2', inputChars: 10, outputTokens: 90, reasoningTokens: 2 },
    ];
    const insert = (provider: string, model: string, layer: string, outputTokens: number) =>
      rows.push({ ts: Date.now(), provider, model, layer, inputChars: 10, outputTokens, reasoningTokens: 1 });
    return {
      insertCostCall: (provider, model, layer, _ic, ot) => insert(provider, model, layer, ot),
      aggregateCost: (since: number) => {
        const sel = rows.filter((r) => r.ts >= since);
        const sorted = sel.map((r) => r.outputTokens).sort((a, b) => a - b);
        const n = sorted.length;
        const med = n === 0 ? 0 : n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        return {
          total: {
            calls: n,
            inputChars: sel.reduce((s, r) => s + r.inputChars, 0),
            outputTokens: sel.reduce((s, r) => s + r.outputTokens, 0),
            reasoningTokens: sel.reduce((s, r) => s + r.reasoningTokens, 0),
            avgOutputTokens: n ? sel.reduce((s, r) => s + r.outputTokens, 0) / n : 0,
            medianOutputTokens: med,
          },
          byModel: Object.entries(
            sel.reduce<Record<string, { provider: string; model: string; calls: number; inputChars: number; outputTokens: number; reasoningTokens: number }>>((acc, r) => {
              const k = `${r.provider}/${r.model}`;
              acc[k] ??= { provider: r.provider, model: r.model, calls: 0, inputChars: 0, outputTokens: 0, reasoningTokens: 0 };
              acc[k].calls++;
              acc[k].inputChars += r.inputChars;
              acc[k].outputTokens += r.outputTokens;
              acc[k].reasoningTokens += r.reasoningTokens;
              return acc;
            }, {}),
          ).map(([, v]) => v),
        };
      },
      aggregateCostByLayer: (since: number) => {
        const sel = rows.filter((r) => r.ts >= since);
        const layers = ['l1', 'l2', 'l3'];
        return layers.map((layer) => {
          const lr = sel.filter((r) => (layer === 'l1' ? r.layer.startsWith('l1') : r.layer === layer));
          const sorted = lr.map((r) => r.outputTokens).sort((a, b) => a - b);
          const n = sorted.length;
          const med = n === 0 ? 0 : n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
          return {
            layer,
            calls: n,
            inputChars: lr.reduce((s, r) => s + r.inputChars, 0),
            outputTokens: lr.reduce((s, r) => s + r.outputTokens, 0),
            reasoningTokens: lr.reduce((s, r) => s + r.reasoningTokens, 0),
            avgOutputTokens: n ? lr.reduce((s, r) => s + r.outputTokens, 0) / n : 0,
            medianOutputTokens: med,
          };
        });
      },
      aggregateByBucket: (bucketMs: number, offsetMs: number, since: number, layer: string): BucketRow[] => {
        const sel = rows.filter((r) => r.ts >= since && (layer === 'l1' ? r.layer.startsWith('l1') : r.layer === layer));
        const groups = new Map<string, BucketRow>();
        for (const r of sel) {
          const bucket = Math.floor((r.ts + offsetMs) / bucketMs);
          const k = `${bucket}|${r.provider}|${r.model}`;
          const g = groups.get(k) ?? { bucket, provider: r.provider, model: r.model, calls: 0, outputTokens: 0, reasoningTokens: 0 };
          g.calls++;
          g.outputTokens += r.outputTokens;
          g.reasoningTokens += r.reasoningTokens;
          groups.set(k, g);
        }
        return [...groups.values()];
      },
    } as unknown as MemoryDb;
  }

  it('without db init returns zeroed structure (no throw)', () => {
    resetTokenCost();
    const snap = snapshotTokenCost('day', 0);
    expect(snap.windows).toHaveLength(4);
    expect(snap.windows[3].range).toBe('all');
    expect(snap.byModel).toEqual([]);
    expect(snap.trend.byLayer.l1).toEqual([]);
  });

  it('with db aggregates windows/layers/trend; rangeDays forces day granularity', () => {
    initTokenCost(fakeDb(), 365);
    const snap = snapshotTokenCost('week', 0);
    expect(snap.windows.find((w) => w.range === 'all')?.calls).toBe(2);
    expect(snap.byModel.length).toBe(1);
    const l1 = snap.byLayer.find((l) => l.layer === 'l1');
    expect(l1?.windows.find((w) => w.range === 'all')?.calls).toBe(1);
    expect(snap.trend.granularity).toBe('week');
    // 近 N 天:粒度强制 day,桶数 = N
    const near = snapshotTokenCost('week', 7);
    expect(near.trend.granularity).toBe('day');
    expect(near.trend.byLayer.l1.length).toBe(7);
    resetTokenCost();
  });
});
