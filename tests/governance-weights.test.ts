import { describe, expect, it } from 'vitest';
import {
  applyGovernanceWeights,
  governanceWeightOf,
  SCOPE_FENCE_QUADRANTS,
  type GovernanceContext,
} from '../src/store/governance.js';
import { assertNotDedupPath, GOVERNANCE_SENTINEL_ACTIVE } from '../src/store/search-utils.js';
import type { MemoryRecord } from '../src/types.js';

function rec(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'r',
    content: 'c',
    type: 'work_fact',
    priority: 60,
    scene_name: 's',
    timestamps: [1],
    createdAt: 1,
    updatedAt: 1,
    version: 0,
    metadata: {},
    family: 'work',
    scope: 'global',
    workspaceId: '',
    repoKeyName: '',
    repoKeyOwner: '',
    applicability: '',
    ...over,
  };
}

const ctxOn = (over?: Partial<GovernanceContext>): GovernanceContext => ({
  enabled: true,
  currentRepoKey: 'alpha',
  crossRepoMultiplier: 0.2,
  ...over,
});

describe('governanceWeightOf 四象限(P0-7 真值表)', () => {
  for (const q of SCOPE_FENCE_QUADRANTS) {
    it(`family=${q.family} repo=${q.repoKeyName || "'"} appl=${q.applicability || "'"} vs ${q.currentRepoKey} → ${q.expected}`, () => {
      const w = governanceWeightOf(
        rec({ family: q.family, repoKeyName: q.repoKeyName, applicability: q.applicability }),
        ctxOn({ currentRepoKey: q.currentRepoKey }),
      );
      if (q.expected === 'crossRepo') expect(w).toBe(0.2);
      else expect(w).toBe(1);
    });
  }

  it('治理关闭恒 1;读不到归属恒 1(fail-open)', () => {
    expect(governanceWeightOf(rec({ repoKeyName: 'beta' }), ctxOn({ enabled: false }))).toBe(1);
    expect(governanceWeightOf(undefined, ctxOn())).toBe(1);
  });
});

describe('applyGovernanceWeights(只重排不改写 score)', () => {
  it('跨仓命中沉底,同仓原序;score 字段不被改写', () => {
    const hits = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.8 },
      { id: 'c', score: 0.7 },
    ];
    const byId = new Map<string, MemoryRecord>([
      ['a', rec({ id: 'a', repoKeyName: 'beta' })], // 跨仓 → ×0.2 = 0.18
      ['b', rec({ id: 'b', repoKeyName: 'alpha' })], // 同仓 → 0.8
      ['c', rec({ id: 'c', repoKeyName: 'beta', applicability: 'cross-project' })], // 跨项目 → 0.7
    ]);
    const out = applyGovernanceWeights(hits, byId, ctxOn());
    expect(out.map((h) => h.id)).toEqual(['b', 'c', 'a']); // 跨仓 a 沉底;cross-project 的 c 不围栏
    expect(out.map((h) => h.score)).toEqual([0.8, 0.7, 0.9]); // score 原样(只重排不改写)
  });

  it('稳定排序:同权重保持原相对顺序', () => {
    const hits = [
      { id: 'x', score: 0.5 },
      { id: 'y', score: 0.5 },
    ];
    const byId = new Map<string, MemoryRecord>([
      ['x', rec({ id: 'x', repoKeyName: 'beta' })],
      ['y', rec({ id: 'y', repoKeyName: 'beta' })],
    ]);
    expect(applyGovernanceWeights(hits, byId, ctxOn()).map((h) => h.id)).toEqual(['x', 'y']);
  });

  it('关闭/单条直通(零漂移契约 I-10)', () => {
    const hits = [{ id: 'a', score: 0.9 }];
    const byId = new Map<string, MemoryRecord>([['a', rec({ repoKeyName: 'beta' })]]);
    expect(applyGovernanceWeights(hits, byId, ctxOn({ enabled: false }))).toEqual(hits);
    expect(applyGovernanceWeights(hits, byId, ctxOn())).toEqual(hits);
  });
});

describe('去重路径哨兵(治理 W0 T0.2)', () => {
  it('dev/test 下哨兵激活;非去重路径直通', () => {
    expect(GOVERNANCE_SENTINEL_ACTIVE).toBe(process.env.NODE_ENV !== 'production');
    expect(() => assertNotDedupPath('测试点')).not.toThrow();
  });
});
