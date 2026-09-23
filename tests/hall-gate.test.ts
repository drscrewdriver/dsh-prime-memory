/**
 * Hall 八边形 1c 域接线的单元回归:R14 归一化三条规则 / 软门禁权重与降级链 /
 * 手动挡硬过滤 / 域锁定的存储语义(写穿、正交、跨切档保留)。
 * (task_18⑥ / task_19⑤ 的回归锚点:硬过滤与加权排序是纯函数,可直接断言)
 */
import { describe, expect, it } from 'vitest';
import { WING_DEFAULT_ENABLED, WING_CATALOG, WING_FALLBACK, wingLabel } from '../src/types.js';
import { normWingEnabled } from '../src/config.js';
import {
  cosine,
  domainGate,
  formatWeights,
  hardFilterByWingLock,
  neutralWeights,
  sortByDomainWeight,
  weightsFromKeywords,
  WING_ANCHORS,
  WING_GATE_WEIGHT_FLOOR,
} from '../src/domain-gate.js';
import { isWingCorner, SessionModeStore } from '../src/store/session-modes.js';

describe('wing vocabulary (task_7)', () => {
  it('8 corners, general is fallback-only, wingLabel resolves 跨域', () => {
    expect(WING_CATALOG).toHaveLength(8);
    expect(WING_DEFAULT_ENABLED).toHaveLength(8);
    expect(WING_CATALOG.some((h) => h.id === 'general')).toBe(false);
    expect(WING_FALLBACK).toBe('general');
    expect(wingLabel('general')).toBe('跨域');
  });
});

describe('normWingEnabled (R14, task_8)', () => {
  it('rule 1: empty array stays empty (= wing labeling off, not normalized away)', () => {
    expect(normWingEnabled([])).toEqual([]);
    expect(normWingEnabled(undefined)).toEqual([]);
  });
  it('rule 2: retired id general completes to the 8-corner set (old default config)', () => {
    expect(normWingEnabled(['work', 'relationships', 'general'])).toEqual([...WING_DEFAULT_ENABLED]);
  });
  it('rule 3: explicit subsets without general are kept as-is', () => {
    expect(normWingEnabled(['work'])).toEqual(['work']);
    expect(normWingEnabled(['finance', 'journey'])).toEqual(['finance', 'journey']);
  });
});

describe('domain gate (task_19)', () => {
  it('embedding path: query aligned with work anchor gives work the top weight', () => {
    // 伪造嵌入:各域锚向量取互异单位基向量,查询向量与 work 锚同向
    const n = WING_ANCHORS.length;
    const anchorVecs = WING_ANCHORS.map((_, i) => {
      const v = new Array(n).fill(0);
      v[i] = 1;
      return v;
    });
    const workIdx = WING_ANCHORS.findIndex((a) => a.id === 'work');
    const queryVec = anchorVecs[workIdx]!;
    const gate = domainGate('项目接口部署', { queryVec, anchorVecs });
    expect(gate.source).toBe('embedding');
    const entries = Object.entries(gate.weights).sort((a, b) => b[1] - a[1]);
    expect(entries[0]![0]).toBe('work');
    // 软门禁:低相关域降权而非消失(权重 = floor,不是 0)
    expect(entries[entries.length - 1]![1]).toBeCloseTo(WING_GATE_WEIGHT_FLOOR, 5);
  });

  it('keyword degradation: finance query raises finance weight via keywords', () => {
    const gate = domainGate('这个月的报销发票怎么记账');
    expect(gate.source).toBe('keyword');
    const weights = weightsFromKeywords('报销发票记账')!;
    expect(weights['finance']!).toBeGreaterThan(weights['work']!);
    expect(gate.weights['finance']).toBeGreaterThan(gate.weights['work']!);
  });

  it('no signal degrades to neutral (no bias), and none-source keeps全域无偏置 baseline', () => {
    const gate = domainGate('Hello world, casual talk without domain keywords 123');
    expect(gate.source).toBe('none');
    expect(gate.weights).toEqual(neutralWeights());
    expect(Object.values(gate.weights).every((w) => w === 1)).toBe(true);
  });

  it('cosine: identical vectors → 1; orthogonal → 0; length mismatch → 0', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1], [1, 2])).toBe(0);
  });

  it('formatWeights prints all 8 domain weights (可解释性验收)', () => {
    const text = formatWeights(neutralWeights());
    for (const a of WING_ANCHORS) expect(text).toContain(a.id + '=');
  });

  it('weighted sort: low-relevance domain sinks but is not dropped (软门禁不硬排除)', () => {
    const hits = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.8 },
      { id: 'c', score: 0.7 },
    ];
    const wingOf = (id: string) => (id === 'a' ? 'work' : id === 'b' ? 'journey' : undefined);
    const weights = neutralWeights();
    weights['work'] = 1; // 高相关
    weights['journey'] = WING_GATE_WEIGHT_FLOOR; // 低相关 → 降权沉底但仍在列
    const sorted = sortByDomainWeight(hits, wingOf, weights);
    expect(sorted.map((h) => h.id)).toEqual(['a', 'c', 'b']); // 未打标取中性权重居中
    expect(sorted).toHaveLength(3); // 没有被硬排除
  });
});

describe('manual wing lock (task_18)', () => {
  const hits = [
    { id: 'w1', score: 0.9 },
    { id: 'f1', score: 0.8 },
    { id: 'g1', score: 0.7 },
    { id: 'n1', score: 0.6 },
  ];
  const wingOf = (id: string) =>
    id === 'w1' ? 'work' : id === 'f1' ? 'finance' : id === 'g1' ? WING_FALLBACK : undefined;

  it('default boundaries: only locked domain + unlabeled pass; other domains and general are zero-injected', () => {
    const out = hardFilterByWingLock(hits, wingOf, ['work'], true, false);
    expect(out.map((h) => h.id)).toEqual(['w1', 'n1']);
  });
  it('boundary toggles: unlabeled excluded / general included per switch', () => {
    expect(hardFilterByWingLock(hits, wingOf, ['work'], false, false).map((h) => h.id)).toEqual(['w1']);
    expect(hardFilterByWingLock(hits, wingOf, ['work'], true, true).map((h) => h.id)).toEqual(['w1', 'g1', 'n1']);
  });
  it('multi-select lock: hits in any locked domain pass (R13)', () => {
    expect(hardFilterByWingLock(hits, wingOf, ['work', 'finance'], true, false).map((h) => h.id)).toEqual(['w1', 'f1', 'n1']);
  });
  it('empty corner: lock yields only unlabeled (诚实空角,不报错)', () => {
    expect(hardFilterByWingLock(hits, wingOf, ['health'], true, false).map((h) => h.id)).toEqual(['n1']);
  });
});

describe('session wing lock storage (task_18①: 同存储/写穿/正交/跨切档保留)', () => {
  it('isWingCorner accepts 8 corner ids only', () => {
    expect(isWingCorner('work')).toBe(true);
    expect(isWingCorner('finance')).toBe(true);
    expect(isWingCorner('general')).toBe(false); // 兜底值不是角,不可锁定
    expect(isWingCorner('bogus')).toBe(false);
  });

  it('setWing persists, survives cross-mode switch, and recall override is orthogonal', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wing-'));
    const store = new SessionModeStore(dir, 'auto');
    store.setWing('s1', ['finance'], { includeUnlabeled: false, includeGeneral: true });
    store.setRecall('s1', false); // 注入覆盖不动锁域(正交)
    store.set('s1', 'work'); // 切档不动锁域(跨切档保留)
    await store.flush(); // 写穿是异步链,落盘后再验证
    expect(store.getWing('s1')).toBe('finance');
    expect(store.getRecall('s1')).toBe(false);
    expect(store.wingBoundaries('s1')).toEqual({ includeUnlabeled: false, includeGeneral: true });
    // 写穿:新实例从盘上读回
    const reloaded = new SessionModeStore(dir, 'auto');
    await reloaded.init();
    expect(reloaded.getWing('s1')).toBe('finance');
    // 只改边界开关(不传 halls)= **不动锁域**;旧写法在这里把锁定静默清掉了
    store.setWing('s1', undefined, { includeUnlabeled: true });
    expect(store.getWings('s1')).toEqual(['finance']);
    expect(store.wingBoundaries('s1').includeUnlabeled).toBe(true);
    // 回中心 = 显式空数组清除锁定
    store.setWing('s1', []);
    expect(store.getWings('s1')).toEqual([]);
    // 多选:两域锁定 + 单角镜像兼容键
    store.setWing('s2', ['work', 'finance']);
    expect(store.getWings('s2')).toEqual(['work', 'finance']);
    expect(store.getWing('s2')).toBe('work');
    store.setWing('s2', []);
    expect(store.getWings('s2')).toEqual([]);
  });
});

describe('wing 角序与拖动配额(2026-09-23)', () => {
  it('居家在健康之前(用户要求对调)', () => {
    const ids = WING_CATALOG.map((h) => h.id);
    expect(ids.indexOf('home')).toBeLessThan(ids.indexOf('health'));
  });

  it('软门禁降权而非剔除:权重低的域排后但仍在结果里', () => {
    const hits = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.9 },
      { id: 'c', score: 0.1 },
    ];
    const wingOf = (id: string) => ({ a: 'work', b: 'home', c: 'health' })[id];
    const out = sortByDomainWeight(hits, wingOf, { work: 0.4, home: 1, health: 0.8 });
    expect(out.map((h) => h.id)).toEqual(['b', 'c', 'a']);
    expect(out).toHaveLength(3);
  });
});
