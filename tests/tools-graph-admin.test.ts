/**
 * memory_graph_admin 工具面测试(v0.26.58 A+B 两把刀的模型可见入口)。
 *
 * 三件事,每件都是**这个入口独有**的风险:
 *  ① 默认面不变——新工具进的是 graphAdmin 组,`toolGraphAdmin=false` 时它必须**不**在
 *     模型工具列表里(封印是反注册,不是执行期拒绝);常驻 8 件与默认 12 件两条既有
 *     不变量由 tools.test.ts 守,这里只守「这一个新名字」的分组归属。
 *  ② 破坏性动作吃高权限门——rebuild 与 sweep 落库都要 live.memoryMutate;而
 *     rebuild_preview 与 sweep 的缺省 dryRun 是**只读**的,不该被门挡住(否则运维
 *     看不到规模就被迫开高权限,那是把门做成了障碍)。
 *  ③ 前置条件缺席时的回报形状(图谱未启用 / 写面未接线 / 未知 action)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { L1Store } from '../src/store/l1.js';
import { L0Store } from '../src/store/l0.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { PersonaStore } from '../src/store/persona.js';
import { SceneStore } from '../src/store/scenes.js';
import { SessionModeStore } from '../src/store/session-modes.js';
import { registerMemoryTools } from '../src/tools/index.js';
import type { GraphSweepReport } from '../src/graph/sweep.js';
import type { MemoryLiveSettings } from '../src/contract.js';
import type { MemoryConfig } from '../src/config.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryLogger } from '../src/types.js';
import type { ToolDefinition } from '@deepseek-ai/cordis';

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-gadmin-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

interface RegisteredTool {
  name: string;
  description?: string;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const EMPTY_REPORT: GraphSweepReport = {
  scanned: 12, bareRoleArchived: 3, placeRenamed: 2, placeUnrenamed: 1, aliasesPruned: 5,
  factsRenamed: 7, nodesUncanon: 4, statesRebuilt: 6, conceptDups: 0,
  bareRoleQualified: 2, bareRoleBlocked: 0,
  archivedFacts: 224, archivedMaxFacts: 158,
  archivedIds: ['n1', 'n2', 'n3'], touchedIds: ['n4'], touchedConceptIds: [],
  archivedSamples: ['助手', '用户', '团队'],
};

function harness(opts: {
  liveGraphAdmin?: boolean;
  liveMutate?: boolean;
  graphOn?: boolean;
  withGraphStore?: boolean;
  withHooks?: boolean;
  rebuildImpl?: () => { cleared: { nodes: number; edges: number; concepts: number; jobs: number; projected: number }; queued: number; notice?: string };
  sweepImpl?: (dryRun: boolean) => GraphSweepReport;
} = {}) {
  const registered: RegisteredTool[] = [];
  const ctx = {
    tools: {
      register: (t: ToolDefinition) => {
        registered.push(t as unknown as RegisteredTool);
        return () => {};
      },
    },
  } as unknown as Parameters<typeof registerMemoryTools>[0];

  const live = {
    enabled: true, capture: true, distill: true, recall: true,
    distillChain: [], distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0, graph: 0 },
    distillLayerChains: { l1: [], l2: [], l3: [] },
    memoryMutate: opts.liveMutate === true,
    toolGraphAdmin: opts.liveGraphAdmin === true,
    toolLegacy: false, toolSkills: true, toolRoom: true, toolGraph: true, toolRuminate: true, toolConflict: true, toolMutate: true,
    ...(opts.graphOn === false ? {} : { graphEnabled: true }),
  } as unknown as MemoryLiveSettings;
  const liveHandle: LiveSettingsHandle = { supported: true, get: () => live, update: async () => {} };
  const cfg = {
    tools: true,
    recall: { maxResults: 5 },
    graph: { enabled: opts.graphOn !== false },
  } as unknown as MemoryConfig;

  const calls: { rebuild: number; sweep: boolean[] } = { rebuild: 0, sweep: [] };
  const graphWrite = opts.withHooks === false ? undefined : {
    enqueueGraph: () => {},
    reprojectGraph: () => ({ queued: 0, jobIds: [] }),
    rebuildGraph: () => {
      calls.rebuild++;
      return opts.rebuildImpl?.() ?? { cleared: { nodes: 1865, edges: 1454, concepts: 708, jobs: 242, projected: 1361 }, queued: 1770 };
    },
    sweepGraph: (dryRun: boolean) => {
      calls.sweep.push(dryRun);
      return opts.sweepImpl?.(dryRun) ?? EMPTY_REPORT;
    },
  };
  return { ctx, cfg, live, liveHandle, registered, calls, graphWrite };
}

async function stores() {
  const dataDir = join(await tmp(), `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
  db.init();
  const l1 = new L1Store(dataDir, db, undefined, 'hybrid', noopLogger, 0);
  await l1.init();
  const now = Date.now();
  await l1.appendNew([
    { id: 'r1', content: '用户喜欢手冲咖啡', type: 'preference', priority: 60, scene_name: '日常', timestamps: [now], createdAt: now, updatedAt: now },
  ]);
  const scenes = { chat: new SceneStore(dataDir, 'chat'), work: new SceneStore(dataDir, 'work') };
  await scenes.chat.init();
  await scenes.work.init();
  const persona = { chat: new PersonaStore(dataDir, 'chat'), work: new PersonaStore(dataDir, 'work') };
  await persona.chat.init();
  await persona.work.init();
  // 图谱存储用 MemoryDb 自带的那个(与生产同一装配),不自建连接——本测试的 execute
  // 分支只走 rebuild_preview 读 counts,拿真表才有意义。
  return { l1, l0: new L0Store(db), scenes, persona, graph: db.graphStore, db };
}

function pick(registered: RegisteredTool[], name: string): RegisteredTool | undefined {
  return registered.find((t) => t.name === name);
}

describe('memory_graph_admin 注册与分组归属', () => {
  it('toolGraphAdmin=false(线上默认)→ 该工具不注册', async () => {
    const s = await stores();
    const h = harness({ liveGraphAdmin: false });
    registerMemoryTools(h.ctx, h.cfg, s, noopLogger, new SessionModeStore('/nonexistent', 'auto'), h.liveHandle, undefined, undefined, h.graphWrite);
    expect(pick(h.registered, 'memory_graph_admin')).toBeUndefined();
    s.db.close();
  });

  it('toolGraphAdmin=true → 注册,且不挤掉既有 graphAdmin 两件', async () => {
    const s = await stores();
    const h = harness({ liveGraphAdmin: true });
    registerMemoryTools(h.ctx, h.cfg, s, noopLogger, new SessionModeStore('/nonexistent', 'auto'), h.liveHandle, undefined, undefined, h.graphWrite);
    const names = h.registered.map((t) => t.name);
    expect(names).toContain('memory_graph_admin');
    expect(names).toContain('memory_reproject');
    expect(names).toContain('memory_migrate_relation');
    // 描述里必须把「不直写图表」和三个 action 讲清:这是模型唯一的行为依据
    const desc = pick(h.registered, 'memory_graph_admin')?.description ?? '';
    expect(desc).toContain('rebuild_preview');
    expect(desc).toContain('sweep');
    expect(desc).toContain('绝不直写图表');
    s.db.close();
  });
});

describe('memory_graph_admin 执行门与回报', () => {
  async function readyWithTool(opts: Parameters<typeof harness>[0] = {}) {
    const s = await stores();
    const h = harness({ liveGraphAdmin: true, ...opts });
    registerMemoryTools(h.ctx, h.cfg, s, noopLogger, new SessionModeStore('/nonexistent', 'auto'), h.liveHandle, undefined, undefined, h.graphWrite);
    const tool = pick(h.registered, 'memory_graph_admin');
    if (!tool) throw new Error('工具未注册(harness 配错)');
    return { tool, h, s };
  }

  it('rebuild_preview 只读:不开高权限门也能拿到规模', async () => {
    const { tool, s } = await readyWithTool({ liveMutate: false });
    const out = await tool.execute({ action: 'rebuild_preview' });
    expect(String(out.notice)).toContain('重建将清空');
    expect(out.cleared).toBeTruthy();
    s.db.close();
  });

  it('rebuild 需高权限门;门开着才真正触发重建', async () => {
    const a = await readyWithTool({ liveMutate: false });
    const blocked = await a.tool.execute({ action: 'rebuild' });
    expect(String(blocked.notice)).toContain('高权限');
    expect(a.h.calls.rebuild).toBe(0);
    a.s.db.close();

    const b = await readyWithTool({ liveMutate: true });
    const ok = await b.tool.execute({ action: 'rebuild' });
    expect(b.h.calls.rebuild).toBe(1);
    expect(ok.queued).toBe(1770);
    expect(String(ok.notice)).toContain('图谱重建已启动');
    b.s.db.close();
  });

  it('rebuild 遇 runner 回报原因(未启用等)原样透出,不谎报已启动', async () => {
    const { tool, h, s } = await readyWithTool({
      liveMutate: true,
      rebuildImpl: () => ({ cleared: { nodes: 0, edges: 0, concepts: 0, jobs: 0, projected: 0 }, queued: 0, notice: '图谱未启用。' }),
    });
    const out = await tool.execute({ action: 'rebuild' });
    expect(out.notice).toBe('图谱未启用。');
    expect(out.queued).toBeUndefined();
    expect(h.calls.rebuild).toBe(1);
    s.db.close();
  });

  it('sweep 缺省 dry_run=true;显式 false 才落库——两次都要高权限门', async () => {
    const a = await readyWithTool({ liveMutate: false });
    const blocked = await a.tool.execute({ action: 'sweep' });
    expect(String(blocked.notice)).toContain('高权限');
    expect(a.h.calls.sweep).toEqual([]);
    a.s.db.close();

    const b = await readyWithTool({ liveMutate: true });
    const preview = await b.tool.execute({ action: 'sweep' });
    expect(preview.dry_run).toBe(true);
    expect(String(preview.notice)).toContain('清扫预演');
    expect(String(preview.notice)).toContain('助手'); // 样例回显,让人敢按下去落库
    // 枢纽警告:B 刀把 bareRole 压到 0 的同时,会把 `用户`/`AI` 这类偏好汇聚节点
    // 一起归档。notice 必须把退场物质报出来并警告,否则就是拿好数字糊弄人。
    expect(String(preview.notice)).toContain('224');
    expect(String(preview.notice)).toContain('裸角色改限定名(枢纽保留)2'); // 枢纽保留那一路也要在 notice 里可见
    expect(String(preview.notice)).toContain('枢纽');
    const applied = await b.tool.execute({ action: 'sweep', dry_run: false });
    expect(applied.dry_run).toBe(false);
    expect(String(applied.notice)).toContain('清扫已落库');
    expect(b.h.calls.sweep).toEqual([true, false]);
    expect((applied.report as Record<string, unknown>).bareRoleArchived).toBe(3);
    b.s.db.close();
  });

  it('未知 action 回词表;图谱关闭与写面未接线各自单独回报', async () => {
    const a = await readyWithTool({ liveMutate: true });
    expect(String((await a.tool.execute({ action: 'nope' })).notice)).toContain('rebuild_preview');
    a.s.db.close();

    const b = await readyWithTool({ liveMutate: true, graphOn: false });
    expect(String((await b.tool.execute({ action: 'sweep' })).notice)).toContain('图谱');
    b.s.db.close();

    const c = await readyWithTool({ liveMutate: true, withHooks: false });
    expect(String((await c.tool.execute({ action: 'rebuild' })).notice)).toContain('未接线');
    c.s.db.close();
  });
});
