/**
 * 记忆后端(后台边界,R8)测试。
 *
 * 钉死三件事:
 * 1. 进程内实现与直接调 L1Store **行为一致**(接口化是纯重构,不能改变语义);
 * 2. worker 实现的 5 个方法往返正确(真起线程,不桩);
 * 3. **崩溃与降级可观测**:起不来退回进程内、线程崩了在途请求必须 reject 且有日志
 *    —— 静默挂起是本次「整批丢弃却无日志」的同类药物。
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import { NoopEmbeddingService } from '../src/store/embedding.js';
import { InProcMemoryBackend } from '../src/store/memory-backend.js';
import { WorkerMemoryBackend, createMemoryBackend } from '../src/store/memory-backend-worker.js';
import type { MemoryLogger } from '../src/types.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-mb-'));
  return dir;
}
const dbs: MemoryDb[] = [];
afterAll(async () => {
  for (const db of dbs) db.close();
  if (!dir) return;
  for (let i = 0; i < 3; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/**
 * 真 worker 需要**编译后的 JS**(worker_threads 不认 TS)。
 * 优先用 `dist/store/memory-worker.js`(构建产物);没有就用 esbuild 现编一份到临时目录
 * —— 无论哪条路,测的都是**真线程 + 真 SQLite**,不是桩。
 */
let workerPath = '';
beforeAll(async () => {
  const distWorker = join(repoRoot, 'dist', 'store', 'memory-worker.js');
  if (existsSync(distWorker)) {
    workerPath = distWorker;
    return;
  }
  // 产物在系统临时目录(不在本仓库内)→ 必须自带 type:module,否则 Node 先按 CJS
  // 解析再回退(MODULE_TYPELESS_PACKAGE_JSON 警告 + 重复解析开销)
  const outDir = await mkdtemp(join(tmpdir(), 'dsh-mw-'));
  await writeFile(join(outDir, 'package.json'), '{"type":"module"}');
  const out = join(outDir, 'memory-worker.js');
  await build({
    entryPoints: [join(repoRoot, 'src', 'store', 'memory-worker.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node:*'],
    logLevel: 'silent',
  });
  workerPath = out;
}, 60_000);

async function mkL1(): Promise<{ l1: L1Store; dbPath: string }> {
  const root = await tmp();
  const dbPath = join(root, `m-${Math.random().toString(36).slice(2)}.db`);
  const db = new MemoryDb(dbPath, 0);
  db.init();
  dbs.push(db);
  return { l1: new L1Store(root, db, new NoopEmbeddingService()), dbPath };
}

const now = Date.now();
const base = { priority: 60, scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now };

describe('InProcMemoryBackend(进程内)', () => {
  it('四个方法往返正确,且与 L1Store 直调一致', async () => {
    const { l1 } = await mkL1();
    await l1.appendNew([
      { id: 'x1', content: 'body-1', type: 'work_fact', ...base, metadata: {} },
      { id: 'x2', content: 'body-2', type: 'episodic', ...base, metadata: { hall: 'work' } },
    ]);
    const b = new InProcMemoryBackend(l1);
    expect(await b.size()).toBe(2);
    const page = await b.allLite(10, 0);
    expect(page.map((r) => r.id).sort()).toEqual(['x1', 'x2']);
    // 轻量投影不带 content(巡检不拉正文)
    expect(Object.keys(page[0])).toEqual(['id', 'type', 'metadata']);

    const full = await b.getByIds(['x1']);
    expect(full[0].content).toBe('body-1');

    const listed = await b.list({ limit: 10, offset: 0 });
    expect(listed.total).toBe(2);

    expect(await b.patchMetadata('x1', { hall: 'health', cogHall: 'facts' })).toBe(true);
    // 红线:只改 metadata,正文与另一条记录不受影响
    const after = await b.getByIds(['x1', 'x2']);
    expect(after.find((r) => r.id === 'x1')?.content).toBe('body-1');
    expect(after.find((r) => r.id === 'x1')?.metadata).toMatchObject({ hall: 'health', cogHall: 'facts' });
    expect(after.find((r) => r.id === 'x2')?.metadata).toMatchObject({ hall: 'work' });
  });
});

describe('WorkerMemoryBackend(线程隔离)', () => {
  it('真起 worker:五个方法往返正确,写入对主线程可见', async () => {
    const { l1, dbPath } = await mkL1();
    await l1.appendNew([
      { id: 'w1', content: 'hello', type: 'work_fact', ...base, metadata: {} },
    ]);
    const warns: string[] = [];
    const logger: MemoryLogger = { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} };
    const b = new WorkerMemoryBackend({ dbPath, dimensions: 0, logger, workerPath });
    try {
      expect(await b.size()).toBe(1);
      expect((await b.allLite(10, 0)).map((r) => r.id)).toEqual(['w1']);
      expect((await b.getByIds(['w1']))[0].content).toBe('hello');
      expect((await b.list({ limit: 10, offset: 0 })).total).toBe(1);
      expect(await b.patchMetadata('w1', { hall: 'work' })).toBe(true);
    } finally {
      await b.dispose();
    }
    // 主线程同一 db 文件:worker 的写入必须可见(WAL + busy_timeout)
    expect(l1.getByIds(['w1'])[0].metadata).toMatchObject({ hall: 'work' });
  });

  it('dbPath 非法 → createMemoryBackend 退回进程内并留下 warn(不静默)', async () => {
    const { l1 } = await mkL1();
    const warns: string[] = [];
    const logger: MemoryLogger = { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} };
    const fallback = new InProcMemoryBackend(l1);
    const b = await createMemoryBackend({ dbPath: '', dimensions: 0, logger, timeoutMs: 3_000, workerPath }, fallback);
    expect(b).toBe(fallback); // 降级到进程内
    expect(warns.some((w) => w.includes('退回进程内'))).toBe(true);
  });

  it('线程崩溃(terminate)后:在途与新请求都被 reject,不静默挂起', async () => {
    const { dbPath } = await mkL1();
    const warns: string[] = [];
    const logger: MemoryLogger = { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} };
    const b = new WorkerMemoryBackend({ dbPath, dimensions: 0, logger, workerPath });
    await b.size(); // 探活
    await b.dispose(); // 主动释放 = 与崩溃同一路径(在途请求必须被拒)
    await expect(b.size()).rejects.toThrow(/已释放|线程/);
    expect(warns.some((w) => w.includes('已拒绝'))).toBe(true);
  });
});
