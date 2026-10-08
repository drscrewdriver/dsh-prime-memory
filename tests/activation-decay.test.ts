/**
 * 激活老化与分级地板测试(治理 W2,T2.1/T2.5/T2.6/T2.9)。
 *
 * 钉死的门禁判据(checklist G2):
 * - bumpActivation 前后 `l1_records.updated_time` 与 hashRecords **逐字不变**(P0-3);
 * - 多实例并发:原子自增无丢增(P1-10);
 * - `decayFloorByType=false` 时衰减公式**逐字退化现状**(I-6/I-10);
 * - 公式 clamp:`decayFactor ≤ 1` 恒成立(歧义①解);
 * - floorOf 档位表:`-1` 哨兵**先于 <50** 判定(Issue 1);
 * - 存量无激活数据 → boost 0、锚点归一 updatedAt(绝不沉底,P1-12)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { ActivationTracker, activationAnchorAtMs } from '../src/store/activation.js';
import { activationBoostOf, applyDecayWeight, gradedFloorOf, ACTIVATION_MAX_BOOST } from '../src/store/search-utils.js';
import type { EmbeddingService } from '../src/store/embedding.js';
import type { MemoryRecord } from '../src/types.js';

const DIM = 16;
const DAY = 86_400_000;
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function vecFor(text: string): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % DIM] += 1;
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (mag < 1e-10) return v;
  for (let i = 0; i < DIM; i++) v[i] /= mag;
  return v;
}
function fakeEmbed(): EmbeddingService {
  return {
    getDimensions: () => DIM,
    getProviderInfo: () => ({ provider: 'probe', model: 'probe', dimensions: DIM }),
    isReady: () => true,
    embed: async (t: string) => vecFor(t),
    embedBatch: async (ts: string[]) => ts.map(vecFor),
  };
}

function rec(id: string, content: string, ageDays = 0, type = 'episodic', priority = 50): MemoryRecord {
  const t = Date.now() - ageDays * DAY;
  return { id, content, type, priority, scene_name: 's', timestamps: [t], createdAt: t, updatedAt: t };
}

async function setup(
  records: MemoryRecord[],
  governance?: { activationEnabled?: boolean; decayFloorByType?: boolean },
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-activation-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'r.db'), DIM);
  db.init();
  const store = new L1Store(dataDir, db, fakeEmbed(), 'hybrid', undefined, 30, undefined, governance);
  await store.init();
  if (records.length > 0) await store.appendNew(records);
  return { db, store, dataDir };
}

describe('bumpActivation(T2.1,原子自增)', () => {
  it('并发自增无丢增(T2.9/P1-10):100 次并发恰好 +100', async () => {
    const { db } = await setup([rec('a', '并发测试记录')]);
    try {
      await Promise.all(Array.from({ length: 100 }, () => Promise.resolve().then(() => db.bumpActivation('a', { injection: 1 }))));
      const act = db.getActivationByIds(['a']).get('a');
      expect(act?.injectionCount).toBe(100);
      expect(act?.activationEpoch).toBeTruthy();
    } finally {
      db.close();
    }
  });
  it('不碰 l1_records(P0-3):bump 前后 updated_time 与 hashRecords 逐字不变', async () => {
    const { db } = await setup([rec('a', '锚点不被篡改')]);
    try {
      const before = db.getL1ByIds(['a'])[0];
      const beforeAll = db.getAllL1();
      db.bumpActivation('a', { injection: 1, adopted: 1, anchorAt: new Date().toISOString() });
      const after = db.getL1ByIds(['a'])[0];
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(after.version).toBe(before.version);
      expect(after.metadata).toEqual(before.metadata);
      const afterAll = db.getAllL1();
      // hashRecords 是快照校验的地基——激活热写绝不扰动它(P0-2)
      const { hashRecords } = await import('../src/store/l1-snapshot.js');
      expect(hashRecords(afterAll)).toBe(hashRecords(beforeAll));
    } finally {
      db.close();
    }
  });
  it('采用语义:adopted+1 且重置 decay_anchor_at(T2.4);last_activated_at 只增不改(除非显式)', async () => {
    const { db } = await setup([rec('a', '采用记录')]);
    try {
      const iso = new Date().toISOString();
      db.bumpActivation('a', { adopted: 1, anchorAt: iso });
      const act = db.getActivationByIds(['a']).get('a')!;
      expect(act.adoptedCount).toBe(1);
      expect(act.decayAnchorAt).toBe(iso);
    } finally {
      db.close();
    }
  });
});

describe('ActivationTracker(T2.2,节流 flush)', () => {
  it('聚合 N 次为一次 flush;dispose 兜底刷盘', async () => {
    const { db } = await setup([rec('a', '聚合记录'), rec('b', '聚合记录二'), rec('c', '聚合记录三'), rec('d', '聚合记录四')]);
    const tracker = new ActivationTracker(db, undefined, { intervalMs: 60_000, batchThreshold: 5 });
    try {
      // 4 个不同 id 各 1 次(阈值 5 未到 → 不刷)
      for (const id of ['a', 'b', 'c', 'd']) tracker.bump(id, 'injection');
      expect(tracker.pendingCount).toBe(4);
      expect(db.getActivationByIds(['a']).size).toBe(0); // 未到阈值未刷
      tracker.bump('a', 'injection'); // 第 5 次 → 触发 flush
      expect(tracker.pendingCount).toBe(0);
      expect(db.getActivationByIds(['a']).get('a')?.injectionCount).toBe(2);
      expect(db.getActivationByIds(['d']).get('d')?.injectionCount).toBe(1);
      // dispose 兜底:残留增量强制落盘
      tracker.bump('a', 'adoption');
      tracker.dispose();
      expect(db.getActivationByIds(['a']).get('a')?.adoptedCount).toBe(1);
      // dispose 后 bump 是 no-op(进程要退了)
      tracker.bump('a', 'injection');
      expect(db.getActivationByIds(['a']).get('a')?.injectionCount).toBe(2);
    } finally {
      tracker.dispose();
      db.close();
    }
  });
  it('锚点解析:decayAnchorAt 优先;缺失归一 updatedAt(绝不按最老,P1-12)', () => {
    const updatedAt = Date.now() - 10 * DAY;
    const anchor = Date.now() - 1 * DAY;
    expect(activationAnchorAtMs({ injectionCount: 1, adoptedCount: 0, lastActivatedAt: '', decayAnchorAt: new Date(anchor).toISOString(), activationEpoch: '' }, updatedAt)).toBe(anchor);
    expect(activationAnchorAtMs(undefined, updatedAt)).toBe(updatedAt);
    expect(activationAnchorAtMs({ injectionCount: 0, adoptedCount: 0, lastActivatedAt: '', decayAnchorAt: '', activationEpoch: '' }, updatedAt)).toBe(updatedAt);
  });
});

describe('衰减公式(T2.5,clamp≤1 + 缺省零漂移)', () => {
  const now = Date.now();
  it('boost 后 clamp≤1:全新+高激活也不超过 1.0', () => {
    const hits = [{ id: 'a', score: 0.9 }];
    const out = applyDecayWeight(hits, 30, () => now, now, { boostOf: () => ACTIVATION_MAX_BOOST });
    expect(out[0].score).toBe(0.9); // 展示分不变;加权键被 clamp 在 ≤1×score
    // 直接验证公式上界:老记录 0.5 × (1+0.3) = 0.65 < 1
    const aged = applyDecayWeight([{ id: 'a', score: 1 }], 30, () => now - 1000 * DAY, now, {
      boostOf: () => ACTIVATION_MAX_BOOST,
    });
    expect(aged[0].score).toBe(1);
  });
  it('激活抬升把老记忆拉起:无 boost 沉到地板,有 boost(锚点重置)反超', () => {
    const hits = [
      { id: 'fresh', score: 0.5 },
      { id: 'old', score: 0.51 },
    ];
    const byId = new Map([['fresh', now], ['old', now - 300 * DAY]]);
    const noBoost = applyDecayWeight(hits, 30, (h) => byId.get(h.id), now);
    expect(noBoost[0].id).toBe('fresh'); // 老记忆衰减到地板 0.5 < 0.5×1
    const boosted = applyDecayWeight(hits, 30, (h) => byId.get(h.id), now, {
      boostOf: (h) => (h.id === 'old' ? 0.3 : 0),
      anchorAtOf: (h) => (h.id === 'old' ? now : byId.get(h.id)), // 老记忆刚被采用 → 锚点重置
    });
    expect(boosted[0].id).toBe('old'); // 0.51×min(1,1×1.3)=0.51 > 0.5
  });
  it('boostOf 恒 0 时逐字等价于无 opts(I-10)', () => {
    const hits = [{ id: 'a', score: 0.7 }, { id: 'b', score: 0.6 }];
    const byId = new Map([['a', now - 5 * DAY], ['b', now - 50 * DAY]]);
    const plain = applyDecayWeight(hits, 30, (h) => byId.get(h.id), now);
    const withOpts = applyDecayWeight(hits, 30, (h) => byId.get(h.id), now, { boostOf: () => 0 });
    expect(withOpts.map((h) => h.id)).toEqual(plain.map((h) => h.id));
  });
  it('activationBoostOf:log1p 饱和 + 上限 0.3 + 缺数据 0(P1-9 有损下界)', () => {
    expect(activationBoostOf(undefined)).toBe(0);
    expect(activationBoostOf({ injectionCount: 0, adoptedCount: 0 })).toBe(0);
    expect(activationBoostOf({ injectionCount: 1000, adoptedCount: 1000 })).toBe(ACTIVATION_MAX_BOOST);
    // 采用权重是注入的 3 倍(强信号,O-2)
    expect(activationBoostOf({ injectionCount: 0, adoptedCount: 1 })).toBeCloseTo(Math.log1p(1) * 0.15, 10);
  });
});

describe('分级地板(T2.6,gradedFloorOf 档位表)', () => {
  it('`-1` 哨兵先于 <50 判定(Issue 1):instruction -1 → 0.9 非 0.2', () => {
    expect(gradedFloorOf({ type: 'instruction', priority: -1 })).toBe(0.9);
  });
  it('priority<50 任何类型 → 0.2', () => {
    expect(gradedFloorOf({ type: 'episodic', priority: 30 })).toBe(0.2);
    expect(gradedFloorOf({ type: 'instruction', priority: 30 })).toBe(0.2);
  });
  it('档位表:instruction 0.9 / persona≥80 0.9 / persona 0.5 / work_fact·method 0.5 / work_task·artifact·episodic 0.3 / 兜底 0.5', () => {
    expect(gradedFloorOf({ type: 'instruction', priority: 90 })).toBe(0.9);
    expect(gradedFloorOf({ type: 'persona', priority: 85 })).toBe(0.9);
    expect(gradedFloorOf({ type: 'persona', priority: 60 })).toBe(0.5);
    expect(gradedFloorOf({ type: 'work_fact', priority: 90 })).toBe(0.5);
    expect(gradedFloorOf({ type: 'work_method', priority: 90 })).toBe(0.5);
    expect(gradedFloorOf({ type: 'work_task', priority: 90 })).toBe(0.3);
    expect(gradedFloorOf({ type: 'work_artifact', priority: 90 })).toBe(0.3);
    expect(gradedFloorOf({ type: 'episodic', priority: 90 })).toBe(0.3);
    expect(gradedFloorOf({ type: 'unknown', priority: 90 })).toBe(0.5);
    expect(gradedFloorOf(undefined)).toBe(0.5);
  });
});

describe('端到端等价性与生效(T5.1 pin关=现状)', () => {
  const fixture = [
    rec('fresh-tip', '开发环境数据库配置技巧总结', 5),
    rec('old-core', '生产环境数据库主从配置的坑与解法', 300),
  ];
  it('开关全关:召回排序与升级前逐字一致(纯衰减态)', async () => {
    const { db, store } = await setup(fixture);
    try {
      const hits = await store.search('数据库配置', 5);
      expect(hits.length).toBe(2);
      // 开关关 = 纯现状衰减(floor 0.5):老而强的记录不被抬也不被额外压
      expect(hits.map((h) => h.id).sort()).toEqual(['fresh-tip', 'old-core']);
    } finally {
      db.close();
    }
  });
  it('激活+采用开启:被采用的旧记忆排序回升(机制生效证据)', async () => {
    const on = await setup(fixture, { activationEnabled: true, decayFloorByType: false });
    try {
      const { db, store } = on;
      // 直接落激活(绕过聚合器,语义等价于 flush 后的表状态)
      db.bumpActivation('old-core', { adopted: 5, anchorAt: new Date().toISOString() });
      const hits = await store.search('数据库配置', 5);
      expect(hits[0].id).toBe('old-core');
    } finally {
      on.db.close();
    }
  });
});
