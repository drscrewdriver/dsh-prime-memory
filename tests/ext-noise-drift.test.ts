/**
 * Phase 3 硬闸之二(T3 验收):**灌噪 600 条,recall 漂移可控**。
 *
 * 判据不是"分数一点不变"(那等于外部路没接进来),而是:
 * - 原有信号记忆的检索位次不被噪声挤出——top5 里至少 3 条仍在 top5,
 *   且 5 条全部仍在前 10(漂移有界);
 * - 外部回灌不产生重复(ext_key 幂等):600 条灌入后各只一条;
 * - 清理不扇出:物理清理退场记录**不**触发新的 forget 任务(不可逆动作的
 *   放大点在一次清理打到 N 家 hard-delete——扇出只发生在软退场汇流口)。
 *
 * 用 keyword 策略 + 真 L1Store(零嵌入服务依赖,CI 可跑)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import type { MemoryRecord } from '../src/types.js';
import { ExtDriverRegistry } from '../src/ext-memory/registry.js';
import { makeExtPuller, type ExtPullConfig } from '../src/ext-memory/puller.js';
import { EXT_DRIVER_SPECS } from '../src/ext-memory/types.js';
import type { ExternalHit, ExternalMemoryDriver } from '../src/ext-memory/types.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    for (let i = 0; i < 5; i++) {
      try {
        await rm(d, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
});

const NOISE = 600;

function sigRecord(i: number): MemoryRecord {
  const t = Date.now();
  return {
    id: `sig_${i}`,
    content: `部署约定 ${i}：生产环境一律使用 nginx 反代并启用 gzip,发布走蓝绿切换。`,
    type: 'work_fact',
    priority: 80,
    scene_name: 's',
    timestamps: [t],
    createdAt: t,
    updatedAt: t,
    family: 'work',
  };
}

function noiseHit(i: number): ExternalHit {
  return {
    driverId: 'hs',
    spaceId: 'hs:main',
    externalId: `noise-${i}`,
    // 与查询词故意弱相关(同领域词汇但语义噪声)
    content: `噪声事实 ${i}：窗台绿植浇水记录、办公用品领用签收、快递单号与会议室预约时段杂项。`,
  };
}

describe('灌噪 600 条 recall 漂移可控(硬闸)', () => {
  it('信号 top5 有界漂移 + ext_key 幂等不增殖 + 清理不新增扇出', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-noise-'));
    dirs.push(dataDir);
    const db = new MemoryDb(join(dataDir, 'm.db'), 0);
    db.init();
    const l1 = new L1Store(dataDir, db, undefined, 'keyword', undefined, 0);
    await l1.init();

    // 1) 30 条信号记忆入库(经 appendNew:与真实写路径一致,familiy/name 归一都走)
    await l1.appendNew(Array.from({ length: 30 }, (_, i) => sigRecord(i)));
    const query = '部署约定 nginx 蓝绿';
    const before = await l1.search(query, 10);
    const beforeTop5 = before.map((h) => h.id).slice(0, 5);
    expect(beforeTop5.length).toBe(5);

    // 2) 600 条外部噪声经 puller 回灌(真四象限路径,不是直接 appendNew)
    const caps = EXT_DRIVER_SPECS.hindsight.capabilities;
    const driver = {
      id: 'hs',
      typeId: 'hindsight',
      capabilities: caps,
      scoreSemantics: 'normalized-relevance',
      status: async () => ({ healthy: true }),
      search: async () => ({ results: [], hasMore: false }),
      remember: vi.fn(async () => ({ completion: 'committed' as const })),
      forget: vi.fn(async () => ({ completion: 'committed' as const })),
      list: vi.fn(async () => ({ hits: Array.from({ length: NOISE }, (_, i) => noiseHit(i)), hasMore: false })),
      sincePull: vi.fn(async () => ({ entries: Array.from({ length: NOISE }, (_, i) => noiseHit(i)), next: { since: 'c1' } })),
      graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: '' })),
    } as unknown as ExternalMemoryDriver;
    const registry = new ExtDriverRegistry();
    registry.register(driver);
    const cfg: ExtPullConfig = {
      masterEnabled: true,
      enabled: true,
      syncMode: 'two-way',
      maxItems: 2000,
      timeBudgetMs: 120_000,
      families: new Set(['work']),
    };
    const puller = makeExtPuller({
      registry,
      spacesOf: (id) => [{ spaceId: `${id}:main`, driverId: id, externalId: 'main', name: '', description: '' }],
      ext: db.extSync,
      l1,
      cfg: () => cfg,
    });
    // puller 的 appendNew 会触发 extSync 钩子——本测只关心检索面与幂等,不接推送泵
    const s = await puller.runBatch();
    expect(s.imported).toBe(NOISE);
    // 幂等:同批重拉不新增
    const s2 = await puller.runBatch();
    expect(s2.imported).toBe(0);
    expect(db.extSync.countShadows().clean).toBe(NOISE);

    // 3) 漂移断言:top5 至少 3 条留在 top5,5 条全在前 10
    const after = await l1.search(query, 10);
    const afterIds = after.map((h) => h.id);
    const stillTop5 = beforeTop5.filter((id) => afterIds.slice(0, 5).includes(id)).length;
    const stillTop10 = beforeTop5.filter((id) => afterIds.includes(id)).length;
    expect(stillTop5).toBeGreaterThanOrEqual(3);
    expect(stillTop10).toBe(5);

    // 4) 清理不扇出:软退场汇流口恰好 1 次 forget;物理清理路径不是点火面
    const enqueued: Array<{ intent: string; n: number }> = [];
    l1.setExtSyncHook({ enqueue: (recs, intent) => enqueued.push({ intent, n: recs.length }) });
    const shadow = db.extSync.listShadowsByState('clean', 1)[0]!;
    const retired = l1.retire([shadow.recordId], { at: new Date().toISOString(), reason: 'manual' });
    expect(retired).toBeGreaterThan(0);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.intent).toBe('forget');
    // 结构性证据:点火面恰 5 处(appendNew/upsert/retire/restore/reviseInPlace);purge/清理不在其列
    const src = await import('node:fs/promises').then((m) => m.readFile(new URL('../src/store/l1.ts', import.meta.url), 'utf8'));
    expect(src.match(/this\.fireExtSync\(/gu)?.length ?? 0).toBe(5);
    db.close();
  }, 120_000);
});
