/**
 * 激活槽位端到端验收(task_42 / task_43)。
 *
 * 覆盖 E1→E4 的**进程内**全链路:真 `defineTool` 工具面 + 真 cordis
 * `ctx.waterfall('agent/pre-step')` 注入面 + 真 `SlotStore` 持久面,三个面共用同一个
 * store,验证"写入网络规则槽位 → 下一轮注入可见 → 关闭后不再注入但仍在清单里"。
 *
 * 范围声明:LLM 回合与宿主进程装载不在此测试内(需要重启宿主),见 tasks.md task_42 注。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { registerSlotRecall } from '../src/hooks/slot-recall.js';
import { SlotStore } from '../src/store/slots.js';
import { registerSlotTools } from '../src/tools/slots.js';
import { SessionModeStore } from '../src/store/session-modes.js';
import type { MemoryConfig } from '../src/config.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryLogger } from '../src/types.js';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-slots-e2e-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as MemoryLogger;

const RULE_TITLE = '网络访问;上行官方 + SSH';
const RULE_BODY = '下行走国内镜像;禁止叠加代理,只许按序回退';

interface ToolLike {
  name: string;
  execute: (args: Record<string, unknown>, exec?: { agent?: { id?: string } }) => Promise<unknown>;
}

interface Decision {
  kind: string;
  messages: { content?: { type: string; text: string }[]; source?: { kind?: string; plugin?: string } }[];
}

/** 会话端装配:工具面(fake ctx.tools 捕获真 defineTool 产物)+ 注入面(真 waterfall)。 */
async function setup() {
  const dataDir = join(await tmp(), `e2e-${Math.random().toString(36).slice(2)}`);
  const file = SlotStore.pathFor(dataDir);
  const store = new SlotStore(file, noopLogger, { maxSlots: 8, maxBodyChars: 512, maxTitleChars: 60 });
  await store.load();

  const cfg = {
    tools: true,
    slots: { enabled: true, inject: true, maxSlots: 8, maxAlwaysOnBytes: 2048, maxBodyChars: 512 },
  } as unknown as MemoryConfig;
  const live = { supported: true, get: () => ({ recall: true, memoryMutate: true }), update: async () => {} } as unknown as LiveSettingsHandle;
  const modes = new SessionModeStore('/nonexistent', 'auto');

  const registered: ToolLike[] = [];
  const toolsCtx = {
    tools: { register: (t: ToolDefinition) => registered.push(t as unknown as ToolLike) },
  } as unknown as Parameters<typeof registerSlotTools>[0];
  registerSlotTools(toolsCtx, cfg, store, noopLogger, modes, live);

  const ctx = new Context();
  registerSlotRecall(ctx, cfg, store, noopLogger, live);

  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = registered.find((t) => t.name === name);
    if (!tool) throw new Error(`工具未注册:${name}`);
    return (await tool.execute(args, { agent: { id: 'sess-e2e' } })) as Record<string, unknown>;
  };

  /** 跑一次真实的 agent/pre-step waterfall,返回注入后的最终决策。 */
  const nextTurn = async (): Promise<{ decision: Decision; injected: string }> => {
    const user = { content: [{ type: 'text', text: '开始干活' }] };
    const base: Decision = { kind: 'enter', messages: [user] };
    const events = ctx as unknown as {
      waterfall(name: string, payload: unknown, inner: () => Promise<Decision>): Promise<Decision>;
    };
    const decision = await events.waterfall(
      'agent/pre-step',
      { agent: { id: 'sess-e2e' }, messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
      async () => base,
    );
    const injected = decision.messages
      .filter((m) => m.source?.kind === 'plugin')
      .flatMap((m) => m.content ?? [])
      .map((c) => c.text)
      .join('\n');
    return { decision, injected };
  };

  return { store, file, dataDir, call, nextTurn };
}

describe('端到端 E1 → E4', () => {
  it('E1/E2:写入 pinned 规则槽位后,下一轮注入文本里出现该规则(核心验收)', async () => {
    const { call, nextTurn } = await setup();
    const written = await call('memory_slot_write', {
      title: RULE_TITLE,
      kind: 'rule',
      body: RULE_BODY,
      pinned: true,
      priority: 95,
      refs: 'design/network-policy.md',
    });
    expect(written.id).toMatch(/^slot_/);

    const { decision, injected } = await nextTurn();
    expect(injected).toContain('【激活槽位 · 常驻上下文】');
    expect(injected).toContain(`[rule] ${RULE_TITLE}: ${RULE_BODY}`);
    // 注入消息排在用户消息之前,并带插件署名来源(与 recall 同款范式)
    expect(decision.messages[0]?.source).toEqual({ kind: 'plugin', plugin: 'memory', form: 'recall' });
    expect(decision.messages).toHaveLength(2);
  });

  it('E3:memory_slot_list 返回该槽位且 status=open', async () => {
    const { call } = await setup();
    await call('memory_slot_write', { title: RULE_TITLE, kind: 'rule', body: RULE_BODY, pinned: true });
    const listed = (await call('memory_slot_list', {})) as { slots: { title: string; kind: string; status: string; pinned: boolean }[] };
    expect(listed.slots).toHaveLength(1);
    expect(listed.slots[0]).toMatchObject({ title: RULE_TITLE, kind: 'rule', status: 'open', pinned: true });
  });

  it('E4:close 后不再注入,但 list 仍可见(status=done)', async () => {
    const { call, nextTurn, store } = await setup();
    const written = (await call('memory_slot_write', { title: RULE_TITLE, body: RULE_BODY, pinned: true })) as { id: string };
    expect((await nextTurn()).injected).toContain(RULE_TITLE);

    expect(await call('memory_slot_close', { id: written.id, status: 'done' })).toEqual({ ok: true, linked: [], retired: [] });

    const after = await nextTurn();
    expect(after.injected).not.toContain(RULE_TITLE);
    expect(after.injected).toBe(''); // 无可注入内容 → 决策原样返回(零注入)
    expect(after.decision.messages).toHaveLength(1);

    const listed = (await call('memory_slot_list', {})) as { slots: { status: string }[] };
    expect(listed.slots[0]?.status).toBe('done');
    expect(store.count()).toBe(1);
  });

  it('F2 跨会话:新会话的 store 读回同一槽位,且新会话的注入面一致', async () => {
    const first = await setup();
    await first.call('memory_slot_write', { title: RULE_TITLE, body: RULE_BODY, pinned: true });

    // 新会话:同 dataDir 的新 store 实例(等价于宿主重启/切会话后的装载)
    const reopened = new SlotStore(first.file, noopLogger, { maxSlots: 8, maxBodyChars: 512, maxTitleChars: 60 });
    await reopened.load();
    expect(reopened.list().map((s) => s.title)).toEqual([RULE_TITLE]);

    const ctx = new Context();
    const cfg = {
      tools: true,
      slots: { enabled: true, inject: true, maxSlots: 8, maxAlwaysOnBytes: 2048, maxBodyChars: 512 },
    } as unknown as MemoryConfig;
    const live = { supported: true, get: () => ({ recall: true }), update: async () => {} } as unknown as LiveSettingsHandle;
    registerSlotRecall(ctx, cfg, reopened, noopLogger, live);
    const user = { content: [{ type: 'text', text: 'hi' }] };
    const decision = await (
      ctx as unknown as { waterfall(name: string, payload: unknown, inner: () => Promise<Decision>): Promise<Decision> }
    ).waterfall(
      'agent/pre-step',
      { agent: { id: 'sess-2' }, messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [user] }) as Decision,
    );
    const injected = (decision.messages[0]?.content ?? []).map((c) => c.text).join('\n');
    expect(injected).toContain(RULE_BODY);
  });
});
