/**
 * T0.1 判据:9 家 descriptor 的 capabilities 全映射、无遗漏字段。
 *
 * 断言矩阵逐条抄自参考实现(refer-dsh-mnemon 各 provider 包 descriptor.ts 实测),
 * 任何一格漂移都会让装配校验/影子化判据建立在错误事实源上——这张表是地基。
 */
import { describe, expect, it } from 'vitest';
import {
  EXT_DRIVER_SPECS,
  EXT_DRIVER_TYPES,
  EXT_SYNC_MODES,
  canForget,
  canSync,
  normSyncMode,
  requiredMethodsOf,
} from '../src/ext-memory/types.js';

describe('ext-memory types(T0.1)', () => {
  it('清单恰为 9 家,与参考实现 provider 包一一对应', () => {
    expect([...EXT_DRIVER_TYPES].sort()).toEqual(
      ['byterover', 'hindsight', 'holographic', 'honcho', 'mem0', 'mnemon-native', 'openviking', 'retaindb', 'supermemory'],
    );
    expect(Object.keys(EXT_DRIVER_SPECS).sort()).toEqual([...EXT_DRIVER_TYPES].sort());
  });

  it('逐家能力矩阵与参考实现 descriptor 实测一致', () => {
    // [typeId, write, delete, graph, related, link, addressing, freshness, score]
    const table: Array<[string, string, string, boolean, boolean, boolean, string, string, string]> = [
      ['mem0', 'async-extracting', 'hard', false, false, false, 'stable-id', 'full-scan', 'normalized-relevance'],
      ['hindsight', 'async-extracting', 'soft', true, true, false, 'stable-id', 'cursor', 'normalized-relevance'],
      ['openviking', 'async-extracting', 'hard', false, false, false, 'uri', 'full-scan', 'normalized-relevance'],
      ['honcho', 'exact', 'hard', false, false, false, 'stable-id', 'full-scan', 'none'],
      ['retaindb', 'exact', 'hard', false, false, false, 'stable-id', 'full-scan', 'normalized-relevance'],
      ['supermemory', 'async-extracting', 'soft', false, false, false, 'stable-id', 'cursor', 'normalized-relevance'],
      ['holographic', 'exact', 'hard', true, true, false, 'content-hash', 'cursor', 'normalized-relevance'],
      ['byterover', 'async-extracting', 'unsupported', false, false, false, 'synthetic-block', 'none', 'normalized-relevance'],
      ['mnemon-native', 'exact', 'soft', true, true, true, 'stable-id', 'cursor', 'normalized-relevance'],
    ];
    for (const [id, write, del, graph, related, link, addressing, freshness, score] of table) {
      const spec = EXT_DRIVER_SPECS[id as keyof typeof EXT_DRIVER_SPECS];
      expect(spec.capabilities.writeMode, id).toBe(write);
      expect(spec.capabilities.deletionMode, id).toBe(del);
      expect(spec.capabilities.graph, id).toBe(graph);
      expect(spec.capabilities.related, id).toBe(related);
      expect(spec.capabilities.link, id).toBe(link);
      expect(spec.capabilities.addressing, id).toBe(addressing);
      expect(spec.capabilities.freshness, id).toBe(freshness);
      expect(spec.scoreSemantics, id).toBe(score);
      // 9 家全部具备 search + remember(必需核的前提)
      expect(spec.capabilities.search, id).toBe(true);
      expect(spec.capabilities.remember, id).toBe(true);
    }
  });

  it('byterover 结构性不可双向同步/不可删除传导;其余 8 家可同步', () => {
    expect(canSync(EXT_DRIVER_SPECS.byterover.capabilities)).toBe(false);
    expect(canForget(EXT_DRIVER_SPECS.byterover.capabilities)).toBe(false);
    for (const t of EXT_DRIVER_TYPES) {
      if (t === 'byterover') continue;
      expect(canSync(EXT_DRIVER_SPECS[t].capabilities), t).toBe(true);
    }
  });

  it('requiredMethodsOf:能力声明 → 方法要求的推导无死角', () => {
    expect(requiredMethodsOf(EXT_DRIVER_SPECS.mem0.capabilities).sort()).toEqual(
      ['forget', 'list', 'remember', 'search', 'status'].sort(),
    );
    expect(requiredMethodsOf(EXT_DRIVER_SPECS['mnemon-native'].capabilities)).toContain('link');
    // sincePull 不再从 freshness==='cursor' 推导：那会迫使未接游标的家也放一个会抛错的桩，
    // 于是“方法存在”变成恒真判据，拉取分支永远走错路。现在只有显式 incremental 才要求它。
    expect(requiredMethodsOf(EXT_DRIVER_SPECS.hindsight.capabilities)).not.toContain('sincePull');
    expect(requiredMethodsOf({ ...EXT_DRIVER_SPECS.hindsight.capabilities, incremental: true })).toContain('sincePull');
    // 没有任何一家声明 incremental：声明必须等于实装。
    for (const s of Object.values(EXT_DRIVER_SPECS)) {
      expect(s.capabilities.incremental, s.typeId).toBe(false);
    }
    // byterover:search/status/remember 三件,无 forget/list(browse=false)
    expect(requiredMethodsOf(EXT_DRIVER_SPECS.byterover.capabilities).sort()).toEqual(
      ['remember', 'search', 'status'].sort(),
    );
  });

  it('normSyncMode:非法值回默认档、绝不抛(schemastery 崩溃半径纪律的消费侧半边)', () => {
    for (const m of EXT_SYNC_MODES) expect(normSyncMode(m)).toBe(m);
    expect(normSyncMode('bogus')).toBe('shadow-read');
    expect(normSyncMode(undefined)).toBe('shadow-read');
    expect(normSyncMode(42)).toBe('shadow-read');
  });
});
