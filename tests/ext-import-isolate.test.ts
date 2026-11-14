/**
 * 污染隔离与导入护栏（计划 ext-to-l1-import task_6.5）。
 *
 * ## 为什么这些用例必须带"反空集断言"
 * 隔离的实现是一条 SQL 谓词。谓词写错成 `ext_key IS NULL`（该列 `NOT NULL DEFAULT ''`）
 * 会**恒假**，于是"排除外源"变成"什么都不返回"：正向断言（结果里没有外源条目）照样通过，
 * 而真实后果是反刍拿到空集、L2 静默不跑且不报错。所以每个隔离用例都必须同时断
 * "没有外源" 与 "本地条目仍在且等于预期数"——只断前者等于没断。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import { ExtDriverRegistry } from '../src/ext-memory/registry.js';
import { makeExtPuller, type ExtPullConfig } from '../src/ext-memory/puller.js';
import { makeExtPusher } from '../src/ext-memory/pusher.js';
import { makeExtImporter } from '../src/ext-memory/importer.js';
import { EXT_DRIVER_SPECS } from '../src/ext-memory/types.js';
import type { ExternalHit, ExternalMemoryDriver, ExtListPage, ExtSpace } from '../src/ext-memory/types.js';
import { normContentKey, sha256Hex } from '../src/ext-memory/util.js';
import type { MemoryRecord } from '../src/types.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    for (let i = 0; i < 5; i++) {
      try {
        await rm(d, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  }
});

const LOCAL = 200;
const REMOTE = 600;

function rec(id: string, content: string): MemoryRecord {
  const t = Date.now();
  return { id, content, type: 'work_fact', priority: 50, scene_name: 's', timestamps: [t], createdAt: t, updatedAt: t, family: 'work' } as MemoryRecord;
}

/** 分页假驱动：每页 100 条，如实报 hasMore（不分页的替身测不出翻页与隔离）。 */
function pagingDriver(total: number): ExternalMemoryDriver {
  const caps = { ...EXT_DRIVER_SPECS.hindsight.capabilities, incremental: false, paged: true };
  return {
    id: 'hs',
    typeId: 'hindsight',
    capabilities: caps,
    scoreSemantics: 'normalized-relevance',
    status: async () => ({ healthy: true }),
    search: async () => ({ results: [], hasMore: false }),
    remember: vi.fn(async () => ({ completion: 'committed' as const, externalId: 'x' })),
    forget: vi.fn(async () => ({ completion: 'committed' as const })),
    list: vi.fn(async (_space: ExtSpace, req: { limit: number; offset?: number }): Promise<ExtListPage> => {
      const off = req.offset ?? 0;
      const hits: ExternalHit[] = [];
      for (let i = off; i < Math.min(off + req.limit, total); i++) {
        hits.push({ driverId: 'hs', spaceId: 'hs:main', externalId: `e${i}`, content: `远端事实 ${i}` });
      }
      return { hits, hasMore: off + hits.length < total };
    }),
    // hindsight 声明 graph:true，assertRuntime 会要求方法在场（本测不用它，但要过装配校验）。
    graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: '' })),
  } as unknown as ExternalMemoryDriver;
}

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-extiso-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'm.db'), 0);
  db.init();
  const l1 = new L1Store(dataDir, db, undefined, 'keyword', undefined, 0);
  await l1.init();
  const registry = new ExtDriverRegistry();
  const driver = pagingDriver(REMOTE);
  registry.register(driver);
  const spacesOf = (id: string) => [{ spaceId: `${id}:main`, driverId: id, externalId: 'main', name: '', description: '' }];
  const cfg: ExtPullConfig = {
    masterEnabled: true, enabled: true, syncMode: 'two-way', maxItems: 5000, timeBudgetMs: 60_000, families: new Set<string>(),
  };
  const puller = makeExtPuller({ registry, spacesOf, ext: db.extSync, l1, cfg: () => cfg });
  const pusher = makeExtPusher({
    registry,
    spacesOf,
    ext: db.extSync,
    l1,
    cfg: () => ({
      masterEnabled: true, enabled: true, syncMode: 'two-way', families: new Set(['work']),
      maxItems: 200, timeBudgetMs: 30_000, settleTimeoutMs: 60_000, maxAttempts: 3,
      backoffMs: [1, 3, 10], allowHardDelete: false, settleScanLimit: 100,
    }),
    wake: () => {},
  });
  l1.setExtSyncHook(pusher.hook);
  const importer = makeExtImporter({
    puller,
    ext: db.extSync,
    l1Total: () => l1.list({ limit: 1, offset: 0 }).total,
    cfg: () => ({ maxItems: 5000, timeBudgetMs: 60_000 }),
  });
  return { dataDir, db, l1, driver, puller, pusher, importer, close: () => db.close() };
}

describe('隔离谓词（反空集硬断言）', () => {
  it('排除外源后本地条目仍在且恰等于预期数——谓词恒假时这一目必红', async () => {
    const h = await harness();
    try {
      await h.l1.appendNew(Array.from({ length: LOCAL }, (_, i) => rec(`local${i}`, `本地事实 ${i}`)));
      const s = await h.puller.importSpace({ driverId: 'hs', maxItems: 5000, timeBudgetMs: 60_000 });
      expect(s.imported).toBe(REMOTE);

      const all = h.l1.list({ family: 'work', limit: 500, offset: 0 });
      const iso = h.l1.list({ family: 'work', limit: 500, offset: 0, excludeExternal: true });

      // 反空集：谓词写错成 IS NULL 时这一句就红了（items 会是 0 条而不是 200 条）
      expect(iso.items.length, '隔离取数不得为空集').toBe(LOCAL);
      expect(iso.items.every((r) => r.extKey === undefined || r.extKey === '')).toBe(true);
      expect(iso.items.some((r) => r.id.startsWith('local'))).toBe(true);
      // 风险真实性用总数差证明，不用窗口组成证明：窗口排序会把同毫秒的条目排到什么位置
      // 并不稳，拿“未隔离窗口里有外源”做断言会造出一个靠排序侥幸通过的测。
      expect(all.total - iso.total).toBe(REMOTE);
      // total 也必须是隔离后的口径，否则面板计数会说谎
      expect(iso.total).toBe(LOCAL);
      expect(all.total).toBe(LOCAL + REMOTE);
    } finally {
      h.close();
    }
  });

  it('窗口小于本地条目数时，隔离后取到的全是本地（外源一条都挤不进来）', async () => {
    const h = await harness();
    try {
      await h.l1.appendNew(Array.from({ length: LOCAL }, (_, i) => rec(`local${i}`, `本地事实 ${i}`)));
      await h.puller.importSpace({ driverId: 'hs', maxItems: 5000, timeBudgetMs: 60_000 });
      const win = h.l1.list({ family: 'work', limit: 50, offset: 0, excludeExternal: true });
      expect(win.items).toHaveLength(50);
      expect(win.items.every((r) => r.extKey === undefined || r.extKey === '')).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe('导入不污染蒸馏计数与推送队列', () => {
  it('导入不推进 newMemoriesSinceL2 / memoriesSinceL3，且派发时不得把条目推回远端', async () => {
    const h = await harness();
    try {
      const s = await h.puller.importSpace({ driverId: 'hs', maxItems: 5000, timeBudgetMs: 60_000 });
      expect(s.imported).toBe(REMOTE);
      expect(h.l1.list({ limit: 1, offset: 0 }).total).toBe(REMOTE);
      // 先记入队数再派发：写放大闸拦的是**派发**（影子已带 externalId 且 digest 相同 → skip），
      // 不是拦入队；把“pending=0”当断言会把一个合法设计误判成 bug。
      const pendingAfterImport = h.db.extSync.countOutbox().pending;
      expect(pendingAfterImport, '入库钩子会入队（靠派发闸兼平，不靠不队）').toBeGreaterThan(0);
      await h.pusher.runBatch();
      const remember = h.driver.remember as ReturnType<typeof vi.fn>;
      expect(remember, '导入条目被自己的 push 钩子真推回了远端（写放大/环路）').not.toHaveBeenCalled();
      const dead = h.db.extSync.countOutbox().dead;
      expect(dead, '已链条目不得因推送失败进死信').toBe(0);
    } finally {
      h.close();
    }
  });

  it('重复导入幂等：第二轮全部 skip，不新增任何条目（ext_key 台账）', async () => {
    const h = await harness();
    try {
      const a = await h.puller.importSpace({ driverId: 'hs', maxItems: 5000, timeBudgetMs: 60_000 });
      const totalAfter1 = h.l1.list({ limit: 1, offset: 0 }).total;
      const b = await h.puller.importSpace({ driverId: 'hs', maxItems: 5000, timeBudgetMs: 60_000 });
      expect(a.imported).toBe(REMOTE);
      expect(b.imported).toBe(0);
      expect(b.skipped).toBeGreaterThanOrEqual(REMOTE);
      expect(h.l1.list({ limit: 1, offset: 0 }).total).toBe(totalAfter1);
    } finally {
      h.close();
    }
  });

  it('墓碑内容不复活：命中退场台账的远端条目挂 unforgettable，不入库', async () => {
    // 走真实 importSpace 路径，注入 isTombstoned 判据：测的是闸而不是旁路。
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-extiso-t-'));
    dirs.push(dataDir);
    const db = new MemoryDb(join(dataDir, 'm.db'), 0);
    db.init();
    const l1 = new L1Store(dataDir, db, undefined, 'keyword', undefined, 0);
    await l1.init();
    const registry = new ExtDriverRegistry();
    registry.register(pagingDriver(REMOTE));
    const tombstoned = new Set([sha256Hex(normContentKey('远端事实 7')), sha256Hex(normContentKey('远端事实 42'))]);
    const puller = makeExtPuller({
      registry,
      spacesOf: (id: string) => [{ spaceId: `${id}:main`, driverId: id, externalId: 'main', name: '', description: '' }],
      ext: db.extSync,
      l1,
      isTombstoned: (norm) => tombstoned.has(sha256Hex(norm)),
      cfg: () => ({ masterEnabled: true, enabled: true, syncMode: 'two-way', maxItems: 5000, timeBudgetMs: 60_000, families: new Set<string>() }),
    });
    try {
      const s = await puller.importSpace({ driverId: 'hs', maxItems: 5000, timeBudgetMs: 60_000 });
      expect(s.imported).toBe(REMOTE - 2);
      expect(s.conflicts).toBe(2);
      // 挂账条数与计数一致：不一致就是 upsertConflict 的去重键过粗（会默默合并不同条目）。
      const cf = db.extSync.listConflicts({ kind: 'unforgettable' });
      expect(cf.map((c) => c.externalId).sort()).toEqual(['e42', 'e7']);
      // 硬闸不是“少返两条”而是“一条都不能入库”
      expect(l1.list({ limit: 1, offset: 0 }).total).toBe(REMOTE - 2);
    } finally {
      db.close();
    }
  });
});

describe('导入护栏与断点', () => {
  it('达 maxItems 即停且 truncation=capped（不得谎称 complete）', async () => {
    const h = await harness();
    try {
      const s = await h.puller.importSpace({ driverId: 'hs', maxItems: 150, timeBudgetMs: 60_000 });
      expect(s.imported).toBe(150);
      expect(s.truncation).toBe('capped');
      expect(s.offset).toBe(150);
    } finally {
      h.close();
    }
  });

  it('断点续跑：第二轮从 offset 起，累计条目数等于远端总数', async () => {
    const h = await harness();
    try {
      const first = await h.puller.importSpace({ driverId: 'hs', maxItems: 150, timeBudgetMs: 60_000 });
      const second = await h.puller.importSpace({
        driverId: 'hs', maxItems: 150, timeBudgetMs: 60_000, startOffset: first.offset,
      });
      expect(second.imported).toBe(150);
      expect(second.offset).toBe(300);
      expect(h.l1.list({ limit: 1, offset: 0 }).total).toBe(300);
    } finally {
      h.close();
    }
  });

  it('onPage 返回 true 即中止，断点已落表可续', async () => {
    const h = await harness();
    try {
      // 页大小由 LIST_PAGE_LIMIT(500) 决定，不是假驱动里的 100：第一页就给 500 条。
      let pages = 0;
      const s = await h.puller.importSpace({
        driverId: 'hs', maxItems: 5000, timeBudgetMs: 60_000,
        spaceId: 'hs:main',
        onPage: ({ offset }) => {
          pages++;
          h.db.extSync.upsertImport({ driverId: 'hs', spaceId: 'hs:main', offset, imported: offset, skipped: 0, state: 'running' });
          return pages >= 1; // 首页入库后即中止
        },
      });
      expect(s.truncation).toBe('cancelled');
      expect(s.imported).toBe(500);
      const bp = h.db.extSync.getImport('hs', 'hs:main');
      expect(bp?.offset).toBe(500);
      expect(bp?.state).toBe('running');
    } finally {
      h.close();
    }
  });

  it('无遍历面的家（byterover 形态）→ truncation=unsupported，不记失败也不谎称导入完', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-extiso-u-'));
    dirs.push(dataDir);
    const db = new MemoryDb(join(dataDir, 'm.db'), 0);
    db.init();
    const l1 = new L1Store(dataDir, db, undefined, 'keyword', undefined, 0);
    await l1.init();
    const registry = new ExtDriverRegistry();
    const caps = { ...EXT_DRIVER_SPECS.byterover.capabilities };
    const driver = {
      id: 'br', typeId: 'byterover', capabilities: caps, scoreSemantics: 'normalized-relevance',
      status: async () => ({ healthy: true }),
      search: async () => ({ results: [], hasMore: false }),
      remember: async () => ({ completion: 'failed' as const, error: 'unsupported' }),
    } as unknown as ExternalMemoryDriver;
    registry.register(driver);
    const puller = makeExtPuller({
      registry,
      spacesOf: (id: string) => [{ spaceId: `${id}:main`, driverId: id, externalId: 'main', name: '', description: '' }],
      ext: db.extSync,
      l1,
      cfg: () => ({ masterEnabled: true, enabled: true, syncMode: 'two-way', maxItems: 100, timeBudgetMs: 5000, families: new Set<string>() }),
    });
    try {
      const s = await puller.importSpace({ driverId: 'br', maxItems: 100, timeBudgetMs: 5000 });
      expect(s.truncation).toBe('unsupported');
      expect(s.imported).toBe(0);
      expect(s.failed).toBe(0);
    } finally {
      db.close();
    }
  });
});

/** 无遍历面的家需要单独的 registry 夹具，上面用例已就地构造。 */
