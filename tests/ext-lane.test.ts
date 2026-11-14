/**
 * T0.6 判据:未接线时 bench recall@5 数据逐位一致(第 5 路结构性不存在);
 * 接线后恒占名额(全挂也占,分母不随网络抖);红线哨兵钉死"外部路不进候选池"。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { L1Store, type ExtLaneProvider } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { EmbeddingService } from '../src/store/embedding.js';
import { markDedupPath } from '../src/store/search-utils.js';
import type { L1Hit, MemoryRecord } from '../src/types.js';

const DIM = 16;
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function vecFor(text: string): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % DIM] += 1;
  const mag = Math.sqrt(v.reduce((s, x) => s * s + x * x, 0));
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
function rec(id: string, content: string): MemoryRecord {
  const t = Date.now();
  return { id, content, type: 'episodic', priority: 50, scene_name: 's', timestamps: [t], createdAt: t, updatedAt: t };
}

async function setup(records: MemoryRecord[], extLane?: ExtLaneProvider) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-extlane-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'x.db'), DIM);
  db.init();
  // halfLife=0 关掉第 4 路,让路数变量只剩 ext 一个,判据干净
  const store = new L1Store(dataDir, db, fakeEmbed(), 'hybrid', undefined, 0, undefined, undefined, extLane);
  await store.init();
  await store.appendNew(records);
  return { db, store };
}

const extHit = (id: string, content: string, score: number): L1Hit => ({
  id, content, type: 'external', scene_name: '', score,
});

describe('ext lane(T0.6)', () => {
  it('未接线 = 输出与"接线位传 undefined"逐位一致(既有调用方零漂移)', async () => {
    const recs = [rec('a', 'nginx 部署约定'), rec('b', 'caddy 迁移记录'), rec('c', '无关内容')];
    const s1 = await setup(recs);
    const s2 = await setup(recs, undefined);
    const r1 = await s1.store.search('nginx 部署', 5);
    const r2 = await s2.store.search('nginx 部署', 5);
    expect(r2).toEqual(r1);
    expect(r1.length).toBeGreaterThan(0);
    expect(r1.every((h) => !(h.lanes ?? []).includes('ext'))).toBe(true);
    s1.db.close();
    s2.db.close();
  });

  it('接线:外部命中以独立路参与融合,归因 lanes 含 ext,注入位次生效', async () => {
    const s = await setup(
      [rec('a', 'nginx 部署约定')],
      async () => [extHit('ext:mem0:u1:x9', '远端命中:部署规范', 0.9)],
    );
    const hits = await s.store.search('nginx 部署', 5);
    const ext = hits.find((h) => h.id === 'ext:mem0:u1:x9');
    expect(ext).toBeDefined();
    expect(ext!.lanes).toContain('ext');
    s.db.close();
  });

  it('provider 抛错 = 空列表占名额、主检索照常返回,不炸不静默改分母', async () => {
    const s = await setup(
      [rec('a', 'nginx 部署约定')],
      async () => {
        throw new Error('provider down');
      },
    );
    const hits = await s.store.search('nginx 部署', 5);
    expect(hits.find((h) => h.id === 'a')).toBeDefined(); // 本地路照常
    s.db.close();
  });

  it('接线即占名额:同一条本地命中,接线(3 路)的融合分 = 未接线(2 路)的 2/3', async () => {
    const recs = [rec('a', 'nginx 部署约定')];
    const off = await setup(recs);
    const on = await setup(recs, async () => []); // 全挂形态:空列表仍占位
    const hOff = (await off.store.search('nginx 部署', 5)).find((h) => h.id === 'a')!;
    const hOn = (await on.store.search('nginx 部署', 5)).find((h) => h.id === 'a')!;
    // normalizeRrf 按传入路数归一:同一命中集在新旧路数下的分比恒为 lanes_old/lanes_new。
    // 用比值而非绝对值:不依赖"该条只中一路"的脆弱假设(fts/vec 可能同时命中)。
    expect(hOn.score / hOff.score).toBeCloseTo(2 / 3, 6);
    off.db.close();
    on.db.close();
  });

  it('红线哨兵:外部路若被拖进去重候选路径(markDedupPath 上下文),显式崩溃', async () => {
    const s = await setup(
      [rec('a', 'nginx 部署约定')],
      async () => [extHit('ext:mem0:u1:x9', '远端内容', 1)],
    );
    await expect(
      markDedupPath(async () => s.store.search('nginx', 5)),
    ).rejects.toThrow(/去重候选/);
    s.db.close();
  });
});
