/**
 * 向量计数回归:`embedding-state-get` 提速(R5)。
 *
 * 钉死三件事:
 * 1. **缺失数走相减** —— 不再调用 `countL1VecMissing`/`countL0VecMissing` 的
 *    vec0 `LEFT JOIN ... IS NULL`(实测该 JOIN 单个接口就要 2.5–3.1s)。
 * 2. **分级 TTL 缓存生效** —— 空闲期连续快照不重复敲库;`invalidateVecCache()` 后立即重算。
 * 3. **`-1` 哨兵原样透传** —— "能力挂了"不能折叠成 0(UI 据此换文案)。
 */
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingSourceStore,
  EmbeddingManager,
} from '../src/store/embedding-source.js';
import { ModelDownloadQueue } from '../src/store/download-queue.js';
import { RuntimeInstaller, PINNED_TRANSFORMERS_VERSION } from '../src/store/runtime-installer.js';
import { NoopEmbeddingService } from '../src/store/embedding.js';
import type { MemoryConfig } from '../src/config.js';
import type { MemoryLogger } from '../src/types.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-vec-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };

function cfg(): MemoryConfig {
  return {
    dataDir: '', family: 'auto',
    capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 },
    extract: { enabled: true, minMessages: 6, idleSeconds: 300, backgroundMessages: 10, candidatePool: 5 },
    l2: { enabled: true, minNewMemories: 5, maxScenes: 12, sceneContextLimit: 3 },
    l3: { enabled: true, interval: 20 },
    recall: { enabled: true, maxResults: 5, maxCharsPerMemory: 500, maxTotalRecallChars: 2000, timeoutMs: 5000, includePersona: true, includeSceneNav: true, strategy: 'hybrid', scoreThreshold: 0.3, decayHalfLifeDays: 30 },
    embedding: { enabled: true, baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', dimensions: 8, maxInputChars: 5000, timeoutMs: 10000, allowLocalModels: true, mirror: 'https://hf-mirror.com', proxy: '' },
    llm: { provider: '', model: '', mode: 'host', baseURL: '', apiKey: '', maxTokens: 65536, reasoningEffort: '', temperature: 0.3, maxInputChars: 700000, timeoutMs: 120000 },
  } as MemoryConfig;
}

interface DbStubOpts {
  total?: number;
  embedded?: number;
  skip?: string[];
  /** 让 countLVec 返回 -1(向量能力不可用)。 */
  degraded?: boolean;
}

function makeDb(opts: DbStubOpts = {}) {
  const calls = { missing: 0, countL1: 0, countL0: 0 };
  const skip = new Set(opts.skip ?? []);
  const total = opts.total ?? 100;
  const embedded = opts.degraded ? -1 : (opts.embedded ?? 0);
  return {
    calls,
    db: {
      swapProvider: vi.fn(() => ({ ok: true, needsReindex: false })),
      markEmbeddingSynced: vi.fn(),
      getVecSkipSet: () => skip,
      countL1Vec: () => embedded,
      countL0Vec: () => embedded,
      countL1: () => { calls.countL1++; return total; },
      countL0: () => { calls.countL0++; return total; },
      // 一旦被调用就说明退回慢路径了——本套件的判据就是它必须是 0
      countL1VecMissing: () => { calls.missing++; return 0; },
      countL0VecMissing: () => { calls.missing++; return 0; },
    } as never,
  };
}

async function makeManager(db: never) {
  const dataDir = join(await tmp(), `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await mkdir(dataDir, { recursive: true });
  const store = new EmbeddingSourceStore(dataDir);
  await store.init();
  const downloader = new ModelDownloadQueue(dataDir, { mirror: 'https://hf-mirror.com' });
  const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, { logger: noopLogger });
  const manager = new EmbeddingManager({
    dataDir, cfg: cfg(), db,
    l0: { setEmbeddingService: vi.fn() } as never,
    l1: { setEmbeddingService: vi.fn() } as never,
    sourceStore: store, installer, downloader,
    initial: { svc: new NoopEmbeddingService(), dims: 0 },
    logger: noopLogger,
  });
  return manager;
}

describe('embedding 向量计数(展示层)', () => {
  it('缺失数走相减,不再触碰 vec0 LEFT JOIN', async () => {
    const { db, calls } = makeDb({ total: 100, embedded: 60, skip: ['a', 'b', 'c'] });
    const m = await makeManager(db);
    try {
      const v = (await m.snapshot()).vectors.l1;
      expect(v.total).toBe(100);
      expect(v.embedded).toBe(60);
      expect(v.skipped).toBe(3);
      expect(v.missing).toBe(37); // 100 - 60 - 3
      expect(calls.missing).toBe(0); // 慢查询一次都没跑
    } finally {
      m.dispose();
    }
  });

  it('负差被 Math.max 兜底为 0(孤儿行/崩溃残留不至于显示负数)', async () => {
    const { db } = makeDb({ total: 10, embedded: 50, skip: [] });
    const m = await makeManager(db);
    try {
      expect((await m.snapshot()).vectors.l1.missing).toBe(0);
    } finally {
      m.dispose();
    }
  });

  it('-1 哨兵原样透传(能力挂了 ≠ 一条都没嵌)', async () => {
    const { db } = makeDb({ degraded: true });
    const m = await makeManager(db);
    try {
      const v = (await m.snapshot()).vectors.l1;
      expect(v.embedded).toBe(-1);
      expect(v.missing).toBe(-1);
      expect(v.missing).not.toBe(0);
    } finally {
      m.dispose();
    }
  });

  it('空闲期连续快照命中缓存;invalidateVecCache 后立即重算', async () => {
    const { db, calls } = makeDb({ total: 100, embedded: 60 });
    const m = await makeManager(db);
    try {
      await m.snapshot();
      const after1 = calls.countL1;
      await m.snapshot();
      await m.snapshot();
      expect(calls.countL1).toBe(after1); // 缓存命中,没再敲库

      m.invalidateVecCache();
      await m.snapshot();
      expect(calls.countL1).toBe(after1 + 1); // 失效后重算
    } finally {
      m.dispose();
    }
  });
});
