/**
 * Hall 八边形 1c 域接线的单元回归:R14 归一化三条规则 / 软门禁权重与降级链 /
 * 手动挡硬过滤 / 域锁定的存储语义(写穿、正交、跨切档保留)。
 * (task_18⑥ / task_19⑤ 的回归锚点:硬过滤与加权排序是纯函数,可直接断言)
 */
import { describe, expect, it } from 'vitest';
import { HALL_DEFAULT_ENABLED, HALL_CATALOG, HALL_FALLBACK, hallLabel } from '../src/types.js';
import { normHallEnabled } from '../src/config.js';
import {
  cosine,
  domainGate,
  formatWeights,
  hardFilterByHallLock,
  neutralWeights,
  sortByDomainWeight,
  weightsFromKeywords,
  HALL_ANCHORS,
  HALL_GATE_WEIGHT_FLOOR,
  HALL_WEIGHT_MAX,
  applyHallWeights,
  gateByDomainWeights,
  normalizeHallWeights,
} from '../src/domain-gate.js';
import { isHallCorner, SessionModeStore } from '../src/store/session-modes.js';

describe('hall vocabulary (task_7)', () => {
  it('8 corners, general is fallback-only, hallLabel resolves 跨域', () => {
    expect(HALL_CATALOG).toHaveLength(8);
    expect(HALL_DEFAULT_ENABLED).toHaveLength(8);
    expect(HALL_CATALOG.some((h) => h.id === 'general')).toBe(false);
    expect(HALL_FALLBACK).toBe('general');
    expect(hallLabel('general')).toBe('跨域');
  });
});

describe('normHallEnabled (R14, task_8)', () => {
  it('rule 1: empty array stays empty (= hall labeling off, not normalized away)', () => {
    expect(normHallEnabled([])).toEqual([]);
    expect(normHallEnabled(undefined)).toEqual([]);
  });
  it('rule 2: retired id general completes to the 8-corner set (old default config)', () => {
    expect(normHallEnabled(['work', 'relationships', 'general'])).toEqual([...HALL_DEFAULT_ENABLED]);
  });
  it('rule 3: explicit subsets without general are kept as-is', () => {
    expect(normHallEnabled(['work'])).toEqual(['work']);
    expect(normHallEnabled(['finance', 'journey'])).toEqual(['finance', 'journey']);
  });
});

describe('domain gate (task_19)', () => {
  it('embedding path: query aligned with work anchor gives work the top weight', () => {
    // 伪造嵌入:各域锚向量取互异单位基向量,查询向量与 work 锚同向
    const n = HALL_ANCHORS.length;
    const anchorVecs = HALL_ANCHORS.map((_, i) => {
      const v = new Array(n).fill(0);
      v[i] = 1;
      return v;
    });
    const workIdx = HALL_ANCHORS.findIndex((a) => a.id === 'work');
    const queryVec = anchorVecs[workIdx]!;
    const gate = domainGate('项目接口部署', { queryVec, anchorVecs });
    expect(gate.source).toBe('embedding');
    const entries = Object.entries(gate.weights).sort((a, b) => b[1] - a[1]);
    expect(entries[0]![0]).toBe('work');
    // 软门禁:低相关域降权而非消失(权重 = floor,不是 0)
    expect(entries[entries.length - 1]![1]).toBeCloseTo(HALL_GATE_WEIGHT_FLOOR, 5);
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
    for (const a of HALL_ANCHORS) expect(text).toContain(a.id + '=');
  });

  it('weighted sort: low-relevance domain sinks but is not dropped (软门禁不硬排除)', () => {
    const hits = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.8 },
      { id: 'c', score: 0.7 },
    ];
    const hallOf = (id: string) => (id === 'a' ? 'work' : id === 'b' ? 'journey' : undefined);
    const weights = neutralWeights();
    weights['work'] = 1; // 高相关
    weights['journey'] = HALL_GATE_WEIGHT_FLOOR; // 低相关 → 降权沉底但仍在列
    const sorted = sortByDomainWeight(hits, hallOf, weights);
    expect(sorted.map((h) => h.id)).toEqual(['a', 'c', 'b']); // 未打标取中性权重居中
    expect(sorted).toHaveLength(3); // 没有被硬排除
  });
});

describe('manual hall lock (task_18)', () => {
  const hits = [
    { id: 'w1', score: 0.9 },
    { id: 'f1', score: 0.8 },
    { id: 'g1', score: 0.7 },
    { id: 'n1', score: 0.6 },
  ];
  const hallOf = (id: string) =>
    id === 'w1' ? 'work' : id === 'f1' ? 'finance' : id === 'g1' ? HALL_FALLBACK : undefined;

  it('default boundaries: only locked domain + unlabeled pass; other domains and general are zero-injected', () => {
    const out = hardFilterByHallLock(hits, hallOf, ['work'], true, false);
    expect(out.map((h) => h.id)).toEqual(['w1', 'n1']);
  });
  it('boundary toggles: unlabeled excluded / general included per switch', () => {
    expect(hardFilterByHallLock(hits, hallOf, ['work'], false, false).map((h) => h.id)).toEqual(['w1']);
    expect(hardFilterByHallLock(hits, hallOf, ['work'], true, true).map((h) => h.id)).toEqual(['w1', 'g1', 'n1']);
  });
  it('multi-select lock: hits in any locked domain pass (R13)', () => {
    expect(hardFilterByHallLock(hits, hallOf, ['work', 'finance'], true, false).map((h) => h.id)).toEqual(['w1', 'f1', 'n1']);
  });
  it('empty corner: lock yields only unlabeled (诚实空角,不报错)', () => {
    expect(hardFilterByHallLock(hits, hallOf, ['health'], true, false).map((h) => h.id)).toEqual(['n1']);
  });
});

describe('session hall lock storage (task_18①: 同存储/写穿/正交/跨切档保留)', () => {
  it('isHallCorner accepts 8 corner ids only', () => {
    expect(isHallCorner('work')).toBe(true);
    expect(isHallCorner('finance')).toBe(true);
    expect(isHallCorner('general')).toBe(false); // 兜底值不是角,不可锁定
    expect(isHallCorner('bogus')).toBe(false);
  });

  it('setHall persists, survives cross-mode switch, and recall override is orthogonal', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'dsh-hall-'));
    const store = new SessionModeStore(dir, 'auto');
    store.setHall('s1', ['finance'], { includeUnlabeled: false, includeGeneral: true });
    store.setRecall('s1', false); // 注入覆盖不动锁域(正交)
    store.set('s1', 'work'); // 切档不动锁域(跨切档保留)
    await store.flush(); // 写穿是异步链,落盘后再验证
    expect(store.getHall('s1')).toBe('finance');
    expect(store.getRecall('s1')).toBe(false);
    expect(store.hallBoundaries('s1')).toEqual({ includeUnlabeled: false, includeGeneral: true });
    // 写穿:新实例从盘上读回
    const reloaded = new SessionModeStore(dir, 'auto');
    await reloaded.init();
    expect(reloaded.getHall('s1')).toBe('finance');
    // 回中心 = 清除锁定
    store.setHall('s1', undefined);
    expect(store.getHalls('s1')).toEqual([]);
    // 多选:两域锁定 + 单角镜像兼容键
    store.setHall('s2', ['work', 'finance']);
    expect(store.getHalls('s2')).toEqual(['work', 'finance']);
    expect(store.getHall('s2')).toBe('work');
    store.setHall('s2', []);
    expect(store.getHalls('s2')).toEqual([]);
  });
});

describe('hall 角序与拖动配额(2026-09-23)', () => {
  it('居家在健康之前(用户要求对调)', () => {
    const ids = HALL_CATALOG.map((h) => h.id);
    expect(ids.indexOf('home')).toBeLessThan(ids.indexOf('health'));
  });

  it('normalizeHallWeights 只认 8 角、clamp 到 [0,1.5]、全非法返回 undefined', () => {
    expect(normalizeHallWeights({ work: 1.2, 健康: 0.5, general: 3 })).toEqual({ work: 1.2 });
    expect(normalizeHallWeights({ work: 9, home: -1 })).toEqual({ work: HALL_WEIGHT_MAX, home: 0 });
    expect(normalizeHallWeights({})).toBeUndefined();
    expect(normalizeHallWeights('x')).toBeUndefined();
  });

  it('applyHallWeights 相乘叠加,未拖过的角保持中性', () => {
    const gate = { work: 0.8, home: 0.4, health: 1 };
    expect(applyHallWeights(gate, null)).toEqual(gate);
    const merged = applyHallWeights(gate, { work: 0, health: 1.5 });
    expect(merged.work).toBe(0); // 拖到底 = 抑制
    expect(merged.home).toBe(0.4); // 没拖过 = 自动判定原样
    expect(merged.health).toBeCloseTo(1.5, 5);
  });

  it('gateByDomainWeights:权重 0 的域整条剔除,其余按权重降序', () => {
    const hits = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.9 },
      { id: 'c', score: 0.1 },
    ];
    const hallOf = (id: string) => ({ a: 'work', b: 'home', c: 'health' })[id];
    const out = gateByDomainWeights(hits, hallOf, { work: 0, home: 1.5, health: 0.4 });
    expect(out.map((h) => h.id)).toEqual(['b', 'c']); // a(work) 被抑制剔除
  });

  it('域权重:写穿 + 与锁域/档位正交 + 跨切档保留', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'dsh-hallw-'));
    const store = new SessionModeStore(dir, 'auto');
    store.setHallWeights('s1', { finance: 0, work: 1.4, 非法域: 2 });
    store.setHall('s1', ['work']); // 锁域不动权重(正交)
    store.set('s1', 'work'); // 切档不动权重
    await store.flush();
    expect(store.getHallWeights('s1')).toEqual({ finance: 0, work: 1.4 });
    expect(store.getHalls('s1')).toEqual(['work']);
    const reloaded = new SessionModeStore(dir, 'auto');
    await reloaded.init();
    expect(reloaded.getHallWeights('s1')).toEqual({ finance: 0, work: 1.4 });
    // 复位:空对象 = 清除偏置
    store.setHallWeights('s1', {});
    expect(store.getHallWeights('s1')).toEqual({});
  });
});
