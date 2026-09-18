/**
 * 清理前导出**硬门禁**单测(task_13/17)。
 *
 * 需求原话:"后清理过程应该先有导出物再清理"。本文件把这句话钉成可执行判据:
 * ① 门禁通过 → 快照落盘 + 校验 → 才物理删除;
 * ② 导出物**真的能恢复**(不是"写了个文件"就算数);
 * ③ **快照写入失败 → 中止,一条都不删**;
 * ④ `verifySnapshot` 能侦测快照与库的漂移(门禁的第二半);
 * ⑤ 结构性守卫:整个 src 里 `deleteL1Batch` **只有门禁一个调用方** ——
 *    "没有绕过导出的物理删除路径"由此成为结构事实,而不是一句约定。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import {
  createL1Snapshot,
  exportThenPurge,
  readSnapshotManifest,
  readSnapshotRecords,
  restoreL1Snapshot,
  verifySnapshot,
} from '../src/store/l1-snapshot.js';
import type { MemoryRecord } from '../src/types.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} } as never;

function rec(id: string, content: string): MemoryRecord {
  const t = Date.now();
  return { id, content, type: 'work_fact', priority: 60, scene_name: 's', timestamps: [t], createdAt: t, updatedAt: t };
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-purge-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'm.db'), 0);
  db.init();
  const store = new L1Store(dataDir, db, undefined, 'keyword', noopLogger, 0);
  await store.init();
  await store.appendNew([rec('r1', '待清理的记忆甲'), rec('r2', '活动记忆乙')]);
  store.retire(['r1'], { at: '2026-09-18T12:00:00.000Z', reason: 'manual' });
  return { dataDir, db, store };
}

const rowCount = (db: MemoryDb, id: string): number =>
  (
    (db as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db
      .prepare('SELECT COUNT(*) AS n FROM l1_records WHERE record_id = ?')
      .get(id) as { n: number }
  ).n;

describe('清理前导出硬门禁', () => {
  it('门禁通过:落快照 + 物理删除已退场记录,活动记录不受影响', async () => {
    const { db, store } = await setup();
    const r = await store.purgeRetired(['r1'], 'test-purge');
    expect(r.aborted).toBe(false);
    expect(r.purged).toBe(1);
    expect(r.dir).toContain('snapshots');
    // 清单可读回,且拍的是**删除前**的全量(2 条)
    const manifest = await readSnapshotManifest(r.dir);
    expect(manifest?.sections.records.count).toBe(2);
    expect(await readFile(join(r.dir, 'manifest.json'), 'utf8')).toContain('test-purge');
    expect(rowCount(db, 'r1')).toBe(0); // 真的删了
    expect(rowCount(db, 'r2')).toBe(1); // 活动记录不动
    db.close();
  });

  it('导出物**真的可恢复**:清理后能从快照把记录取回', async () => {
    const { db, store } = await setup();
    const r = await store.purgeRetired(['r1'], 'purge-recoverable');
    expect(rowCount(db, 'r1')).toBe(0);
    // 快照里确实含 r1(且保留其退场状态——恢复的是"当时的状态",不是凭空复活)
    const records = await readSnapshotRecords(r.dir);
    const back = records.find((x) => x.id === 'r1');
    expect(back?.content).toBe('待清理的记忆甲');
    // 走既有恢复路径回写
    const res = await restoreL1Snapshot(db as never, r.dir, noopLogger);
    expect(res.restored).toBeGreaterThan(0);
    expect(rowCount(db, 'r1')).toBe(1);
    db.close();
  });

  it('**快照写入失败 → 中止且零删除**', async () => {
    const { dataDir, db } = await setup();
    // 造"路径中间是文件"的 dataDir,令目录创建/写入必然失败
    const blocker = join(dataDir, 'blocker');
    await writeFile(blocker, 'x');
    const r = await exportThenPurge(db as never, join(blocker, 'nested'), ['r1'], 'failing', noopLogger);
    expect(r.aborted).toBe(true);
    expect(r.purged).toBe(0);
    expect(r.diffs.join(' ')).toContain('快照写入失败');
    expect(rowCount(db, 'r1')).toBe(1); // 纹丝不动
    db.close();
  });

  it('门禁第二半:verifySnapshot 能侦测快照与库的漂移', async () => {
    const { dataDir, db, store } = await setup();
    const dir = join(dataDir, 'snapshots', 'manual-drift');
    await createL1Snapshot(db as never, dir, 'drift');
    // 拍完之后库里又多了一条 → 快照不再代表当前状态
    await store.appendNew([rec('r3', '快照之后才来的')]);
    const v = await verifySnapshot(db as never, dir);
    expect(v.ok).toBe(false);
    expect(v.diffs.join(' ')).toContain('l1_records 内容不一致');
    db.close();
  });

  it('显式 ids 里的**活动**记录不会被物理抹掉(复核挡住硬删后门)', async () => {
    const { db, store } = await setup();
    // r2 是活动记录:即便被点名,也只能因"未退场"而被过滤掉
    const r = await store.purgeRetired(['r2'], 'attempt-active');
    expect(r.purged).toBe(0);
    expect(rowCount(db, 'r2')).toBe(1);
    db.close();
  });
});

describe('结构性守卫:没有绕过导出的物理删除路径', () => {
  it('src 中 `deleteL1Batch` 只有 l1-snapshot 的门禁调用它', async () => {
    const root = decodeURIComponent(new URL('../src', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith('.ts')) files.push(p);
      }
    };
    await walk(root);
    const callers: string[] = [];
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      if (/\.deleteL1Batch\(/.test(src)) callers.push(f.slice(root.length).replace(/\\/g, '/'));
    }
    expect(callers.sort()).toEqual(['/store/l1-snapshot.ts']);
  });
});
