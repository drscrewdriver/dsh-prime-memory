/**
 * 激活槽位工具面单元测试(task_23):三工具注册 / memoryMutate 写门控两态 /
 * 会话档位读门控 / 参数边界 / 上限错误透出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { registerSlotTools } from '../src/tools/slots.js';
import { SlotStore } from '../src/store/slots.js';
import { SessionModeStore } from '../src/store/session-modes.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryConfig } from '../src/config.js';
import type { MemoryLiveSettings } from '../src/contract.js';
import type { MemoryLogger } from '../src/types.js';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-slots-tools-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as MemoryLogger;

interface RegisteredTool {
  name: string;
  execute: (args: Record<string, unknown>, exec?: { agent?: { id?: string } }) => Promise<unknown>;
  output?: { render?: (args: Record<string, unknown>, value: never) => { type: string; text: string }[] };
}

interface Harness {
  registered: RegisteredTool[];
  store: SlotStore;
  call: (name: string, args: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
  text: (name: string, args: Record<string, unknown>, value: unknown) => string;
}

/** L1 勾连桩:retiredIds 里能解析到的 id 视为现存 L1 记录;retire 调用被记录。 */
function stubL1(retiredIds: string[]) {
  const retireCalls: string[][] = [];
  return {
    retireCalls,
    getByIds: (ids: string[]) => ids.filter((id) => retiredIds.includes(id)).map((id) => ({ id })),
    retire: (ids: string[]) => {
      retireCalls.push([...ids]);
      return ids.length;
    },
  };
}

async function harness(opts: { mutate?: boolean; globalRecall?: boolean; tools?: boolean; maxSlots?: number; l1?: ReturnType<typeof stubL1> } = {}): Promise<Harness> {
  const dataDir = join(await tmp(), `t-${Math.random().toString(36).slice(2)}`);
  const store = new SlotStore(SlotStore.pathFor(dataDir), noopLogger, {
    maxSlots: opts.maxSlots ?? 8,
    maxBodyChars: 512,
    maxTitleChars: 60,
  });
  await store.load();

  const live: MemoryLiveSettings = {
    enabled: true,
    capture: true,
    distill: true,
    recall: opts.globalRecall ?? true,
    memoryMutate: opts.mutate ?? false,
  } as unknown as MemoryLiveSettings;
  const liveHandle: LiveSettingsHandle = { supported: true, get: () => live, update: async () => {} };

  const modes = new SessionModeStore('/nonexistent', 'auto');
  const entries = (modes as unknown as { entries: Map<string, unknown> }).entries;
  entries.set('work-sess', { mode: 'work', recall: undefined, updatedAt: 0 });
  entries.set('off-sess', { mode: 'off', recall: undefined, updatedAt: 0 });
  entries.set('wo-sess', { mode: 'chat', recall: false, updatedAt: 0 });

  const registered: RegisteredTool[] = [];
  const ctx = {
    tools: { register: (t: ToolDefinition) => registered.push(t as unknown as RegisteredTool) },
  } as unknown as Parameters<typeof registerSlotTools>[0];

  const cfg = { tools: opts.tools ?? true } as unknown as MemoryConfig;
  registerSlotTools(ctx, cfg, store, noopLogger, modes, liveHandle, opts.l1);

  const find = (name: string): RegisteredTool => {
    const tool = registered.find((t) => t.name === name);
    if (!tool) throw new Error(`未注册工具:${name}`);
    return tool;
  };
  return {
    registered,
    store,
    call: (name, args, sessionId = 'work-sess') =>
      find(name).execute(args, sessionId ? { agent: { id: sessionId } } : undefined),
    text: (name, args, value) => {
      const parts = find(name).output?.render?.(args, value as never) ?? [];
      return parts.map((p) => p.text).join('\n');
    },
  };
}

describe('槽位工具注册面', () => {
  it('恰好注册三个工具(F4);cfg.tools=false 时零注册', async () => {
    const h = await harness();
    expect(h.registered.map((t) => t.name).sort()).toEqual([
      'memory_slot_close',
      'memory_slot_list',
      'memory_slot_write',
    ]);
    const off = await harness({ tools: false });
    expect(off.registered).toEqual([]);
  });
});

describe('memory_slot_write / close 的 memoryMutate 门控(F5)', () => {
  it('mutate=false:写入被拒并返回明确 notice,store 不变', async () => {
    const h = await harness({ mutate: false });
    const res = (await h.call('memory_slot_write', { title: '网络规则' })) as { id?: string; notice?: string };
    expect(res.id).toBeUndefined();
    expect(res.notice).toMatch(/高权限/);
    expect(h.store.count()).toBe(0);
    expect(await h.call('memory_slot_close', { id: 'slot_x' })).toEqual(expect.objectContaining({ ok: false }));
    expect(h.store.revision()).toBe(0); // 未发生任何写盘
  });

  it('mutate=true:写入成功并可被 list 读回', async () => {
    const h = await harness({ mutate: true });
    const res = (await h.call('memory_slot_write', {
      title: '网络:上行官方 + SSH,下行走国内镜像',
      kind: 'rule',
      pinned: true,
      priority: 95,
      body: '所有下载走镜像,禁止叠加代理',
      refs: 'design/network-policy.md, r-123',
    })) as { id?: string };
    expect(res.id).toMatch(/^slot_/);
    expect(h.store.count()).toBe(1);
    const listed = (await h.call('memory_slot_list', {})) as { slots: { title: string; refs: string[] }[] };
    expect(listed.slots).toHaveLength(1);
    expect(listed.slots[0]?.refs).toEqual(['design/network-policy.md', 'r-123']);
  });

  it('close:命中置 done,未命中返回 ok=false', async () => {
    const h = await harness({ mutate: true });
    const created = (await h.call('memory_slot_write', { title: 'A', pinned: true })) as { id: string };
    expect(await h.call('memory_slot_close', { id: created.id, status: 'done' })).toEqual({ ok: true, linked: [], retired: [] });
    expect(h.store.list()[0]?.status).toBe('done');
    expect(await h.call('memory_slot_close', { id: 'slot_missing' })).toEqual({ ok: false, linked: [], retired: [], notice: '槽位不存在或关闭失败' });
    expect(await h.call('memory_slot_close', { id: '  ' })).toEqual(
      expect.objectContaining({ ok: false, notice: 'id 为空' }),
    );
    expect(h.store.list()[0]?.status).toBe('done');
  });

  it('close 勾连记忆(方案 A):refs 中 record_id 回带 linked + 引导语,不写 L1', async () => {
    const l1 = stubL1(['r-123']);
    const h = await harness({ mutate: true, l1 });
    const created = (await h.call('memory_slot_write', {
      title: '旧网络策略',
      refs: 'r-123, design/network-policy.md, https://example.com/a',
    })) as { id: string };
    const res = (await h.call('memory_slot_close', { id: created.id, status: 'dropped' })) as {
      ok: boolean;
      linked: string[];
      retired: string[];
    };
    expect(res).toEqual({ ok: true, linked: ['r-123'], retired: [] });
    expect(l1.retireCalls).toEqual([]); // 方案 A 纯读,零写入
    // 文案引导:告诉模型正文仍在检索面 + 两条后续路径
    const text = h.text('memory_slot_close', {}, res);
    expect(text).toMatch(/引用 1 条 L1 记忆/);
    expect(text).toMatch(/memory_delete|retireRefs/);
  });

  it('close 勾连记忆(方案 B):retireRefs=true 把可解析 refs 一并软删退场', async () => {
    const l1 = stubL1(['r-123']);
    const h = await harness({ mutate: true, l1 });
    const created = (await h.call('memory_slot_write', {
      title: '旧网络策略',
      refs: 'r-123, design/network-policy.md',
    })) as { id: string };
    const res = (await h.call('memory_slot_close', { id: created.id, retireRefs: true })) as {
      ok: boolean;
      linked: string[];
      retired: string[];
    };
    expect(res).toEqual({ ok: true, linked: ['r-123'], retired: ['r-123'] });
    expect(l1.retireCalls).toEqual([['r-123']]);
    const text = h.text('memory_slot_close', {}, res);
    expect(text).toMatch(/退场 1 条引用记忆/);
  });

  it('close 勾连记忆:路径/URL 类 refs 自动跳过;无勾连时不带引导噪音', async () => {
    const l1 = stubL1([]);
    const h = await harness({ mutate: true, l1 });
    const created = (await h.call('memory_slot_write', {
      title: '纯指针槽位',
      refs: 'design/x.md, https://example.com',
    })) as { id: string };
    const res = (await h.call('memory_slot_close', { id: created.id, retireRefs: true })) as {
      ok: boolean;
      linked: string[];
      retired: string[];
    };
    expect(res).toEqual({ ok: true, linked: [], retired: [] });
    expect(l1.retireCalls).toEqual([]);
    expect(h.text('memory_slot_close', {}, res)).not.toMatch(/引用|退场/);
  });

  it('list 输出无损 JSON 合规:无 origin 键、validUntil 未设时不落 undefined 键(真机回归)', async () => {
    // 真机 bug:空集能返回,一旦有槽位 host 报 "value is not lossless JSON"。
    // 根因① store 归一化恒写 `validUntil: undefined` 键,clone 展开保留,JSON.stringify 丢键 → 往返不无损;
    // 根因② Slot.origin 未在 output schema(additionalProperties:false)声明,透传越界。
    const h = await harness({ mutate: true });
    await h.call('memory_slot_write', { title: '无期限槽位' });
    await h.call('memory_slot_write', { title: '有期限槽位', validUntil: '2026-12-31T00:00:00.000Z' });
    const listed = (await h.call('memory_slot_list', {})) as { slots: Record<string, unknown>[] };
    expect(listed.slots).toHaveLength(2);
    for (const s of listed.slots) {
      expect('origin' in s).toBe(false);
      expect(!('validUntil' in s) || s.validUntil !== undefined).toBe(true);
      // 无损往返:JSON 序列化再反解,键集合必须不变
      const round = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
      expect(Object.keys(round).sort()).toEqual(Object.keys(s).sort());
    }
    const withDue = listed.slots.find((s) => s.title === '有期限槽位') as Record<string, unknown>;
    expect(withDue.validUntil).toBe('2026-12-31T00:00:00.000Z');
    const noDue = listed.slots.find((s) => s.title === '无期限槽位') as Record<string, unknown>;
    expect('validUntil' in noDue).toBe(false);
  });

  it('渲染面:notice 与槽位清单直达模型', async () => {
    const denied = await harness({ mutate: false });
    const notice = (await denied.call('memory_slot_write', { title: 'A' })) as never;
    expect(denied.text('memory_slot_write', {}, notice)).toMatch(/高权限/);

    const allowed = await harness({ mutate: true });
    await allowed.call('memory_slot_write', { title: '网络规则', pinned: true, kind: 'rule' });
    const listValue = (await allowed.call('memory_slot_list', {})) as never;
    expect(allowed.text('memory_slot_list', {}, listValue)).toContain('网络规则');
    const closeValue = (await allowed.call('memory_slot_close', { id: 'slot_missing' })) as never;
    expect(allowed.text('memory_slot_close', {}, closeValue)).toMatch(/不存在|失败/);
  });
});

describe('memory_slot_list 的会话档位门控(task_19)', () => {
  it('off 档拒读;注入覆盖=关拒读;正常档返回槽位', async () => {
    const h = await harness({ mutate: true });
    await h.call('memory_slot_write', { title: 'A', pinned: true });

    const off = (await h.call('memory_slot_list', {}, 'off-sess')) as { slots: unknown[]; notice?: string };
    expect(off.slots).toEqual([]);
    expect(off.notice).toMatch(/关闭/);

    const override = (await h.call('memory_slot_list', {}, 'wo-sess')) as { slots: unknown[]; notice?: string };
    expect(override.slots).toEqual([]);
    expect(override.notice).toMatch(/召回已关闭/);

    const ok = (await h.call('memory_slot_list', {}, 'work-sess')) as { slots: unknown[]; notice?: string };
    expect(ok.slots).toHaveLength(1);
    expect(ok.notice).toBeUndefined();
  });

  it('全局召回关闭时拒读;缺 agent 标识时 fail-open', async () => {
    const closed = await harness({ mutate: true, globalRecall: false });
    await closed.call('memory_slot_write', { title: 'A' });
    const res = (await closed.call('memory_slot_list', {}, 'work-sess')) as { slots: unknown[]; notice?: string };
    expect(res.notice).toMatch(/召回已关闭/);

    const open = await harness({ mutate: true });
    await open.call('memory_slot_write', { title: 'A' });
    const noAgent = (await open.call('memory_slot_list', {}, '')) as { slots: unknown[] };
    expect(noAgent.slots).toHaveLength(1);
  });
  it('status 过滤', async () => {
    const h = await harness({ mutate: true });
    const a = (await h.call('memory_slot_write', { title: 'A' })) as { id: string };
    await h.call('memory_slot_write', { title: 'B' });
    await h.call('memory_slot_close', { id: a.id });
    const done = (await h.call('memory_slot_list', { status: 'done' })) as { slots: { title: string }[] };
    expect(done.slots.map((s) => s.title)).toEqual(['A']);
    const all = (await h.call('memory_slot_list', { status: '  ' })) as { slots: unknown[] };
    expect(all.slots).toHaveLength(2);
  });
});

describe('write 参数边界', () => {
  it('空标题 → notice 且不写;超上限 → 错误消息透出不抛', async () => {
    const h = await harness({ mutate: true, maxSlots: 1 });
    const empty = (await h.call('memory_slot_write', { title: '   ' })) as { notice?: string };
    expect(empty.notice).toMatch(/title/);
    expect(h.store.count()).toBe(0);

    await h.call('memory_slot_write', { title: 'A' });
    const over = (await h.call('memory_slot_write', { title: 'B' })) as { notice?: string; id?: string };
    expect(over.id).toBeUndefined();
    expect(over.notice).toMatch(/上限/);
    expect(h.store.count()).toBe(1);
  });

  it('非法 kind/priority/status 被规范化,不抛错', async () => {
    const h = await harness({ mutate: true });
    await h.call('memory_slot_write', {
      title: 'X',
      kind: 'nonsense',
      priority: -5,
      status: 'nonsense',
      validUntil: '   ',
    });
    const slot = h.store.list()[0]!;
    expect(slot.kind).toBe('rule');
    expect(slot.priority).toBe(0);
    expect(slot.status).toBe('open');
    expect(slot.validUntil).toBeUndefined();
  });

  it('类型层由宿主 defineTool 先拦:非布尔 pinned 不会到达插件', async () => {
    const h = await harness({ mutate: true });
    // 边界事实:defineTool 按 parameters 做参数校验,类型不符的实参在插件 execute 之前即被拒。
    await expect(h.call('memory_slot_write', { title: 'X', pinned: 'true' })).rejects.toThrow(/pinned/);
    expect(h.store.count()).toBe(0);
  });
});
