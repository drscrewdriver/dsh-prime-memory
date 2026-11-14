/**
 * Phase 3 拉取泵测试(T3.1 判据):四象限裁决的每一格 + 循环防护三件套 + 墓碑硬闸。
 *
 * 为什么这些格子必须分测:四象限的判定全是"两个指纹的相对关系"——把任意两格
 * 合并实现(比如"变了就回灌")都不会让 happy path 挂,只会在真实多端场景里
 * 静默把本地未提交的编辑覆盖掉。冲突不复活同理:不测就等着用户报告"删不掉的记忆"。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import { ExtDriverRegistry } from '../src/ext-memory/registry.js';
import { makeExtPuller, type ExtPullConfig } from '../src/ext-memory/puller.js';
import { makeExtPusher } from '../src/ext-memory/pusher.js';
import { EXT_DRIVER_SPECS } from '../src/ext-memory/types.js';
import type { ExternalHit, ExternalMemoryDriver } from '../src/ext-memory/types.js';
import { recordDigest, normContentKey, sha256Hex, ExtCapabilityMissingError } from '../src/ext-memory/util.js';
import { dayKey } from '../src/util/io.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    for (let i = 0; i < 5; i++) {
      try {
        await rm(d, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
});

const cfgBase: ExtPullConfig = {
  masterEnabled: true,
  enabled: true,
  syncMode: 'two-way',
  maxItems: 100,
  timeBudgetMs: 30_000,
  families: new Set(['work']),
};

/**
 * 替身驱动。
 *
 * `incremental` 默认 false——与真实情势一致（没有任何一家接了游标）。
 * 旧测靠 `EXT_DRIVER_SPECS.hindsight.capabilities` 拿到 cursor 就自动拥有 sincePull，
 * 那正是“方法存在”恒真判据的源头；现在要走游标路必须显式声明 incremental。
 */
function fakeDriver(entries: ExternalHit[] = [], incremental = false): ExternalMemoryDriver {
  const caps = { ...EXT_DRIVER_SPECS.hindsight.capabilities, incremental };
  return {
    id: 'hs',
    typeId: 'hindsight',
    capabilities: caps,
    scoreSemantics: 'normalized-relevance',
    status: async () => ({ healthy: true }),
    search: async () => ({ results: [], hasMore: false }),
    remember: vi.fn(async () => ({ completion: 'accepted' as const, pendingOp: 'op' })),
    forget: vi.fn(async () => ({ completion: 'committed' as const })),
    list: vi.fn(async () => ({ hits: entries, hasMore: false })),
    sincePull: vi.fn(async () => ({ entries, next: { since: 'c1' } })),
    graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: '' })),
  } as unknown as ExternalMemoryDriver;
}

const hit = (externalId: string, content: string): ExternalHit => ({
  driverId: 'hs',
  spaceId: 'hs:main',
  externalId,
  content,
});

/** 共享夹具:真 MemoryDb/L1Store + 程序化 hitter 驱动 + puller/pusher 双泵。 */
async function makeH(opts: { entries?: ExternalHit[]; cfg?: Partial<ExtPullConfig>; tombstoned?: string[]; incremental?: boolean; listThrows?: Error | null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-puller-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'm.db'), 0);
  db.init();
  const l1 = new L1Store(dataDir, db, undefined, 'keyword', undefined, 0);
  await l1.init();
  const registry = new ExtDriverRegistry();
  const driver = fakeDriver(opts.entries ?? [], opts.incremental === true);
  if (opts.listThrows !== undefined) {
    (driver as unknown as { list: ReturnType<typeof vi.fn> }).list = vi.fn(async () => {
      if (opts.listThrows !== null) throw opts.listThrows;
      return { hits: opts.entries ?? [], hasMore: false };
    });
  }
  registry.register(driver);
  let cfg = { ...cfgBase, ...opts.cfg };
  const tombstones = new Set((opts.tombstoned ?? []).map((c) => sha256Hex(normContentKey(c))));
  const spacesOf = (id: string) => [{ spaceId: `${id}:main`, driverId: id, externalId: 'main', name: '', description: '' }];
  const puller = makeExtPuller({
    registry,
    spacesOf,
    ext: db.extSync,
    l1,
    isTombstoned: (norm) => tombstones.has(sha256Hex(norm)),
    cfg: () => cfg,
  });
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
  return { dataDir, db, l1, driver, registry, puller, pusher, setCfg: (p: Partial<ExtPullConfig>) => { cfg = { ...cfg, ...p }; }, close: () => db.close() };
}

describe('入站闸(T3.1)', () => {
  it('push-only / pull.disabled / 总闸关 → 零拉取零写入', async () => {
    const h = await makeH({ entries: [hit('e1', '外部事实一')], cfg: { syncMode: 'push-only' } });
    try {
      const s1 = await h.puller.runBatch();
      expect(s1.pulled).toBe(0);
      h.setCfg({ syncMode: 'two-way', enabled: false });
      const s2 = await h.puller.runBatch();
      expect(s2.pulled).toBe(0);
      h.setCfg({ enabled: true, masterEnabled: false });
      const s3 = await h.puller.runBatch();
      expect(s3.pulled).toBe(0);
      expect(h.db.extSync.countShadows().clean).toBe(0);
    } finally {
      h.close();
    }
  });
});

describe('新外部实体回灌(象限:无影子)', () => {
  it('appendNew 建本地记录 + 影子链 externalId;重跑不再新增(ext_key 幂等);推送泵不回流(0 remember)', async () => {
    const h = await makeH({ entries: [hit('e1', '远端独有的事实')] });
    try {
      const s1 = await h.puller.runBatch();
      expect(s1.imported).toBe(1);
      expect(h.db.extSync.countShadows().clean).toBe(1);
      const shadow = h.db.extSync.getShadowByExternal('hs', 'hs:main', 'e1')!;
      expect(shadow.externalId).toBe('e1');
      const rec = h.l1.getByIds([shadow.recordId])[0]!;
      expect(rec.content).toBe('远端独有的事实');
      expect(rec.family).toBe('work');
      expect(rec.extKey).toBeTruthy();
      // 环防护:appendNew 触发的 add 任务在派发时被 digest skip(影子已带同指纹)
      const ps = await h.pusher.runBatch();
      expect(ps.skipped + ps.done).toBeGreaterThanOrEqual(0);
      expect((h.driver.remember as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      // 重跑同一远端条目 → ext_key 命中,不新建
      h.db.extSync.deleteShadow(shadow.shadowId); // 模拟影子丢失(重建后)
      const s2 = await h.puller.runBatch();
      expect(s2.imported).toBe(0);
      expect(s2.skipped).toBe(1);
      expect(h.l1.getByIds([rec.id])[0]!.content).toBe('远端独有的事实');
    } finally {
      h.close();
    }
  });
});

describe('四象限裁决(有影子)', () => {
  it('只外变 → reviseInPlace 同 id 改写 + 事实源版本行 + 影子指纹刷新', async () => {
    const h = await makeH({ entries: [hit('e1', '旧文')] });
    try {
      await h.puller.runBatch(); // 导入
      const shadow = h.db.extSync.getShadowByExternal('hs', 'hs:main', 'e1')!;
      const recId = shadow.recordId;
      // 远端改为新文：换 list 的返回。旧测改的是 sincePull（因为 cursor 家会自动拿到该方法），
      // 现在拉取走的是翻页 list 路，再改 sincePull 就变成“改了个不会被调用的桩”。
      (h.driver.list as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ hits: [hit('e1', '新文(远端改)')], hasMore: false }));
      const s = await h.puller.runBatch();
      expect(s.refreshed).toBe(1);
      const rec = h.l1.getByIds([recId])[0]!;
      expect(rec.id).toBe(recId); // 同 id,不是新行
      expect(rec.content).toBe('新文(远端改)');
      expect(h.db.extSync.getShadowByExternal('hs', 'hs:main', 'e1')!.dbDigest).toBe(recordDigest(rec));
      // 事实源留版本行(否则重建回滚)。文件名必须用**同一个 dayKey**(本地日区):
      // 拿 toISOString 猜日期在 UTC+8 夜间会跨日错文件,昨天恰好同日才没现形。
      const jsonl = await readFile(join(h.dataDir, 'records', `${dayKey(rec.createdAt)}.jsonl`), 'utf8').catch(() => '');
      expect(jsonl).toContain('新文(远端改)');
    } finally {
      h.close();
    }
  });

  it('两边都变 → 挂 both_dirty 冲突,两侧都不动', async () => {
    const h = await makeH({ entries: [hit('e1', '基线')] });
    try {
      await h.puller.runBatch();
      const shadow = h.db.extSync.getShadowByExternal('hs', 'hs:main', 'e1')!;
      const rec = h.l1.getByIds([shadow.recordId])[0]!;
      // 本地改(走 reviseInPlace 模拟人工编辑后的库内变更,不含影子刷新)
      const localEdited = { ...rec, content: '本地改的', updatedAt: Date.now() };
      const vec = undefined;
      // 直接用 store 层改写(等价于人工 update):upsert 不动影子 → 影子 dbDigest 落后
      await h.l1.upsert(localEdited, { vector: vec });
      (h.driver.list as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ hits: [hit('e1', '远端也改了')], hasMore: false }));
      const s = await h.puller.runBatch();
      expect(s.conflicts).toBe(1);
      expect(h.l1.getByIds([rec.id])[0]!.content).toBe('本地改的'); // 本地不被覆盖
      expect(h.db.extSync.getShadowByExternal('hs', 'hs:main', 'e1')!.syncState).toBe('both_dirty');
      const cf = h.db.extSync.listConflicts({ kind: 'both_dirty' });
      expect(cf).toHaveLength(1);
      expect(cf[0]!.recordId).toBe(rec.id);
    } finally {
      h.close();
    }
  });
});

describe('墓碑硬闸(遗忘赛道不复活)', () => {
  it('远端出现与本地墓碑同指纹的内容 → unforgettable 挂账,不新建', async () => {
    const h = await makeH({ entries: [hit('e9', '这条被忘过')], tombstoned: ['这条被忘过'] });
    try {
      const s = await h.puller.runBatch();
      expect(s.imported).toBe(0);
      expect(s.conflicts).toBe(1);
      expect(h.db.extSync.countShadows().clean).toBe(0);
      const cf = h.db.extSync.listConflicts({ kind: 'unforgettable' });
      expect(cf[0]!.externalId).toBe('e9');
      // 裁决闭环:resolve 后状态可查
      expect(h.db.extSync.resolveConflict(cf[0]!.conflictId, 'keep-forgotten')).toBe(true);
      expect(h.db.extSync.listConflicts({ kind: 'unforgettable' })).toHaveLength(0);
    } finally {
      h.close();
    }
  });
});

describe('cursor 家拉取', () => {
  it('sincePull 断点往返:首轮用空游标,次轮用上轮 next', async () => {
    // 必须显式声明 incremental：旧测靠 cursor 家自动获得 sincePull，那正是恒真判据的源头。
    const h = await makeH({ entries: [], incremental: true });
    try {
      await h.puller.runBatch();
      expect(h.db.extSync.getCursor('hs', 'hs:main')).toEqual({ since: 'c1' });
      await h.puller.runBatch();
      const sincePull = h.driver.sincePull as ReturnType<typeof vi.fn>;
      expect(sincePull.mock.calls[1]![1]).toEqual({ since: 'c1' });
    } finally {
      h.close();
    }
  });
});

describe('入站分派分流（审计 P6：不得把三种情况当成同一种失败）', () => {
  it('游标未实装（能力哨兵错）→ 回落翻页 list，不计 failed', async () => {
    const h = await makeH({ entries: [hit('e1', '外部事实一')], incremental: true });
    try {
      (h.driver.sincePull as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        throw new ExtCapabilityMissingError('sincePull', '增量拉取(sincePull)');
      });
      const s = await h.puller.runBatch();
      expect(s.failed).toBe(0);
      expect(s.pulled).toBe(1);
      expect(s.imported).toBe(1);
    } finally {
      h.close();
    }
  });

  it('游标真故障（远端 500）→ 上抛计 failed，**不得静默降级成从头全量翻页**', async () => {
    const h = await makeH({ entries: [hit('e1', '外部事实一')], incremental: true });
    try {
      (h.driver.sincePull as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        throw new Error('remote 500');
      });
      const s = await h.puller.runBatch();
      expect(s.failed).toBe(1);
      expect(s.pulled).toBe(0); // 回落了就是谎报：远端抖一下会被当成一次全量重拉
    } finally {
      h.close();
    }
  });

  it('无 list 且无游标（byterover 形态）→ 记 skippedUnsupported，不记 failed', async () => {
    const h = await makeH({ entries: [hit('e1', 'x')] });
    try {
      (h.driver as unknown as { list?: unknown }).list = undefined;
      const s = await h.puller.runBatch();
      expect(s.skippedUnsupported).toBe(1);
      expect(s.failed).toBe(0);
      expect(s.pulled).toBe(0);
    } finally {
      h.close();
    }
  });

  it('条目多于单页 → 翻页拉全，且 truncation 如实报 capped', async () => {
    const many = Array.from({ length: 7 }, (_, i) => hit(`e${i}`, `事实${i}`));
    const h = await makeH({ entries: many, cfg: { maxItems: 4 } });
    try {
      // 替身按 offset/limit 分页并如实报 hasMore（不分页的替身测不出翻页逻辑）
      (h.driver.list as ReturnType<typeof vi.fn>).mockImplementation(async (_s: unknown, req: { limit: number; offset?: number }) => {
        const off = req.offset ?? 0;
        const hits = many.slice(off, off + req.limit);
        return { hits, hasMore: off + hits.length < many.length };
      });
      const s = await h.puller.runBatch();
      expect(s.pulled).toBe(4); // 达 maxItems 即停，不越护栏
      expect(s.truncation).toBe('capped');
    } finally {
      h.close();
    }
  });
});
