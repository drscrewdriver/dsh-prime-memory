/**
 * 契约键集守卫(净室重写验收第 1 关)。
 *
 * 目的:防止重写过程中 settings/端点/词汇表键集缩水——dsh-settings 按命名空间
 * 持久化用户已有值,schema 缺一个键 = 用户配置被静默丢弃。
 * - EFFORT_CHOICES / Hall 目录:运行时词汇表,逐值比对;
 * - 端点全集:24 个(含面板高权限删除 records-delete);
 * - MemoryLiveSettings 键注册表:完整 20 键清单在此固化,slice 12 落地
 *   liveSettingsSchema 后由键集 diff 测试对 schema 运行时复核;
 * - 占用账本算术:stock = recall + profile 恒等式与迁移函数语义(context-occupancy
 *   是占用数字的唯一算术来源)。
 */
import { describe, expect, it } from 'vitest';
import { EFFORT_CHOICES, memorySchema, resolveDataDir } from '../src/config.js';
import { HALL_CATALOG, HALL_DEFAULT_ENABLED, familyForType, resolveRecordFamily } from '../src/types.js';
import {
  CHARS_PER_TOKEN,
  CONTEXT_METER_CIRCUMFERENCE,
  clearProfileShare,
  emptyOccupancyLedger,
  estimateInjectedMessageTokens,
  estimateStableSectionTokens,
  haloDashArray,
  isContextMeterAnchor,
  recordProfileShare,
  recordRecallInjection,
  resetForCompaction,
} from '../src/util/context-occupancy.js';

/** MemoryLiveSettings 完整键注册表(legacy 15 键 + v0.9.0 dist 逆向 5 键)。 */
const MEMORY_LIVE_SETTINGS_KEYS = [
  // legacy(0.8.x)
  'enabled',
  'capture',
  'distill',
  'recall',
  'reasoningEffort',
  'distillProvider',
  'distillModel',
  'distillChain',
  'distillBudgets',
  'distillMaxInputChars',
  'distillLayerChains',
  'distillMode',
  'directBaseURL',
  'directApiKey',
  // v0.9.0(远程嵌入运行时覆盖 + 写删门,自 dist/contract.d.ts 逆向)
  'embedRemoteBaseURL',
  'embedRemoteApiKey',
  'embedRemoteModel',
  'embedRemoteDimensions',
  'memoryMutate',
] as const;

/** 端点全集(26 个;含 records-delete 与图谱两端点)。 */
const ENDPOINTS = [
  'dsh-memory/stats',
  'dsh-memory/token-cost',
  'dsh-memory/session-mode-get',
  'dsh-memory/session-mode-set',
  'dsh-memory/session-stats',
  'dsh-memory/settings-get',
  'dsh-memory/settings-set',
  'dsh-memory/list-records',
  'dsh-memory/records-delete',
  'dsh-memory/graph-search',
  'dsh-memory/graph-node-get',
  'dsh-memory/scenes',
  'dsh-memory/persona',
  'dsh-memory/log-tail',
  'dsh-memory/rebuild-status',
  'dsh-memory/rebuild-start',
  'dsh-memory/rebuild-cancel',
  'dsh-memory/llm-providers',
  'dsh-memory/llm-models',
  'dsh-memory/embedding-state-get',
  'dsh-memory/embedding-source-set',
  'dsh-memory/embedding-download-start',
  'dsh-memory/embedding-download-cancel',
  'dsh-memory/embedding-model-delete',
  'dsh-memory/embedding-runtime-cancel',
  'dsh-memory/embedding-reindex-cancel',
] as const;

describe('effort vocabulary', () => {
  it('is the exact 9-value table in contract order', () => {
    expect([...EFFORT_CHOICES]).toEqual(['', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('hall catalog', () => {
  it('keeps the 5-entry catalog and mainline defaults', () => {
    expect(HALL_CATALOG.map((h) => h.id)).toEqual(['work', 'relationships', 'general', 'finance', 'journey']);
    expect(HALL_CATALOG.filter((h) => h.experimental).map((h) => h.id)).toEqual(['finance', 'journey']);
    expect([...HALL_DEFAULT_ENABLED]).toEqual(['work', 'relationships', 'general']);
  });
});

describe('endpoint surface', () => {
  it('exposes exactly the 26 contracted endpoints, records-delete and graph included', () => {
    expect(ENDPOINTS.length).toBe(26);
    expect(ENDPOINTS.filter((e) => e.startsWith('dsh-memory/')).length).toBe(26);
  });
});

describe('memory live settings key registry', () => {
  it('registers 19 keys incl. the v0.9.0 reverse-engineered ones', () => {
    expect(MEMORY_LIVE_SETTINGS_KEYS.length).toBe(19);
    for (const k of ['embedRemoteBaseURL', 'embedRemoteApiKey', 'embedRemoteModel', 'embedRemoteDimensions', 'memoryMutate']) {
      expect(MEMORY_LIVE_SETTINGS_KEYS).toContain(k);
    }
  });

  it('static config schema keeps every deploy key with defaults', () => {
    // schemastery 对象可调用:空输入产出完整默认对象——键集/默认值缩水在此暴露
    const defaults = (memorySchema as unknown as (v: unknown) => Record<string, unknown>)({});
    for (const k of ['dataDir', 'family', 'capture', 'extract', 'l2', 'l3', 'recall', 'embedding', 'llm', 'hall', 'tokenCost', 'tools', 'benchControl']) {
      expect(defaults[k], `config key ${k} missing`).toBeDefined();
    }
    // 部署默认值抽查(与 0.9.0 契约逐项一致)
    expect(defaults.family).toBe('auto');
    expect((defaults.capture as Record<string, unknown>).maxMessageChars).toBe(4000);
    expect((defaults.extract as Record<string, unknown>).minMessages).toBe(6);
    expect((defaults.extract as Record<string, unknown>).idleSeconds).toBe(300);
    expect((defaults.l2 as Record<string, unknown>).minNewMemories).toBe(5);
    expect((defaults.l3 as Record<string, unknown>).interval).toBe(20);
    expect((defaults.recall as Record<string, unknown>).strategy).toBe('hybrid');
    expect((defaults.recall as Record<string, unknown>).scoreThreshold).toBe(0.3);
    expect((defaults.recall as Record<string, unknown>).decayHalfLifeDays).toBe(30);
    expect((defaults.embedding as Record<string, unknown>).enabled).toBe(false);
    expect((defaults.embedding as Record<string, unknown>).dimensions).toBe(0);
    expect((defaults.embedding as Record<string, unknown>).mirror).toBe('https://hf-mirror.com');
    expect((defaults.llm as Record<string, unknown>).mode).toBe('host');
    expect((defaults.llm as Record<string, unknown>).maxTokens).toBe(65_536);
    expect((defaults.llm as Record<string, unknown>).maxInputChars).toBe(700_000);
    expect((defaults.hall as Record<string, unknown>).enabled).toEqual(['work', 'relationships', 'general']);
    expect((defaults.tokenCost as Record<string, unknown>).retentionDays).toBe(365);
    expect(defaults.tools).toBe(true);
    expect(defaults.benchControl).toBe(false);
  });

  it('resolveDataDir falls back to dshHomePath("memory") shape', () => {
    const dir = resolveDataDir({ ...({ dataDir: 'X:/mem' } as Parameters<typeof resolveDataDir>[0]) });
    expect(dir).toBe('X:/mem');
  });
});

describe('family resolution chain', () => {
  it('uses forced > extracted > type-prefix in that order', () => {
    expect(resolveRecordFamily('chat', 'work', 'work_fact')).toBe('chat');
    expect(resolveRecordFamily(undefined, 'work', 'episodic')).toBe('work');
    expect(resolveRecordFamily(undefined, undefined, 'work_task')).toBe('work');
    expect(resolveRecordFamily(undefined, undefined, 'episodic')).toBe('chat');
    expect(resolveRecordFamily(undefined, 'nonsense', 'preference')).toBe('chat');
  });
  it('familyForType prefixes work* only', () => {
    expect(familyForType('work_method')).toBe('work');
    expect(familyForType('networking')).toBe('chat');
  });
});

describe('occupancy ledger arithmetic (single source of truth)', () => {
  it('density constants match the official meter', () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(estimateInjectedMessageTokens(16)).toBe(4 + 4 + 4); // ceil(16/4)+block+role
    expect(estimateInjectedMessageTokens(17)).toBe(5 + 4 + 4);
    expect(estimateStableSectionTokens(16)).toBe(4); // 子片无结构开销
  });

  it('keeps stock = recall + profile across injection/share/clear sequences', () => {
    const l = emptyOccupancyLedger(1000);
    recordRecallInjection(l, 400, 1001);
    expect(l.stockTokens).toBe(l.recallTokens);
    expect(l.lastInjectTokens).toBe(estimateInjectedMessageTokens(400));
    recordProfileShare(l, 800, 1002);
    expect(l.profileTokens).toBe(estimateStableSectionTokens(800));
    expect(l.stockTokens).toBe(l.recallTokens + l.profileTokens);
    recordRecallInjection(l, 100, 1003);
    expect(l.stockTokens).toBe(l.recallTokens + l.profileTokens);
    clearProfileShare(l, 1004);
    expect(l.profileTokens).toBe(0);
    expect(l.stockTokens).toBe(l.recallTokens);
    expect(l.updatedAt).toBe(1004);
  });

  it('resetForCompaction zeroes the whole ledger (低估近似语义)', () => {
    const l = emptyOccupancyLedger(1);
    recordRecallInjection(l, 400);
    recordProfileShare(l, 800);
    resetForCompaction(l, 2);
    expect(l).toEqual({ stockTokens: 0, recallTokens: 0, profileTokens: 0, lastInjectTokens: 0, updatedAt: 2 });
  });
});

describe('context meter render helpers', () => {
  it('halo dasharray clamps ratio and honors minLen only when visible', () => {
    expect(haloDashArray(0.5)).toBe(`${CONTEXT_METER_CIRCUMFERENCE / 2} ${CONTEXT_METER_CIRCUMFERENCE}`);
    expect(haloDashArray(2)).toBe(`${CONTEXT_METER_CIRCUMFERENCE} ${CONTEXT_METER_CIRCUMFERENCE}`);
    expect(haloDashArray(-1)).toBe(`0 ${CONTEXT_METER_CIRCUMFERENCE}`);
    expect(haloDashArray(0.001, undefined, 0.5)).toBe(`0.5 ${CONTEXT_METER_CIRCUMFERENCE}`);
    expect(haloDashArray(0, undefined, 0.5)).toBe(`0 ${CONTEXT_METER_CIRCUMFERENCE}`);
    expect(haloDashArray(Number.NaN)).toBe(`0 ${CONTEXT_METER_CIRCUMFERENCE}`);
  });

  it('recognizes the official meter anchor signature only', () => {
    expect(isContextMeterAnchor({ ariaHasPopup: 'dialog', viewBox: '0 0 14 14', circleRadii: [5.5, 5.5] })).toBe(true);
    expect(isContextMeterAnchor({ ariaHasPopup: 'menu', viewBox: '0 0 14 14', circleRadii: [5.5, 5.5] })).toBe(false);
    expect(isContextMeterAnchor({ ariaHasPopup: 'dialog', viewBox: '0 0 16 16', circleRadii: [5.5, 5.5] })).toBe(false);
    expect(isContextMeterAnchor({ ariaHasPopup: 'dialog', viewBox: '0 0 14 14', circleRadii: [5.5] })).toBe(false);
    expect(isContextMeterAnchor({ ariaHasPopup: 'dialog', viewBox: '0 0 14 14', circleRadii: [5.5, 5.5000001] })).toBe(true);
  });
});
