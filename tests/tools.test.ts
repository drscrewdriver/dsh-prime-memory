/**
 * 工具层单元测试:五工具注册、档位过滤(off/只写/纯档/auto/fail-open)、
 * limit 钳制、memoryMutate 门与 add/delete 语义。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { registerMemoryTools } from '../src/tools/index.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { L0Store } from '../src/store/l0.js';
import { L1Store } from '../src/store/l1.js';
import { SceneStore } from '../src/store/scenes.js';
import { PersonaStore } from '../src/store/persona.js';
import { SessionModeStore } from '../src/store/session-modes.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryConfig, MemoryLiveSettings } from '../src/contract.js';
import type { MemoryFamily, MemoryLogger } from '../src/types.js';
import type { Tool } from '@deepseek-ai/dsh-tools';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-tools-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface RegisteredTool {
  name: string;
  execute: (args: Record<string, unknown>, exec?: { agent?: { id?: string } }) => Promise<unknown>;
}

function harness(opts: { liveMutate?: boolean; sessionMode?: (sid: string) => string } = {}) {
  const live: MemoryLiveSettings = {
    enabled: true, capture: true, distill: true, recall: true,
    reasoningEffort: '', distillProvider: '', distillModel: '', distillChain: [],
    distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0 }, distillMaxInputChars: 0,
    distillLayerChains: { l1: [], l2: [], l3: [] }, distillMode: '', directBaseURL: '', directApiKey: '',
    embedRemoteBaseURL: '', embedRemoteApiKey: '', embedRemoteModel: '', embedRemoteDimensions: 0,
    memoryMutate: opts.liveMutate ?? false,
  };
  const liveHandle: LiveSettingsHandle = { supported: true, get: () => live, update: async () => {} };
  const modes = new SessionModeStore('/nonexistent', 'auto');
  (modes as unknown as { entries: Map<string, unknown> }).entries.set(
    'work-sess', { mode: 'work', recall: undefined, updatedAt: Date.now() },
  );
  (modes as unknown as { entries: Map<string, unknown> }).entries.set(
    'off-sess', { mode: 'off', recall: undefined, updatedAt: Date.now() },
  );
  (modes as unknown as { entries: Map<string, unknown> }).entries.set(
    'wo-sess', { mode: 'chat', recall: false, updatedAt: Date.now() },
  );

  const registered: RegisteredTool[] = [];
  const ctx = {
    tools: {
      register: (t: Tool) => registered.push(t as unknown as RegisteredTool),
    },
  } as unknown as Parameters<typeof registerMemoryTools>[0];

  const cfg = {
    tools: true,
    recall: { maxResults: 5 },
  } as unknown as MemoryConfig;

  return { ctx, cfg, modes, liveHandle, registered };
}

describe('memory tools', () => {
  async function setupStores() {
    const dataDir = join(await tmp(), `tools-${Date.now()}`);
    const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
    db.init();
    const l1 = new L1Store(dataDir, db, undefined, 'hybrid', noopLogger, 0);
    const l0 = new L0Store(dataDir, db);
    await l1.init();
    await l0.init();
    const now = Date.now();
    await l1.appendNew([
      { id: 'r1', content: '用户喜欢手冲咖啡', type: 'preference', priority: 60, scene_name: '日常', timestamps: [now], createdAt: now, updatedAt: now },
      { id: 'r2', content: '团队用 GitLab CI', type: 'work_fact', priority: 50, scene_name: '基建', timestamps: [now], createdAt: now, updatedAt: now },
    ]);
    const scenes = {
      chat: new SceneStore(dataDir, 'chat'),
      work: new SceneStore(dataDir, 'work'),
    };
    await scenes.chat.init();
    await scenes.work.init();
    await scenes.chat.write('咖啡.md', '# 咖啡偏好');
    const persona = {
      chat: new PersonaStore(dataDir, 'chat'),
      work: new PersonaStore(dataDir, 'work'),
    };
    await persona.chat.init();
    await persona.work.init();
    await persona.chat.write('# 用户画像');
    return { db, l1, l0, scenes, persona };
  }

  it('registers exactly the five tools', async () => {
    const stores = await setupStores();
    const h = harness();
    registerMemoryTools(h.ctx, h.cfg, stores, noopLogger, h.modes, h.liveHandle);
    expect(h.registered.map((t) => t.name).sort()).toEqual([
      'conversation_search', 'memory_add', 'memory_delete', 'memory_read_scene', 'memory_search',
    ]);
    stores.db.close();
  });

  it('memory_search: auto unfiltered, pure mode filters family, limit clamped 1-20', async () => {
    const stores = await setupStores();
    const h = harness();
    registerMemoryTools(h.ctx, h.cfg, stores, noopLogger, h.modes, h.liveHandle);
    const search = h.registered.find((t) => t.name === 'memory_search')!;
    const exec = (id?: string) => ({ agent: id === undefined ? undefined : { id } });

    const all = (await search.execute({ query: '咖啡 GitLab', limit: 50 }, exec('auto-sess'))) as { items: Array<{ id?: string; content: string }> };
    expect(all.items.length).toBe(2); // auto 不过滤族;limit 钳到 20 后全命中
    const workOnly = (await search.execute({ query: 'GitLab 咖啡', limit: 5 }, exec('work-sess'))) as { items: Array<{ content: string }> };
    expect(workOnly.items.length).toBe(1);
    expect(workOnly.items[0].content).toContain('GitLab');
    stores.db.close();
  });

  it('read gates: off / write-only / global recall off return distinct notices', async () => {
    const stores = await setupStores();
    const h = harness();
    registerMemoryTools(h.ctx, h.cfg, stores, noopLogger, h.modes, h.liveHandle);
    const search = h.registered.find((t) => t.name === 'memory_search')!;
    const off = (await search.execute({ query: 'x' }, { agent: { id: 'off-sess' } })) as { notice: string };
    expect(off.notice).toContain('完全隐身');
    const wo = (await search.execute({ query: 'x' }, { agent: { id: 'wo-sess' } })) as { notice: string };
    expect(wo.notice).toContain('只写模式');
    // fail-open:缺 agent 标识 → 全族放行
    const noAgent = (await search.execute({ query: '咖啡' }, {})) as { items: unknown[] };
    expect(noAgent.items.length).toBe(1);
    stores.db.close();
  });

  it('memory_read_scene resolves persona and cross-family scene files', async () => {
    const stores = await setupStores();
    const h = harness();
    registerMemoryTools(h.ctx, h.cfg, stores, noopLogger, h.modes, h.liveHandle);
    const read = h.registered.find((t) => t.name === 'memory_read_scene')!;
    const persona = (await read.execute({ path: 'persona-chat.md' }, { agent: { id: 'auto-sess' } })) as { content: string };
    expect(persona.content).toContain('用户画像');
    const scene = (await read.execute({ path: '咖啡.md' }, { agent: { id: 'work-sess' } })) as { content: string };
    expect(scene.content).toContain('咖啡偏好'); // work 会话查 chat 族场景(先本族后另一族)
    stores.db.close();
  });

  it('memory_add: gated by memoryMutate; defaults episodic/80/__manual__', async () => {
    const stores = await setupStores();
    const h = harness({ liveMutate: false });
    registerMemoryTools(h.ctx, h.cfg, stores, noopLogger, h.modes, h.liveHandle);
    const add = h.registered.find((t) => t.name === 'memory_add')!;
    const denied = (await add.execute({ content: '测试' }, {})) as { notice: string };
    expect(denied.notice).toContain('高权限');

    // 开门后写入
    const h2 = harness({ liveMutate: true });
    registerMemoryTools(h2.ctx, h2.cfg, stores, noopLogger, h2.modes, h2.liveHandle);
    const add2 = h2.registered.find((t) => t.name === 'memory_add')!;
    const ok = (await add2.execute({ content: '记得我明天要体检', type: 'work_task', hall: 'work' }, {})) as { id: string };
    expect(ok.id).toMatch(/^mem-/);
    const rec = stores.l1.getByIds([ok.id])[0];
    expect(rec.type).toBe('work_task');
    expect(rec.family).toBe('work');
    expect(rec.priority).toBe(80);
    expect(rec.scene_name).toBe('__manual__');
    expect(rec.metadata).toEqual({ hall: 'work' });
    // 非法 type 缺省 episodic
    const fallback = (await add2.execute({ content: '随便记一条' }, {})) as { id: string };
    expect(stores.l1.getByIds([fallback.id])[0].type).toBe('episodic');
    stores.db.close();
  });

  it('memory_delete: gated, semantic search then batch delete', async () => {
    const stores = await setupStores();
    const h2 = harness({ liveMutate: true });
    registerMemoryTools(h2.ctx, h2.cfg, stores, noopLogger, h2.modes, h2.liveHandle);
    const del = h2.registered.find((t) => t.name === 'memory_delete')!;
    const noMatch = (await del.execute({ query: '完全不存在的量子记忆' }, { agent: { id: 'auto-sess' } })) as { deleted: number; notice?: string };
    expect(noMatch.deleted).toBe(0);
    const ok = (await del.execute({ query: '手冲咖啡', limit: 1 }, { agent: { id: 'auto-sess' } })) as { deleted: number; ids: string[] };
    expect(ok.deleted).toBe(1);
    expect(stores.l1.getByIds(ok.ids).length).toBe(0); // 已从检索库删除
    // 关门拒绝
    const h1 = harness({ liveMutate: false });
    registerMemoryTools(h1.ctx, h1.cfg, stores, noopLogger, h1.modes, h1.liveHandle);
    const del1 = h1.registered.find((t) => t.name === 'memory_delete')!;
    const denied = (await del1.execute({ query: '咖啡' }, {})) as { notice: string };
    expect(denied.notice).toContain('高权限');
    stores.db.close();
  });
});
