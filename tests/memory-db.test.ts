/**
 * MemoryDb 单元测试(真实 node:sqlite,内存/临时文件库)。
 * 重点:DDL 兼容、双写不变量(FTS 与元数据同事务)、FTS/向量检索、skip 集上限、
 * 分词器戳重建、成本账本聚合。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryDb, isZeroVector } from '../src/store/sqlite.js';
import { bm25RankToScore, buildFtsQuery, rrfMerge, applyDecayWeight, tokenizeForFts, RRF_K, DECAY_FLOOR } from '../src/store/search-utils.js';
import type { MemoryRecord } from '../src/types.js';

let dir: string;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function tmpDir(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-db-'));
  return dir;
}

function rec(id: string, content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id,
    content,
    type: 'episodic',
    priority: 50,
    scene_name: '日常',
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 0,
    metadata: {},
    sessionId: 'default',
    family: 'chat',
    ...overrides,
  };
}

describe('search-utils', () => {
  it('rrfMerge fuses ranked lists with 1/(k+rank+1) and accumulates', () => {
    const a = [{ id: 'x' }, { id: 'y' }];
    const b = [{ id: 'y' }, { id: 'z' }];
    const merged = rrfMerge([a, b], (i) => i.id);
    const byId = new Map(merged.map((m) => [m.id, m.rrfScore]));
    expect(byId.get('y')).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 1));
    expect(byId.get('x')).toBeCloseTo(1 / (RRF_K + 1));
    expect(byId.get('z')).toBeCloseTo(1 / (RRF_K + 2));
    expect(merged[0].id).toBe('y');
  });

  it('bm25RankToScore maps negative rank (more relevant) to higher score', () => {
    // FTS5 bm25 越负越相关 → 绝对值越大分数越高
    expect(bm25RankToScore(-10)).toBeGreaterThan(bm25RankToScore(-1));
    expect(bm25RankToScore(-1)).toBe(0.5);
    expect(bm25RankToScore(Number.NaN)).toBe(1 / 1000);
    expect(bm25RankToScore(3)).toBe(0.25);
  });

  it('buildFtsQuery OR-joins quoted tokens and drops stop words', () => {
    const q = buildFtsQuery('负载均衡的配置');
    expect(q).toBeTruthy();
    expect(q).not.toContain('"的"'); // 停用词不作为独立 token(二元组内的 的 属正常)
    expect(q).toContain('"');
    expect(buildFtsQuery('!!! ???')).toBeNull(); // 无有效 token → null(全停用词输入仍会留下二元组,原算法语义)
  });

  it('applyDecayWeight rescales order only and floors at DECAY_FLOOR', () => {
    const now = Date.now();
    const hits = [
      { id: 'old', score: 0.6 },
      { id: 'new', score: 0.5 },
    ];
    const out = applyDecayWeight(hits, 30, (h) => (h.id === 'old' ? now - 400 * 86_400_000 : now), now);
    expect(out[0].id).toBe('new');
    // 原始 score 不被改写
    expect(out[1].score).toBe(0.6);
    // 极老记忆权重 = 地板
    const aged = applyDecayWeight([{ id: 'a', score: 1 }], 1, () => now - 10_000 * 86_400_000, now);
    expect(aged[0].score).toBe(1); // 展示分不变
    // halfLifeDays <= 0 原样返回
    expect(applyDecayWeight(hits, 0, () => now)).toEqual(hits);
    expect(DECAY_FLOOR).toBe(0.5);
  });

  it('tokenizeForFts joins tokens with spaces (write side of FTS)', () => {
    expect(typeof tokenizeForFts('负载均衡 config')).toBe('string');
  });
});

describe('MemoryDb', () => {
  it('init/build capabilities with in-memory db (FTS available)', async () => {
    const db = new MemoryDb(join(await tmpDirSafe(), 't1.db'), 0);
    const res = db.init();
    expect(res.needsReindex).toBe(false);
    expect(db.isDegraded()).toBe(false);
    expect(db.getCapabilities().ftsSearch).toBe(true);
    db.close();
  });

  it('upsert + FTS search roundtrip; batch failure rolls back whole batch', async () => {
    const db = new MemoryDb(join(await tmpDirSafe(), 't2.db'), 0);
    db.init();
    expect(db.upsertL1(rec('m1', '用户喜欢手冲咖啡,每周三次'))).toBe(true);
    expect(db.upsertL1Batch([rec('m2', '用户在杭州工作'), rec('m3', '用户的猫叫团子')])).toBe(true);
    expect(db.countL1()).toBe(3);

    const hits = db.searchL1Fts('咖啡', 5);
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe('m1');
    expect(hits[0].score).toBeGreaterThan(0);

    // 覆盖写:点查预判删除旧 FTS 行,不产生重复命中
    expect(db.upsertL1(rec('m1', '用户喜欢手冲咖啡,每周三次,偏爱浅烘'))).toBe(true);
    expect(db.searchL1Fts('浅烘', 5).map((h) => h.id)).toEqual(['m1']);
    expect(db.searchL1Fts('浅烘', 5).length).toBe(1);

    // 整批含坏记录(缺 content → NOT NULL 约束失败)→ 整批回滚 + 逐条回退:
    // 好记录照常入库,坏记录只丢自身;仍有失败 → 返回 false
    const bad = { id: 'bad', content: undefined, timestamps: [] } as unknown as MemoryRecord;
    expect(db.upsertL1Batch([rec('m4', '正常记录'), bad])).toBe(false);
    expect(db.countL1()).toBe(4); // m4 逐条回退成功,bad 只丢自身
    db.close();
  });

  it('deleteL1Batch removes metadata + FTS rows together', async () => {
    const db = new MemoryDb(join(await tmpDirSafe(), 't3.db'), 0);
    db.init();
    db.upsertL1Batch([rec('d1', '待删除记录一'), rec('d2', '待删除记录二'), rec('d3', '保留记录')]);
    expect(db.deleteL1Batch(['d1', 'd2'])).toBe(2);
    expect(db.countL1()).toBe(1);
    expect(db.searchL1Fts('待删除', 5)).toEqual([]);
    expect(db.searchL1Fts('保留', 5).length).toBe(1);
    db.close();
  });

  it('listL1 filters by type/scene/family with total and pagination', async () => {
    const db = new MemoryDb(join(await tmpDirSafe(), 't4.db'), 0);
    db.init();
    db.upsertL1Batch([
      rec('a', '工作记忆一', { type: 'work_fact', family: 'work', scene_name: '项目' }),
      rec('b', '个人记忆二', { type: 'preference' }),
      rec('c', '工作记忆三', { type: 'work_task', family: 'work', scene_name: '项目' }),
    ]);
    const page = db.listL1({ family: 'work', limit: 1, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items.length).toBe(1);
    expect(db.distinctL1Scenes().sort()).toEqual(['日常', '项目']);
    db.close();
  });

  it('L0 batch upsert + session queries', async () => {
    const db = new MemoryDb(join(await tmpDirSafe(), 't5.db'), 0);
    db.init();
    const now = Date.now();
    const ok = db.upsertL0Batch([
      { sessionId: 's1', recordedAt: new Date(now).toISOString(), id: 'l0-1', role: 'user', content: '今天午饭吃了牛肉面', timestamp: now },
      { sessionId: 's1', recordedAt: new Date(now).toISOString(), id: 'l0-2', role: 'assistant', content: '牛肉面很不错', timestamp: now + 1 },
      { sessionId: 's2', recordedAt: new Date(now).toISOString(), id: 'l0-3', role: 'user', content: '明天天气怎么样', timestamp: now + 2 },
    ]);
    expect(ok).toBe(true);
    expect(db.countL0()).toBe(3);
    expect(db.countL0BySession('s1')).toBe(2);
    expect(db.countL0Since(new Date(now).toISOString())).toBe(3);
    expect(db.recentL0BySession('s1', 2).map((m) => m.id)).toEqual(['l0-1', 'l0-2']);
    expect(db.l0RebuildEstimate().sessions).toBe(2);
    const fts = db.searchL0Fts('牛肉面', 5);
    expect(fts.map((h) => h.id)).toContain('l0-1');
    db.close();
  });

  it('degraded db turns every write/read into safe no-op', async () => {
    // 目录路径当库文件 → 开库必失败 → 降级
    const db = new MemoryDb(await tmpDirSafe(), 0);
    db.init();
    expect(db.isDegraded()).toBe(true);
    expect(db.getCapabilities()).toEqual({ ftsSearch: false, vectorSearch: false });
    expect(db.upsertL1(rec('x', 'y'))).toBe(false);
    expect(db.upsertL1Batch([rec('x', 'y')])).toBe(false);
    expect(db.countL1()).toBe(0);
    expect(db.searchL1Fts('x', 5)).toEqual([]);
    expect(db.deleteL1Batch(['x'])).toBe(0);
    db.close();
  });

  it('skip set persists, caps at 900 and clears by kind', async () => {
    const path = join(await tmpDirSafe(), 't6.db');
    const db = new MemoryDb(path, 0);
    db.init();
    db.addVecSkippedIds('l1', ['a', 'b']);
    expect(db.getVecSkipSet('l1')).toEqual(new Set(['a', 'b']));
    expect(db.getVecSkipSet('l0')).toEqual(new Set());
    db.addVecSkippedIds('l1', Array.from({ length: 950 }, (_, i) => `id${i}`));
    expect(db.getVecSkipSet('l1').size).toBe(900); // 上限截断
    db.clearVecSkipIds('l1');
    expect(db.getVecSkipSet('l1').size).toBe(0);
    db.close();
  });

  it('vector-capable db stores and searches cosine vectors; zero vec skipped', async () => {
    const dims = 8;
    const db = new MemoryDb(join(await tmpDirSafe(), 't7.db'), dims);
    const init = db.init();
    expect(init.needsReindex).toBe(false);
    if (!db.getCapabilities().vectorSearch) {
      // sqlite-vec 在当前环境不可加载:验证降级路径而非跳过
      expect(db.getCapabilities().ftsSearch).toBe(true);
      db.close();
      return;
    }
    const e1 = new Float32Array(dims).fill(0.5);
    const e2 = new Float32Array(dims);
    e2[0] = 1;
    const zero = new Float32Array(dims);
    expect(isZeroVector(zero)).toBe(true);
    expect(db.upsertL1(rec('v1', '向量记录一'), e1)).toBe(true);
    expect(db.upsertL1(rec('v2', '零向量记录'), zero)).toBe(true); // 零向量跳过
    expect(db.countL1Vec()).toBe(1);
    const hits = db.searchL1Vector(e1, 5);
    expect(hits[0].id).toBe('v1');
    expect(hits[0].score).toBeCloseTo(1, 5);
    // provider 变化 → needsReindex + 向量表重建
    const swap = db.swapProvider({ provider: 'remote', model: 'm2', dimensions: dims });
    expect(swap.needsReindex).toBe(true);
    expect(db.countL1Vec()).toBe(0);
    db.markEmbeddingSynced({ provider: 'remote', model: 'm2', dimensions: dims });
    db.close();
  });

  it('cost ledger aggregates by window/model/layer/bucket', async () => {
    const db = new MemoryDb(join(await tmpDirSafe(), 't8.db'), 0);
    db.init();
    const now = Date.now();
    db.insertCostCall('p1', 'm1', 'l1-extract', 100, 50, 10, 365);
    db.insertCostCall('p1', 'm1', 'l1-dedup', 80, 30, 5, 365);
    db.insertCostCall('p2', 'm2', 'l2', 200, 90, 20, 365);
    const agg = db.aggregateCost(0);
    expect(agg.total.calls).toBe(3);
    expect(agg.total.inputChars).toBe(380);
    expect(agg.total.outputTokens).toBe(170);
    expect(agg.total.medianOutputTokens).toBe(50);
    expect(agg.byModel.length).toBe(2);
    const layers = db.aggregateCostByLayer(0);
    // GROUP BY layer 按输入列(原始层名)分组:两条 l1 明细各成一行、标签同为 'l1'
    // (SQLite 对 GROUP BY 裸名优先取输入列,与原实现逐字一致)
    const l1Rows = layers.filter((l) => l.layer === 'l1');
    expect(l1Rows.reduce((s, l) => s + l.calls, 0)).toBe(2);
    const buckets = db.aggregateByBucket(86_400_000, 0, 0, 'l1');
    expect(buckets.reduce((s, b) => s + b.calls, 0)).toBe(2);
    db.close();
  });
});

async function tmpDirSafe(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-db-'));
  return dir;
}
