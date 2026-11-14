#!/usr/bin/env node
// 写放大 bench(计划 T2.5):100 条 appendNew × N 个在册驱动,断言 remember 调用数 ≤ N×100
// 且**重跑一遍为 0**(content_sha 未变 → done skip)。零 LLM、零网络——纯进程内账本核算,
// 用 dist 编译产物(dsh-prime-memory 已 build)。这是进 Phase 3 的回归底座。
//
// 用法:先 `npm run build`,再 `node bench/harness/write-amplify.mjs [drivers] [records]`
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MemoryDb } = require('../../dist/store/sqlite.js');
const { L1Store } = require('../../dist/store/l1.js');
const { ExtDriverRegistry } = require('../../dist/ext-memory/registry.js');
const { makeExtPusher } = require('../../dist/ext-memory/pusher.js');
const { EXT_DRIVER_SPECS } = require('../../dist/ext-memory/types.js');

const driverCount = Math.max(1, Math.min(5, Number(process.argv[2]) || 3));
const recordCount = Math.max(1, Number(process.argv[3]) || 100);
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-amplify-'));
const t0 = Date.now();
try {
  const db = new MemoryDb(join(dataDir, 'm.db'), 0);
  db.init();
  if (db.extSync.ready !== true) throw new Error('extSync 未就绪(先 npm run build?)');
  const l1 = new L1Store(dataDir, db, undefined, 'keyword', undefined, 0);
  await l1.init();
  const registry = new ExtDriverRegistry();
  let rememberCalls = 0;
  const caps = EXT_DRIVER_SPECS.hindsight.capabilities; // soft+async:全驱动同型
  for (let i = 0; i < driverCount; i++) {
    const id = `hs-${i}`;
    registry.register({
      id,
      typeId: 'hindsight',
      capabilities: caps,
      scoreSemantics: 'normalized-relevance',
      status: async () => ({ healthy: true }),
      search: async () => ({ results: [], hasMore: false }),
      // exact-committed 形态(不走 awaiting-settle):纯数调用次数最干净
      remember: async () => { rememberCalls++; return { completion: 'committed', externalId: `e-${rememberCalls}` }; },
      forget: async () => ({ completion: 'committed' }),
      list: async () => [],
      sincePull: async () => ({ entries: [], next: {} }),
      graph: async () => ({ nodes: [], edges: [], generatedAt: '' }),
    });
  }
  const pusher = makeExtPusher({
    registry,
    spacesOf: (id) => [{ spaceId: `${id}:main`, driverId: id, externalId: 'main', name: '', description: '' }],
    ext: db.extSync,
    l1,
    cfg: () => ({
      masterEnabled: true, enabled: true, syncMode: 'push-only', families: new Set(['work']),
      maxItems: 100_000, timeBudgetMs: 60_000, settleTimeoutMs: 60_000, maxAttempts: 3,
      backoffMs: [1, 3, 10], allowHardDelete: false, settleScanLimit: 100,
    }),
    wake: () => {},
  });
  l1.setExtSyncHook(pusher.hook);

  const now = Date.now();
  const recs = Array.from({ length: recordCount }, (_, i) => ({
    id: `r${i}`, content: `事实 ${i}:项目部署约定第 ${i} 条`, type: 'work_fact', priority: 60,
    scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now, family: 'work',
  }));
  await l1.appendNew(recs);
  const enqueued = db.extSync.countOutbox().pending;
  let stats = { processed: 0, done: 0 };
  for (;;) {
    const s = await pusher.runBatch();
    stats.processed += s.processed;
    stats.done += s.done;
    if (s.processed === 0) break;
  }
  const callsFirstPass = rememberCalls;
  // 第二遍:全账本已 clean,同内容再触发(模拟无变更轮)必须零 remember 调用
  for (const r of recs) db.extSync.enqueueOutbox({ jobId: `re-${r.id}`, driverId: 'hs-0', spaceId: 'hs-0:main', recordId: r.id, intent: 'add' });
  await pusher.runBatch();
  const callsSecondPass = rememberCalls - callsFirstPass;
  const cap = recordCount * driverCount;
  const ok1 = callsFirstPass <= cap;
  const ok2 = callsSecondPass === 0;
  console.log(`[write-amplify] records=${recordCount} drivers=${driverCount}`);
  console.log(`[write-amplify] enqueued=${enqueued} processed=${stats.processed} done=${stats.done}`);
  console.log(`[write-amplify] remember 首遍=${callsFirstPass}(上限 ${cap}) 无变更重跑=${callsSecondPass}(要求 0)`);
  if (!ok1 || !ok2) {
    console.error(`[write-amplify] ✗ 写放大不达标: 首遍 ${callsFirstPass}>${cap} 或重跑 ${callsSecondPass}≠0`);
    process.exit(1);
  }
  console.log(`[write-amplify] ✓ 通过(${Date.now() - t0}ms)`);
  db.close();
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
