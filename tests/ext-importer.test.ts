/**
 * 导入任务编排（importer.ts）—— 真机抓出的断点漏洞的钉子。
 *
 * ## 为什么这个文件必须存在
 * 第一版对 `spaceId === ''` 直接跳过所有断点读写，而面板**永远**不传 spaceId
 * （它导入“这个驱动的全部空间”）。结果：unit 全绿、真机也能导完，但 `ext_import` 空表——
 * 面板上写着“可中断、断点保留”，实际中断就白导。
 * 这类 bug 的共同点是**默认路径没被覆盖**：所有断言都走了带 spaceId 的分支。
 * 所以这里专门从“不带 spaceId”这条真实路径出发。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { makeExtImporter, type ExtImporterDeps } from '../src/ext-memory/importer.js';
import type { ExtImportOptions, ExtImportSummary } from '../src/ext-memory/puller.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    try {
      await rm(d, { recursive: true, force: true });
    } catch {
      /* Windows 上偶有句柄未释放，下次再删 */
    }
  }
});

interface Fix {
  deps: ExtImporterDeps;
  db: MemoryDb;
  /** 每次 importSpace 收到的入参（用来断言断点续跑真的传了 startOffset）。 */
  calls: ExtImportOptions[];
  close(): void;
}

/** 用真 ExtSyncStore（断点落真表）+ 可编程的假 puller（只替掉“远端”这一层）。 */
async function fix(
  behaviour: (opts: ExtImportOptions) => Partial<ExtImportSummary>,
): Promise<Fix> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-importer-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'm.db'), 0);
  db.init();
  const calls: ExtImportOptions[] = [];
  const deps: ExtImporterDeps = {
    puller: {
      importSpace: async (opts: ExtImportOptions) => {
        calls.push(opts);
        const summary: ExtImportSummary = {
          pulled: 0, imported: 0, skipped: 0, conflicts: 0, failed: 0, offset: 0, truncation: 'complete',
          ...behaviour(opts),
        };
        // 模拟“跑了一页就交给回调”，断点落盘由 importer 负责（这正是要验的）。
        opts.onPage?.({ spaceId: 'hs:main', offset: summary.offset, imported: summary.imported, skipped: summary.skipped, hasMore: summary.truncation !== 'complete' });
        return summary;
      },
    },
    ext: db.extSync,
    l1Total: () => 0,
    cfg: () => ({ maxItems: 1000, timeBudgetMs: 5000 }),
  };
  return { deps, db, calls, close: () => db.close() };
}

/** 等任务自己收尾（importer 是“受理即返回”，进度只有 status() 一套语义）。 */
async function settle(imp: { status(): { running: boolean } | null }): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = imp.status();
    if (s === null || !s.running) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('导入未在预期时间内收尾');
}

describe('断点：面板不传 spaceId 时也必须落盘（真机抓到的默认路径漏洞）', () => {
  it('capped 收尾 → 断点记在哨兵 * 名下，state=capped', async () => {
    const f = await fix(() => ({ imported: 500, offset: 500, truncation: 'capped' }));
    try {
      const imp = makeExtImporter(f.deps);
      imp.start({ driverId: 'hs' });
      await settle(imp);
      const bp = f.db.extSync.getImport('hs', '*');
      expect(bp, '不传 spaceId 也必须留断点，否则“断点保留”是假话').not.toBeNull();
      expect(bp?.offset).toBe(500);
      expect(bp?.state).toBe('capped');
    } finally {
      f.close();
    }
  });

  it('complete 收尾 → 断点被清（不留下“还要从某处续跑”的残影）', async () => {
    const f = await fix(() => ({ imported: 3, offset: 3, truncation: 'complete' }));
    try {
      const imp = makeExtImporter(f.deps);
      imp.start({ driverId: 'hs' });
      await settle(imp);
      expect(f.db.extSync.getImport('hs', '*')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('第二轮从断点续跑：startOffset 传进 puller（不是从头再来）', async () => {
    const f = await fix((o) => ({
      imported: 10, offset: (o.startOffset ?? 0) + 10, truncation: 'capped',
    }));
    try {
      const imp = makeExtImporter(f.deps);
      imp.start({ driverId: 'hs' });
      await settle(imp);
      imp.start({ driverId: 'hs' });
      await settle(imp);
      expect(f.calls[0]?.startOffset).toBeUndefined();
      expect(f.calls[1]?.startOffset, '续跑必须带上次的 offset').toBe(10);
      expect(f.db.extSync.getImport('hs', '*')?.offset).toBe(20);
    } finally {
      f.close();
    }
  });

  it('cancel 立刻把 state 标成 cancelling，且断点保留', async () => {
    const f = await fix(() => ({ imported: 7, offset: 7, truncation: 'cancelled' }));
    try {
      const imp = makeExtImporter(f.deps);
      const accepted = imp.start({ driverId: 'hs' });
      expect(accepted.accepted).toBe(true);
      imp.cancel();
      await settle(imp);
      const bp = f.db.extSync.getImport('hs', '*');
      expect(bp).not.toBeNull();
      expect(['cancelling', 'cancelled']).toContain(bp?.state);
    } finally {
      f.close();
    }
  });

  it('restart=true：先清断点再从 0 开始（否则只能改库才能清）', async () => {
    const f = await fix((o) => ({
      imported: 10, offset: (o.startOffset ?? 0) + 10, truncation: 'capped',
    }));
    try {
      const imp = makeExtImporter(f.deps);
      imp.start({ driverId: 'hs' });
      await settle(imp);
      expect(f.db.extSync.getImport('hs', '*')?.offset).toBe(10);
      imp.start({ driverId: 'hs', restart: true });
      await settle(imp);
      expect(f.calls[1]?.startOffset, 'restart 不得带旧断点').toBeUndefined();
      // 新一轮从 0 起，收尾后断点应回到自己这一轮的进度（而不是叠加上一轮）
      expect(f.db.extSync.getImport('hs', '*')?.offset).toBe(10);
    } finally {
      f.close();
    }
  });

  it('resetBreakpoint 不传 spaceId 也清得掉哨兵断点（“重新开始”不能点了没反应）', async () => {
    const f = await fix(() => ({ imported: 5, offset: 5, truncation: 'capped' }));
    try {
      const imp = makeExtImporter(f.deps);
      imp.start({ driverId: 'hs' });
      await settle(imp);
      expect(f.db.extSync.getImport('hs', '*')).not.toBeNull();
      const r = imp.resetBreakpoint({ driverId: 'hs' });
      expect(r.cleared).toBe(true);
      expect(f.db.extSync.getImport('hs', '*')).toBeNull();
    } finally {
      f.close();
    }
  });
});

describe('护栏：并发与错误', () => {
  it('同一时刻只允许一个导入任务（第二个被拒而不是排队）', async () => {
    const slow = await fix(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { imported: 1, offset: 1, truncation: 'complete' };
    });
    try {
      const imp = makeExtImporter(slow.deps);
      imp.start({ driverId: 'hs' });
      expect(() => imp.start({ driverId: 'hs' })).toThrow(/已有导入任务/);
      await settle(imp);
    } finally {
      slow.close();
    }
  });

  it('puller 抛错 → running 变 false、error 可读、断点状态记 error（不静默）', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-importer-e-'));
    dirs.push(dataDir);
    const db = new MemoryDb(join(dataDir, 'm.db'), 0);
    db.init();
    const imp = makeExtImporter({
      puller: { importSpace: async () => { throw new Error('远端 500'); } },
      ext: db.extSync,
      l1Total: () => 0,
      cfg: () => ({ maxItems: 10, timeBudgetMs: 1000 }),
      logger: { info: () => {}, warn: vi.fn(), error: () => {} },
    });
    try {
      imp.start({ driverId: 'hs' });
      await settle(imp);
      const s = imp.status();
      expect(s?.running).toBe(false);
      expect(s?.error).toContain('远端 500');
      expect(db.extSync.getImport('hs', '*')?.state).toBe('error');
    } finally {
      db.close();
    }
  });
});
