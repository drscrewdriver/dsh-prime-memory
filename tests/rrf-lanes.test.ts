/**
 * §D RRF 多路归一化(task_8)+ 2 路无漂移(task_11)。
 *
 * 背景:`search()` 的 hybrid 路径把若干条已排序列表交给 `rrfMerge` 融合,再把
 * 融合分(n 路 rank1 全中 = n/(k+1))归一化到 0~1。原实现把分母**硬编码成 2**,
 * 只对「FTS + 向量」双路成立;扩到 3/4 路后满分变成 3/(k+1)、4/(k+1),
 * 归一后分别达到 1.5、2.0,**越出 0~1 契约**。
 *
 * 修正:按**实际路数**归一(`(rrfScore * (k+1)) / lanes`)。2 路时该式与旧式
 * 逐字等价——这正是 task_11「无行为漂移」的判据来源。
 *
 * 为何按「传入的路数」而非「非空路数」:向量源不可用时 `search()` 仍传两条列表
 * (其一为空),此时旧实现给 FTS rank1 的分数是 0.5(1/(k+1) × (k+1)/2)。
 * 若改按非空路数归一,该场景会变成 1.0——**恰好破坏 task_11 的无漂移判据**。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RRF_K, normalizeRrf, rrfMerge, applyDecayWeight } from '../src/store/search-utils.js';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { EmbeddingService } from '../src/store/embedding.js';

/** 旧实现(改动前)的 2 路归一化式,逐字保留作为差分基准。 */
function normalizeRrfLegacy2Lane(rrfScore: number): number {
  return (rrfScore * (RRF_K + 1)) / 2;
}

describe('task_8 §D RRF 归一到 0~1(按实际路数)', () => {
  it('2 路:双列表 rank1 命中 = 1.0,单列表 rank1 命中 = 0.5', () => {
    const both = 2 / (RRF_K + 1);
    const single = 1 / (RRF_K + 1);
    expect(normalizeRrf(both, 2)).toBe(1);
    expect(normalizeRrf(single, 2)).toBe(0.5);
  });

  it('4 路:全列表 rank1 = 1.0(边界不越界),单列表 rank1 = 0.25', () => {
    expect(normalizeRrf(4 / (RRF_K + 1), 4)).toBe(1);
    expect(normalizeRrf(1 / (RRF_K + 1), 4)).toBe(0.25);
    expect(normalizeRrf(2 / (RRF_K + 1), 4)).toBe(0.5);
    expect(normalizeRrf(3 / (RRF_K + 1), 4)).toBe(0.75);
  });

  it('3 路同样归一(为 task_9 图谱路留位)', () => {
    expect(normalizeRrf(3 / (RRF_K + 1), 3)).toBe(1);
    expect(normalizeRrf(1 / (RRF_K + 1), 3)).toBeCloseTo(1 / 3, 12);
  });

  it('穷举 1~6 路 × 各排名子集:得分恒落在 0.0~1.0', () => {
    let max = 0;
    let min = 1;
    for (let lanes = 1; lanes <= 6; lanes++) {
      for (let hitLanes = 1; hitLanes <= lanes; hitLanes++) {
        for (let rank = 0; rank < 20; rank++) {
          const raw = hitLanes / (RRF_K + rank + 1);
          const s = normalizeRrf(raw, lanes);
          expect(s).toBeGreaterThan(0);
          expect(s).toBeLessThanOrEqual(1);
          max = Math.max(max, s);
          min = Math.min(min, s);
        }
      }
    }
    // 实测区间:满分 1.0 由「全路 rank1」取到,下界由「6 路 rank20 单路」取到
    expect(max).toBe(1);
    expect(min).toBeCloseTo((1 / (RRF_K + 20)) * ((RRF_K + 1) / 6), 12);
  });

  it('守卫:路数非正/非有限时归零(退化输入不产生 NaN/Infinity)', () => {
    expect(normalizeRrf(1 / (RRF_K + 1), 0)).toBe(0);
    expect(normalizeRrf(1 / (RRF_K + 1), -1)).toBe(0);
    expect(normalizeRrf(1 / (RRF_K + 1), Number.NaN)).toBe(0);
    expect(normalizeRrf(1 / (RRF_K + 1), Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('task_11 §D 2 路无漂移(与改动前逐值一致)', () => {
  it('恒等式:任意融合分下 normalizeRrf(s, 2) === 旧式(s × (k+1) / 2)', () => {
    for (let lanes = 1; lanes <= 2; lanes++) {
      for (let rank = 0; rank < 30; rank++) {
        for (const hitLanes of [1, 2]) {
          const raw = hitLanes / (RRF_K + rank + 1);
          expect(normalizeRrf(raw, 2)).toBe(normalizeRrfLegacy2Lane(raw));
        }
      }
    }
    // 任意实数域上亦逐值相同(归一化是纯比例变换)
    for (const raw of [0, 1e-9, 0.017, 0.5, 1, 2 / 61, 123.456]) {
      expect(normalizeRrf(raw, 2)).toBe(normalizeRrfLegacy2Lane(raw));
    }
  });

  it('融合层差分:2 路 RRF + 归一的结果与旧式逐值相同', () => {
    const fts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const vec = [{ id: 'a' }, { id: 'c' }, { id: 'd' }];
    const merged = rrfMerge([fts, vec], (h) => h.id);
    for (const m of merged) {
      expect(normalizeRrf(m.rrfScore, 2)).toBe(normalizeRrfLegacy2Lane(m.rrfScore));
    }
    // 抽样固化:a 为双列表 rank1 → 2/(k+1) → 恰好 1.0;c 为两列表次席/三席
    const byId = new Map(merged.map((m) => [m.id, normalizeRrf(m.rrfScore, 2)]));
    expect(byId.get('a')).toBe(1);
    expect(byId.get('c')).toBe(normalizeRrfLegacy2Lane(1 / 63 + 1 / 62));
    expect(byId.get('b')).toBe(normalizeRrf(1 / 62, 2)); // 仅 FTS rank2 命中 → 低于单路天花板 0.5
    expect(byId.get('b')).toBeLessThan(0.5);
  });

  it('端到端差分:真实 hybrid search() 的 2 路得分与改动前留档逐位一致', async () => {
    // 基线留档:.agents/plans/dsh-prime-memory-capability-fusion/evidence/task11-2lane-before.json
    // (host: 2026-09-16, sqlite-vec 可用, ftsSearch/vectorSearch 均 true)
    const dataDir = await probeTmp();
    const db = new MemoryDb(join(dataDir, 'no-drift.db'), PROBE_DIM);
    db.init();
    try {
      expect(db.getCapabilities()).toEqual({ ftsSearch: true, vectorSearch: true });
      const store = new L1Store(dataDir, db, probeEmbed(), 'hybrid', undefined, 0);
      await store.init();
      const now = Date.now();
      await store.appendNew([
        { id: 'a', content: '用户对 Rust 感兴趣', type: 'preference', priority: 60, scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now },
        { id: 'b', content: '用户对 Rust 编译器感兴趣', type: 'preference', priority: 60, scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now },
        { id: 'c', content: '团队用 GitLab CI 做持续集成', type: 'work_fact', priority: 50, scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now },
        { id: 'd', content: '今天天气不错', type: 'episodic', priority: 50, scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now },
      ]);
      const hits = await store.search('Rust 感兴趣', 5);
      expect(hits.map((h) => [h.id, h.score])).toEqual([
        ['a', 1],
        ['b', 0.9838709677419355],
        ['c', 0.4841269841269841],
        ['d', 0.4765625],
      ]);
      // 与旧式的一致性(不依赖留档常量)
      for (const h of hits) expect(h.score).toBeCloseTo(normalizeRrfLegacy2Lane(h.score * 2 / (RRF_K + 1)), 12);
    } finally {
      db.close();
    }
  });

  it('回归:衰减加权不因本改动改变语义(仍为乘法+重排,原 score 不被改写)', () => {
    const hits = [
      { id: 'x', score: 1 },
      { id: 'y', score: 0.9 },
    ];
    const out = applyDecayWeight(hits, 30, (h) => (h.id === 'y' ? Date.now() : 0));
    expect(out.map((h) => h.id)).toEqual(['y', 'x']); // 新记录轮转名次
    expect(out.find((h) => h.id === 'x')?.score).toBe(1); // 展示分不被改写
  });
});

// ---- 端到端差分用固定装置(与探针脚本逐字相同,保证基线可比) ----
const PROBE_DIM = 16;
let probeDir: string;
async function probeTmp(): Promise<string> {
  probeDir = await mkdtemp(join(tmpdir(), 'dsh-rrf-nodrift-'));
  return probeDir;
}
afterAll(async () => {
  if (probeDir) await rm(probeDir, { recursive: true, force: true });
});

function probeVec(text: string): Float32Array {
  const v = new Float32Array(PROBE_DIM);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % PROBE_DIM] += 1;
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (mag < 1e-10) return v;
  for (let i = 0; i < PROBE_DIM; i++) v[i] /= mag;
  return v;
}
function probeEmbed(): EmbeddingService {
  return {
    getDimensions: () => PROBE_DIM,
    getProviderInfo: () => ({ provider: 'probe', model: 'probe', dimensions: PROBE_DIM }),
    isReady: () => true,
    embed: async (t: string) => probeVec(t),
    embedBatch: async (ts: string[]) => ts.map(probeVec),
  };
}
