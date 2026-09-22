/**
 * hall 迁移(task_14)回归:dry-run/apply、幂等(两次一致)、retired 行不漏扫、
 * 单一所有者扫描函数(scanL1Metadata 全量,含 retired)。
 */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import { runHallMigration } from '../src/hall-migrate.js';
import { NoopEmbeddingService } from '../src/store/embedding.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-hall-mig-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function seedDb(retire = false): Promise<string> {
  const root = await tmp();
  const dbPath = join(root, `mem-${Math.random().toString(36).slice(2)}.db`);
  const db = new MemoryDb(dbPath, 0);
  db.init();
  const l1 = new L1Store(root, db, new NoopEmbeddingService());
  const now = Date.now();
  const base = { priority: 60, scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now };
  await l1.appendNew([
    { id: 'w1', content: '工作记忆', type: 'work_fact', ...base, metadata: { hall: 'work' } },
    { id: 'g1', content: '跨域记忆', type: 'episodic', ...base, metadata: { hall: 'general' } },
    { id: 'n1', content: '未打标记忆', type: 'episodic', ...base, metadata: {} },
  ]);
  if (retire) {
    // 退场一行:主表行连 metadata_json 保留(软删语义),迁移必须仍扫到
    db.retireL1Batch(['g1'], { at: new Date().toISOString(), reason: 'test', verdict: 'test', pairId: 'p1' });
  }
  db.close();
  return dbPath;
}

describe('hall migration (task_14)', () => {
  it('dry-run reports counts on full main table incl. retired rows; idempotent across runs', async () => {
    const dbPath = await seedDb(true);
    const first = runHallMigration({ dbPath, dryRun: true });
    expect(first.total).toBe(3);
    expect(first.retired).toBe(1); // retired 行不漏扫
    expect(first.byHall['work']).toBe(1);
    expect(first.byHall['general']).toBe(1); // general 保留为跨域值(只报告)
    expect(first.unlabeled).toBe(1);
    expect(first.backupPath).toBeNull(); // dry-run 不写文件
    expect(first.verdict).toBe('expected');
    // 连续两次结果一致(幂等)
    const second = runHallMigration({ dbPath, dryRun: true });
    expect(second).toEqual(first);
  });

  it('apply mode writes metadata_json backup covering every scanned row', async () => {
    const dbPath = await seedDb();
    const backupDir = join(await tmp(), 'backup');
    await mkdir(backupDir, { recursive: true });
    const report = runHallMigration({ dbPath, dryRun: false, backupDir });
    expect(report.backupPath).toBeTruthy();
    const lines = (await readFile(report.backupPath!, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    const ids = lines.map((l) => JSON.parse(l).recordId).sort();
    expect(ids).toEqual(['g1', 'n1', 'w1']);
    // 原记录未被改写(本迁移零改写)
    const after = runHallMigration({ dbPath, dryRun: true });
    expect(after.byHall).toEqual(report.byHall);
  });

  it('single-owner scan function reaches retired metadata (B 计划引用门禁的口径契约)', async () => {
    const dbPath = await seedDb(true);
    const db = new MemoryDb(dbPath, 0);
    db.init();
    const seen: Array<{ id: string; hasMeta: boolean }> = [];
    const scanned = db.scanL1Metadata((id, meta) => seen.push({ id, hasMeta: meta !== null }));
    db.close();
    expect(scanned).toBe(3);
    expect(seen.find((r) => r.id === 'g1')?.hasMeta).toBe(true); // retired 行 metadata 仍可解析
  });
});
