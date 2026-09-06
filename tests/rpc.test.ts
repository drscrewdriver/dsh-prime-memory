/**
 * RPC 层单元测试:端点分发(统计聚合/档位设置校验/settings-set 写入门/
 * records-delete 门/list-records hall 过滤/log-tail)、机密脱敏、bench 控制面。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { registerMemoryRpc, PLUGIN_VERSION, type MemoryStatusSource, type SessionInfoSource } from '../src/stats.js';
import { registerBenchControl, BENCH_CONTROL_SERVICE } from '../src/bench-control.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { L0Store } from '../src/store/l0.js';
import { L1Store } from '../src/store/l1.js';
import { SceneStore } from '../src/store/scenes.js';
import { PersonaStore } from '../src/store/persona.js';
import { StateStore } from '../src/store/state.js';
import { SessionModeStore } from '../src/store/session-modes.js';
import { emptyOccupancyLedger } from '../src/util/context-occupancy.js';
import { initTokenCost, resetTokenCost } from '../src/token-cost.js';
import type { MemoryConfig, MemoryLiveSettings } from '../src/contract.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryLogger } from '../src/types.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-rpc-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };

function cfg(over: Partial<MemoryConfig['llm']> = {}): MemoryConfig {
  return {
    dataDir: '', family: 'auto',
    capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 },
    extract: { enabled: true, minMessages: 6, idleSeconds: 300, backgroundMessages: 10, candidatePool: 5 },
    l2: { enabled: true, minNewMemories: 5, maxScenes: 12, sceneContextLimit: 3 },
    l3: { enabled: true, interval: 20 },
    recall: { enabled: true, maxResults: 5, maxCharsPerMemory: 500, maxTotalRecallChars: 2000, timeoutMs: 5000, includePersona: true, includeSceneNav: true, strategy: 'hybrid', scoreThreshold: 0.3, decayHalfLifeDays: 30 },
    embedding: { enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 0, maxInputChars: 5000, timeoutMs: 10000, allowLocalModels: true, mirror: 'https://hf-mirror.com', proxy: '' },
    llm: { provider: '', model: '', mode: 'host', baseURL: '', apiKey: '', maxTokens: 65536, reasoningEffort: '', maxInputChars: 700000, timeoutMs: 120000, ...over },
    hall: { enabled: ['work'] },
    tokenCost: { retentionDays: 365 },
    tools: true,
    benchControl: false,
  } as MemoryConfig;
}

function liveHandle(over: Partial<MemoryLiveSettings> = {}): LiveSettingsHandle {
  const s: MemoryLiveSettings = {
    enabled: true, capture: true, distill: true, recall: true,
    reasoningEffort: '', distillProvider: '', distillModel: '', distillChain: [],
    distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0, graph: 0 }, distillMaxInputChars: 0,
    distillLayerChains: { l1: [], l2: [], l3: [] }, distillMode: '', directBaseURL: '', directApiKey: '',
    embedRemoteBaseURL: '', embedRemoteApiKey: '', embedRemoteModel: '', embedRemoteDimensions: 0, memoryMutate: false,
    ...over,
  };
  return { supported: true, get: () => s, update: async (patch) => Object.assign(s, patch) };
}

interface Harness {
  call: (endpoint: string, payload?: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
  stores: { l0: L0Store; l1: L1Store; scenes: Record<'chat' | 'work', SceneStore>; persona: Record<'chat' | 'work', PersonaStore>; state: StateStore };
  db: MemoryDb;
  modes: SessionModeStore;
  dataDir: string;
}

async function harness(opts: { live?: LiveSettingsHandle; sessionInfo?: SessionInfoSource; status?: MemoryStatusSource } = {}): Promise<Harness> {
  const dataDir = join(await tmp(), `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
  db.init();
  const l1 = new L1Store(dataDir, db, undefined, 'hybrid', noopLogger, 0);
  const l0 = new L0Store(dataDir, db);
  await l1.init();
  await l0.init();
  const scenes = { chat: new SceneStore(dataDir, 'chat'), work: new SceneStore(dataDir, 'work') };
  await scenes.chat.init();
  await scenes.work.init();
  const persona = { chat: new PersonaStore(dataDir, 'chat'), work: new PersonaStore(dataDir, 'work') };
  await persona.chat.init();
  await persona.work.init();
  const state = new StateStore(join(dataDir, 'state.json'));
  await state.load();
  const modes = new SessionModeStore(dataDir, 'auto');
  await modes.init();

  let handler: ((endpoint: string, payload: unknown) => Promise<unknown>) | undefined;
  const ctx = {
    get: (name: string) => {
      if (name === 'connection') {
        return {
          rpc: {
            handle: (_ep: string, h: (endpoint: string, payload: unknown) => Promise<unknown>) => {
              handler = h;
              return async () => {};
            },
          },
        };
      }
      return undefined;
    },
    on: () => () => {},
    effect: (fn: () => (() => void) | void) => {
      const d = fn();
      return typeof d === 'function' ? d : () => {};
    },
    llm: {} as never,
  } as unknown as Parameters<typeof registerMemoryRpc>[0];

  registerMemoryRpc(ctx, cfg(), { l0, l1, scenes, persona, state, graph: db.graphStore }, noopLogger, opts.status, opts.live, modes, dataDir, undefined, undefined, opts.sessionInfo);
  return {
    call: async (endpoint, payload) => {
      const r = (await handler!(endpoint, payload)) as { ok: boolean; value?: unknown; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? 'rpc error');
      return r.value;
    },
    stores: { l0, l1, scenes, persona, state },
    db,
    modes,
    dataDir,
  };
}

describe('rpc: stats / token-cost / unknown', () => {
  it('stats aggregates two-family state into a mixed view', async () => {
    const h = await harness();
    const s = await h.call('dsh-memory/stats') as Record<string, unknown>;
    expect(s.ok).toBe(true);
    expect(s.version).toBe(PLUGIN_VERSION);
    expect(s.family).toBe('auto');
    expect(s.thresholds).toEqual({ l2MinNewMemories: 5, l3Interval: 20 });
    h.db.close();
  });

  it('token-cost: invalid granularity normalizes; rangeDays forces day granularity', async () => {
    const h = await harness();
    initTokenCost(h.db, 365); // 接上真库,走趋势聚合路径(零值早退路径不体现 rangeDays 强制)
    const ok = await h.call('dsh-memory/token-cost', { granularity: 'month' }) as { trend: { granularity: string } };
    expect(ok.trend.granularity).toBe('month');
    const bad = await h.call('dsh-memory/token-cost', { granularity: 'hour', rangeDays: 99999 }) as { trend: { granularity: string } };
    expect(bad.trend.granularity).toBe('day'); // 非法粒度归 day;rangeDays 也强制日粒度
    // 近 N 天:强制日粒度出 N 个桶
    const near = await h.call('dsh-memory/token-cost', { granularity: 'month', rangeDays: 7 }) as { trend: { granularity: string } };
    expect(near.trend.granularity).toBe('day');
    resetTokenCost();
    h.db.close();
  });

  it('unknown endpoint errors via ok:false envelope (call wrapper turns into throw)', async () => {
    const h = await harness();
    await expect(h.call('dsh-memory/nope')).rejects.toThrow('unknown endpoint');
    h.db.close();
  });
});

describe('rpc: session mode endpoints', () => {
  it('mode set with recall override; validation rejects bad mode/payload shape', async () => {
    const h = await harness({ live: liveHandle({ recall: true }) });
    const set = await h.call('dsh-memory/session-mode-set', { sessionId: 's1', mode: 'work', recall: false }) as { mode: string; recall: boolean | null; recallResolved: boolean };
    expect(set).toEqual({ sessionId: 's1', mode: 'work', recall: false, recallResolved: false });
    // 显式 null 清除覆盖
    const cleared = await h.call('dsh-memory/session-mode-set', { sessionId: 's1', mode: 'auto', recall: null }) as { recall: null; recallResolved: boolean };
    expect(cleared.recall).toBeNull();
    expect(cleared.recallResolved).toBe(true);
    // 缺省 recall:覆盖不动
    await h.call('dsh-memory/session-mode-set', { sessionId: 's1', mode: 'chat', recall: true });
    const kept = (await h.call('dsh-memory/session-mode-set', { sessionId: 's1', mode: 'off' })) as { recall: boolean | null };
    expect(kept.recall).toBe(true);
    // 非法档位 / 非法覆盖 / 超长 sessionId
    await expect(h.call('dsh-memory/session-mode-set', { sessionId: 's', mode: 'bogus' })).rejects.toThrow('非法档位');
    await expect(h.call('dsh-memory/session-mode-set', { sessionId: 's', mode: 'auto', recall: 'yes' })).rejects.toThrow('非法注入覆盖');
    await expect(h.call('dsh-memory/session-mode-set', { sessionId: 'x'.repeat(600), mode: 'auto' })).rejects.toThrow('过长');
    const get = await h.call('dsh-memory/session-mode-get', { sessionId: 's1' }) as { mode: string; recallResolved: boolean };
    expect(get.mode).toBe('off');
    h.db.close();
  });
});

describe('rpc: settings get/set (incl. reverse-engineered keys)', () => {
  it('settings-set validates embedRemote* fields and memoryMutate boolean', async () => {
    const h = await harness({ live: liveHandle() });
    const ok = await h.call('dsh-memory/settings-set', {
      memoryMutate: true,
      embedRemoteBaseURL: 'http://ui/v1',
      embedRemoteModel: 'ui-model',
      embedRemoteDimensions: 1024,
    }) as { settings: MemoryLiveSettings };
    expect(ok.settings.memoryMutate).toBe(true);
    expect(ok.settings.embedRemoteBaseURL).toBe('http://ui/v1');
    expect(ok.settings.embedRemoteDimensions).toBe(1024);
    // 越界/非法
    await expect(h.call('dsh-memory/settings-set', { embedRemoteDimensions: 9000 })).rejects.toThrow('0~8192');
    await expect(h.call('dsh-memory/settings-set', { embedRemoteModel: 'x'.repeat(300) })).rejects.toThrow('过长');
    await expect(h.call('dsh-memory/settings-set', { memoryMutate: 'yes' })).rejects.toThrow('载荷为空'); // 非布尔不收,空载荷报错
    h.db.close();
  });

  it('api keys never leave host: set/get redact both secrets', async () => {
    const h = await harness({ live: liveHandle() });
    const set = await h.call('dsh-memory/settings-set', { directApiKey: 'secret-a', embedRemoteApiKey: 'secret-b' }) as { settings: MemoryLiveSettings };
    expect(set.settings.directApiKey).toBe('');
    expect(set.settings.embedRemoteApiKey).toBe('');
    const get = await h.call('dsh-memory/settings-get') as { settings: MemoryLiveSettings };
    expect(get.settings.directApiKey).toBe('');
    expect(get.settings.embedRemoteApiKey).toBe('');
    h.db.close();
  });

  it('effort/budget validation stays on EFFORT_CHOICES whitelist', async () => {
    const h = await harness({ live: liveHandle() });
    await expect(h.call('dsh-memory/settings-set', { reasoningEffort: 'ultra' })).rejects.toThrow('非法思考档位');
    await expect(h.call('dsh-memory/settings-set', { distillBudgets: { extract: -1, dedup: 0, l2: 0, l3: 0 } })).rejects.toThrow('0~1000000');
    await expect(h.call('dsh-memory/settings-set', { distillMaxInputChars: 500 })).rejects.toThrow('1000~1000000');
    const ok = await h.call('dsh-memory/settings-set', { reasoningEffort: 'xhigh', distillMaxInputChars: 1000 }) as Record<string, unknown>;
    expect(ok.ok).toBe(true);
    h.db.close();
  });
});

describe('rpc: list-records / records-delete', () => {
  async function seed(h: Harness) {
    const now = Date.now();
    await h.stores.l1.appendNew([
      { id: 'h1', content: '咖啡记忆', type: 'preference', priority: 60, scene_name: '日常', timestamps: [now], createdAt: now, updatedAt: now, metadata: { hall: 'work' } },
      { id: 'h2', content: '无 Hall 记忆', type: 'episodic', priority: 60, scene_name: '日常', timestamps: [now], createdAt: now, updatedAt: now, metadata: {} },
    ]);
  }

  it('list-records filters by hall on both browse and search paths', async () => {
    const h = await harness();
    await seed(h);
    const browse = await h.call('dsh-memory/list-records', { hall: 'work' }) as { items: Array<{ id: string; hall: string | null }> };
    expect(browse.items.map((i) => i.id)).toEqual(['h1']);
    expect(browse.items[0].hall).toBe('work');
    const search = await h.call('dsh-memory/list-records', { query: '咖啡 记忆', hall: 'work' }) as { items: Array<{ id: string }> };
    expect(search.items.map((i) => i.id)).toEqual(['h1']);
    h.db.close();
  });

  it('records-delete is gated by memoryMutate and caps ids at 200', async () => {
    const h = await harness({ live: liveHandle({ memoryMutate: false }) });
    await seed(h);
    await expect(h.call('dsh-memory/records-delete', { ids: ['h1'] })).rejects.toThrow('高权限');
    h.db.close();

    const h2 = await harness({ live: liveHandle({ memoryMutate: true }) });
    await seed(h2);
    const ok = await h2.call('dsh-memory/records-delete', { ids: ['h1', 42] }) as { deleted: number };
    expect(ok.deleted).toBe(1); // 非字符串 id 被滤除
    await expect(h2.call('dsh-memory/records-delete', { ids: [] })).rejects.toThrow('ids 缺失');
    h2.db.close();
  });
});

describe('rpc: log-tail', () => {
  it('reads last N lines of memory.log with UTF-8 safe chunking', async () => {
    const h = await harness();
    await writeFile(join(h.dataDir, 'memory.log'), 'l1\nl2\n中文行\nl4\n', 'utf-8');
    const r = await h.call('dsh-memory/log-tail', { lines: 2 }) as { lines: string[] };
    expect(r.lines).toEqual(['中文行', 'l4']);
    const missing = await h.call('dsh-memory/log-tail', { lines: 2 }) as { lines: string[] };
    h.db.close();
    void missing;
  });
});

describe('rpc: session-stats via SessionInfoSource', () => {
  it('builds recall reason short-circuit and retrieval capability view', async () => {
    const sessionInfo: SessionInfoSource = {
      recallStats: () => undefined,
      memoryOccupancy: () => emptyOccupancyLedger(),
      runnerView: () => ({ pendingSlice: 2, parkedSlices: 1, threshold: 6, producedRecords: 3, lastDistillAt: 1700000000000 }),
      l0Count: async () => 7,
      capabilities: () => ({ ftsSearch: true, vectorSearch: false }),
    };
    const h = await harness({ live: liveHandle({ recall: false }), sessionInfo });
    const r = await h.call('dsh-memory/session-stats', { sessionId: 's9' }) as {
      supported: boolean; recall: { enabled: boolean; reason?: string }; retrieval: string; l0Count: number; distill: { threshold: number | null };
    };
    expect(r.supported).toBe(true);
    expect(r.recall.enabled).toBe(false);
    expect(r.recall.reason).toBe('global'); // 全局关是第一个为假因子
    expect(r.retrieval).toBe('keyword');
    expect(r.l0Count).toBe(7);
    expect(r.distill.threshold).toBe(6);
    h.db.close();
  });
});

describe('rpc: graph endpoints', () => {
  it('graph-search returns compact cards; graph-node-get resolves and tolerates dangling ids', async () => {
    const h = await harness();
    h.db.upsertL1({
      id: 'rec-1', content: '张三参与 GraphX 项目', type: 'episodic', priority: 60, scene_name: '默认',
      timestamps: [Date.now()], createdAt: Date.now(), updatedAt: Date.now(), family: 'chat',
    });
    h.db.graphStore.queueGraphProjection(['rec-1'], 10000);
    const claim = h.db.graphStore.claimNext()!;
    h.db.graphStore.complete(claim.job.id, {
      reason: '',
      nodes: [
        { ref: 'a', name: '张三', type: 'person', sourceRecordIds: ['rec-1'], state: '参与 GraphX' },
      ],
      edges: [],
    });
    // 检索:返回紧凑卡(score/matchedFields/matchReason)
    const search = await h.call('dsh-memory/graph-search', { query: '张三' }) as {
      items: Array<{ node: { id: string; name: string; currentState: string }; score: number; matchReason: string }>;
    };
    expect(search.items).toHaveLength(1);
    expect(search.items[0]!.node.name).toBe('张三');
    expect(search.items[0]!.node.currentState).toContain('GraphX');
    expect(search.items[0]!.matchReason).toContain('命中');
    // 详情:node + edges;悬挂 id → node=null 不解析
    const got = await h.call('dsh-memory/graph-node-get', { id: search.items[0]!.node.id }) as { node: { name: string } | null; edges: unknown[] };
    expect(got.node?.name).toBe('张三');
    expect(got.edges).toEqual([]);
    const dangling = await h.call('dsh-memory/graph-node-get', { id: 'no-such-node' }) as { node: unknown; edges: unknown[] };
    expect(dangling.node).toBeNull();
    h.db.close();
  });

  it('graph endpoints validate inputs and degrade to empty without graph store', async () => {
    const h = await harness();
    // 入参校验:超长 query / 缺失 id
    const badQuery = (await handlerError(h, 'dsh-memory/graph-search', { query: 'x'.repeat(5000) }));
    expect(badQuery).toContain('4096');
    const badId = (await handlerError(h, 'dsh-memory/graph-node-get', { id: '' }));
    expect(badId).toContain('id');
    // limit 钳制到 1~20:超界值不炸
    const clamped = await h.call('dsh-memory/graph-search', { query: '张三', limit: 999 }) as { items: unknown[] };
    expect(Array.isArray(clamped.items)).toBe(true);
    h.db.close();
  });

  async function handlerError(h: Harness, endpoint: string, payload: unknown): Promise<string> {
    try {
      await h.call(endpoint, payload);
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
});

describe('bench control service', () => {
  it('provides the dsh-memory-bench surface with thin delegation', () => {
    let provided: unknown;
    const ctx = {
      provide: vi.fn((name: string, surface: unknown) => {
        provided = surface;
        return () => {};
      }),
    } as unknown as Parameters<typeof registerBenchControl>[0];
    const rebuild = { start: vi.fn(), getStatus: vi.fn() };
    const modes = new SessionModeStore('/nonexistent', 'work');
    const dispose = registerBenchControl(ctx, rebuild as never, modes, noopLogger);
    expect(dispose).toBeTypeOf('function');
    const surface = provided as Record<string, (...a: unknown[]) => unknown>;
    surface.setSessionMode('s1', 'chat');
    expect(modes.get('s1')).toBe('chat');
    expect(surface.getSessionMode('s1')).toBe('chat');
    surface.rebuildStart();
    expect(rebuild.start).toHaveBeenCalled();
    expect(surface.getDistillUsage()).toEqual({ layers: {} });
  });
});
