/**
 * 激活槽位常驻注入单元测试(task_28 / task_29)。
 *
 * 走**真** cordis `Context` + `ctx.waterfall('agent/pre-step', …)`:注入点在
 * `agent/pre-step`(waterfall, prepend)是宿主契约的一部分,自造假 waterfall 会
 * 把"可组合性(I5)"测成自说自话。这里连 `prepend` 的站位顺序都按真实分发验证。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { registerSlotRecall } from '../src/hooks/slot-recall.js';
import { SlotStore } from '../src/store/slots.js';
import type { MemoryConfig } from '../src/config.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryLogger } from '../src/types.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-slots-recall-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as MemoryLogger;
const live = { supported: true, get: () => ({ recall: true }), update: async () => {} } as unknown as LiveSettingsHandle;

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

interface Decision {
  kind: string;
  messages: { content?: { type: string; text: string }[]; source?: { kind?: string; plugin?: string; form?: string } }[];
}

function makeCfg(slots: Partial<Record<'enabled' | 'inject' | 'maxAlwaysOnBytes' | 'maxSlots' | 'maxBodyChars', number | boolean>> = {}): MemoryConfig {
  return {
    slots: {
      enabled: true,
      inject: true,
      maxSlots: 8,
      maxAlwaysOnBytes: 2048,
      maxBodyChars: 512,
      ...slots,
    },
  } as unknown as MemoryConfig;
}

async function setup(cfg = makeCfg()) {
  const dataDir = join(await tmp(), `r-${Math.random().toString(36).slice(2)}`);
  const store = new SlotStore(SlotStore.pathFor(dataDir), noopLogger, {
    maxSlots: 8,
    maxBodyChars: 512,
    maxTitleChars: 60,
  });
  await store.load();
  const ctx = new Context();
  const controller = registerSlotRecall(ctx, cfg, store, noopLogger, live);
  const baseMessage = { content: [{ type: 'text', text: '用户问题' }] };
  const base: Decision = { kind: 'enter', messages: [baseMessage] };
  const run = async (signal?: AbortSignal): Promise<Decision> => {
    const payload = {
      agent: { id: 'sess-1' },
      messages: [baseMessage],
      turn: 1,
      step: 1,
      signal: signal ?? new AbortController().signal,
    };
    const events = ctx as unknown as {
      waterfall(name: string, payload: unknown, inner: () => Promise<Decision>): Promise<Decision>;
    };
    return events.waterfall('agent/pre-step', payload, async () => base);
  };
  return { store, ctx, controller, base, run };
}

function texts(decision: Decision): string {
  return decision.messages
    .flatMap((m) => m.content ?? [])
    .map((c) => c.text)
    .join('\n');
}

describe('常驻注入基本语义', () => {
  it('pinned && open 槽位进入注入文本,且注入消息带插件来源(F6)', async () => {
    const { store, run } = await setup();
    await store.upsert({ title: '网络规则', kind: 'rule', pinned: true, body: '上行官方,下行镜像', priority: 90 });
    const decision = await run();
    expect(decision.kind).toBe('enter');
    expect(texts(decision)).toContain('【激活槽位 · 常驻上下文】');
    expect(texts(decision)).toContain('[rule] 网络规则: 上行官方,下行镜像');
    expect(decision.messages[0]?.source).toEqual({ kind: 'plugin', plugin: 'memory', form: 'recall' });
    expect(texts(decision)).toContain('用户问题'); // 原消息仍在(先后语义:线索在前)
  });

  it('非 pinned 槽位不注入(F7)', async () => {
    const { store, run, base } = await setup();
    await store.upsert({ title: '只在清单里可见', pinned: false, body: 'x' });
    const decision = await run();
    expect(decision).toEqual(base);
  });

  it('空槽位/全关闭:零注入且返回同一引用(task_26)', async () => {
    const empty = await setup();
    const base = empty.base;
    expect(await empty.run()).toEqual(base);

    const off = await setup(makeCfg({ enabled: false }));
    await off.store.upsert({ title: 'A', pinned: true, body: 'x' });
    expect(await off.run()).toEqual(off.base);

    const noInject = await setup(makeCfg({ inject: false }));
    await noInject.store.upsert({ title: 'A', pinned: true, body: 'x' });
    expect(await noInject.run()).toEqual(noInject.base);
    expect(noInject.controller.buildInjection()).toBeNull();
  });

  it('reject 决策不被改写', async () => {
    const { ctx, store } = await setup();
    await store.upsert({ title: 'A', pinned: true, body: 'x' });
    const rejection: Decision = { kind: 'reject', messages: [] };
    const events = ctx as unknown as {
      waterfall(name: string, payload: unknown, inner: () => Promise<Decision>): Promise<Decision>;
    };
    const decision = await events.waterfall(
      'agent/pre-step',
      { agent: { id: 's' }, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      async () => rejection,
    );
    expect(decision).toBe(rejection);
  });

  it('已 abort 的 signal 不注入', async () => {
    const { store, run, base } = await setup();
    await store.upsert({ title: 'A', pinned: true, body: 'x' });
    const ac = new AbortController();
    ac.abort();
    expect(await run(ac.signal)).toEqual(base);
  });
});

describe('常驻字节预算与 +N more(I4)', () => {
  it('超预算只留高优先级,尾部标注未显示的条数', async () => {
    const { store, run } = await setup(makeCfg({ maxAlwaysOnBytes: 60 }));
    await store.upsert({ title: '高', priority: 90, pinned: true, body: 'A'.repeat(40) });
    await store.upsert({ title: '中', priority: 50, pinned: true, body: 'B'.repeat(40) });
    await store.upsert({ title: '低', priority: 10, pinned: true, body: 'C'.repeat(40) });
    const injected = texts(await run());
    expect(injected).toContain('[rule] 高');
    expect(injected).not.toContain('[rule] 中');
    expect(injected).not.toContain('[rule] 低');
    expect(injected).toMatch(/另有 2 个常驻槽位因预算未显示/);
    expect(injected).toContain('memory_slot_list'); // 给出找回路径,不静默丢弃
  });

  it('预算内不出现 +N more', async () => {
    const { store, run } = await setup();
    await store.upsert({ title: 'A', pinned: true, body: 'x' });
    expect(texts(await run())).not.toMatch(/另有/);
  });

  it('buildInjection 是纯读函数:不写盘、不改 rev', async () => {
    const { store, controller } = await setup();
    await store.upsert({ title: 'A', pinned: true, body: 'x' });
    const rev = store.revision();
    expect(controller.buildInjection()).toContain('[rule] A');
    expect(store.revision()).toBe(rev);
  });
});

describe('validUntil 机械过期接线(task_46)', () => {
  it('注入前清算到期槽位:不再注入且状态置 expired', async () => {
    const { store, run } = await setup();
    const expiring = await store.upsert({ title: '临时规则', pinned: true, body: 'x', validUntil: PAST });
    const alive = await store.upsert({ title: '长期规则', pinned: true, body: 'y', validUntil: FUTURE });
    const injected = texts(await run());
    expect(injected).toContain('[rule] 长期规则');
    expect(injected).not.toContain('临时规则');
    expect(store.list().find((s) => s.id === expiring.id)?.status).toBe('expired');
    expect(store.list().find((s) => s.id === alive.id)?.status).toBe('open');
  });

  it('enabled=false 时零副作用:不做过期清算', async () => {
    const { store, run } = await setup(makeCfg({ enabled: false }));
    const slot = await store.upsert({ title: '临时', pinned: true, body: 'x', validUntil: PAST });
    const rev = store.revision();
    await run();
    expect(store.list().find((s) => s.id === slot.id)?.status).toBe('open');
    expect(store.revision()).toBe(rev);
  });
});

describe('waterfall 可组合性(I5)', () => {
  /**
   * 模拟 recall.ts 的同款 prepend 监听器(先 next() 再改写)。
   *
   * 声明面用本地结构化类型:宿主 `PreStepDecision` 是 `enter | reject` 联合,照抄需要在
   * 测试里构造完整 `UserMessage`;这里只关心 messages 的拼接,故在 `ctx.on` 边界做一次
   * 显式收窄(下方 `as never`),不把宿主的联合类型摊进测试。
   */
  function registerRecallLike(ctx: Context): void {
    const listener = async (
      _payload: unknown,
      next: () => Promise<{ kind: string; messages?: Decision['messages'] }>,
    ): Promise<Decision> => {
      const decision = await next();
      if (decision.kind === 'reject') return { kind: 'enter', messages: [] };
      return {
        kind: 'enter',
        messages: [
          {
            content: [{ type: 'text', text: '<relevant-memories>召回段</relevant-memories>' }],
            source: { kind: 'plugin', plugin: 'memory', form: 'recall' },
          },
          ...(decision.messages ?? []),
        ],
      };
    };
    ctx.on('agent/pre-step', listener as never, { prepend: true });
  }

  it('两段注入都在,且顺序在多次运行间稳定', async () => {
    const { store, ctx, run } = await setup();
    await store.upsert({ title: '网络规则', pinned: true, body: 'x' });
    registerRecallLike(ctx);

    const first = await run();
    const second = await run();
    const order = (d: Decision) => d.messages.map((m) => (m.content?.[0]?.text ?? '').slice(0, 12));
    expect(order(first)).toEqual(order(second)); // 顺序稳定
    expect(texts(first)).toContain('召回段');
    expect(texts(first)).toContain('[rule] 网络规则');
    expect(texts(first)).toContain('用户问题');
    expect(first.messages).toHaveLength(3);
  });
});
