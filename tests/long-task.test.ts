import { describe, expect, it } from 'vitest';
import { ContextUsageStore } from '../src/store/context-usage.js';
import { TodoRefStore, jaccard, renderTodoText, todoTokens } from '../src/store/todo-ref.js';
import {
  closeTodoRefSlot,
  upsertTodoRefSlot,
  TODO_REF_SLOT_TITLE,
  registerLongTaskMonitor,
} from '../src/hooks/long-task.js';
import type { MemoryConfig } from '../src/config.js';
import type { SessionModeStore } from '../src/store/session-modes.js';
import type { SlotStore } from '../src/store/slots.js';
import type { MemoryLogger } from '../src/types.js';

describe('context-usage store', () => {
  it('records latest input tokens and reports percent of window', () => {
    const u = new ContextUsageStore();
    u.record('s1', 50_000);
    u.record('s1', 70_000); // 最近值语义:覆盖而非累加
    expect(u.latestTokens('s1')).toBe(70_000);
    expect(u.percentOfWindow('s1', 200_000)).toBe(35);
    expect(u.percentOfWindow('s1', undefined)).toBeNull();
    expect(u.percentOfWindow('s-none', 200_000)).toBeNull();
  });

  it('rejects invalid samples and resets on compaction', () => {
    const u = new ContextUsageStore();
    u.record('s1', -5);
    u.record('s1', Number.NaN);
    expect(u.latestTokens('s1')).toBeUndefined();
    u.record('s1', 100);
    u.reset('s1');
    expect(u.latestTokens('s1')).toBeUndefined();
    u.reset('s1'); // 幂等
  });
});

describe('todo-ref store', () => {
  it('jaccard: identical sets = 1, disjoint = 0, empty∩empty = 1', () => {
    const a = todoTokens('修复登录 bug');
    const b = todoTokens('修复登录 bug');
    expect(jaccard(a, b)).toBe(1);
    expect(jaccard(todoTokens('abc'), todoTokens('xyz'))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('records drift: first snapshot drift=0, changed snapshot > 0, identical snapshot resets drift', () => {
    const t = new TodoRefStore();
    const e1 = t.record('s1', [{ content: '实现 A', status: 'in_progress' }]);
    expect(e1.drift).toBe(0);
    const e2 = t.record('s1', [{ content: '重构 B 模块并补测试', status: 'in_progress' }]);
    expect(e2.drift).toBeGreaterThan(0.5);
    expect(e2.prevText).toContain('实现 A');
    const e3 = t.record('s1', [{ content: '重构 B 模块并补测试', status: 'in_progress' }]);
    expect(e3.drift).toBe(0);
    expect(e3.prevText).toContain('实现 A'); // 相同快照不推进 prev 链
  });

  it('renders checklist with status markers', () => {
    const text = renderTodoText([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]);
    expect(text).toBe('- [x] a\n- [~] b\n- [ ] c');
  });
});

function makeDeps(over?: Partial<Parameters<typeof registerLongTaskMonitor>[1]>) {
  const handlers = new Map<string, (session: unknown, event: { type: string; data?: unknown }) => void>();
  const ctx = {
    on: (name: string, fn: (session: unknown, event: { type: string; data?: unknown }) => void) => {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
  };
  const slots = {
    list: () => slotList,
    refreshByTitle: async (title: string, patch: { body: string; pinned?: boolean }) => {
      const found = slotList.find((s) => s.title === title);
      if (found) {
        found.body = patch.body;
        return found;
      }
      const s = { id: `slot_${slotList.length + 1}`, title, body: patch.body, pinned: patch.pinned === true, status: 'open' as const };
      slotList.push(s);
      return s;
    },
    close: async (id: string) => {
      const found = slotList.find((s) => s.id === id);
      if (found) found.status = 'dropped' as const;
      return Boolean(found);
    },
  } as unknown as SlotStore;
  const slotList: Array<{ id: string; title: string; body: string; pinned: boolean; status: 'open' | 'dropped' }> = [];
  const modes = {
    getLongTask: (sid: string) => longTaskBySession.get(sid) ?? false,
  } as unknown as SessionModeStore;
  const longTaskBySession = new Map<string, boolean>([['s-lt', true]]);
  const cfg = {
    longTask: { enabled: true, contextThresholdPct: 70, driftThreshold: 0.6, tailTurns: 6, autoCompress: false },
  } as unknown as MemoryConfig;
  const logger: MemoryLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const base = {
    cfg,
    modes,
    slots,
    contextUsage: new ContextUsageStore(),
    todoRef: new TodoRefStore(),
    logger,
  };
  return { ctx, handlers, slotList, longTaskBySession, deps: { ...base, ...over } };
}

describe('long-task monitor', () => {
  it('records assistant usage and resets on compaction; disabled gate unregisters', () => {
    const { ctx, handlers, deps } = makeDeps();
    registerLongTaskMonitor(ctx as never, deps);
    const onEvent = handlers.get('session/event')!;
    onEvent({ id: 's1' }, { type: 'assistant/message', data: { usage: { inputTokens: 100_000, cacheReadTokens: 5_000 } } });
    expect(deps.contextUsage.latestTokens('s1')).toBe(105_000);
    onEvent({ id: 's1' }, { type: 'compaction/summary', data: {} });
    expect(deps.contextUsage.latestTokens('s1')).toBeUndefined();
  });

  it('todo/write only lands a slot in long-task mode; off-session ignored', async () => {
    const { ctx, handlers, deps, slotList } = makeDeps();
    registerLongTaskMonitor(ctx as never, deps);
    const onEvent = handlers.get('session/event')!;
    const todos = [{ content: '任务一', status: 'in_progress' }, { content: '任务二', status: 'pending' }];
    onEvent({ id: 's-off' }, { type: 'todo/write', data: { todos } });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(slotList).toHaveLength(0);
    onEvent({ id: 's-lt' }, { type: 'todo/write', data: { todos } });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(slotList).toHaveLength(1);
    expect(slotList[0].title).toBe(TODO_REF_SLOT_TITLE);
    expect(slotList[0].body).toContain('任务一');
    // 同快照再写:原地刷新,不新增
    onEvent({ id: 's-lt' }, { type: 'todo/write', data: { todos } });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(slotList).toHaveLength(1);
  });

  it('oversized todo body is truncated with an explicit marker', async () => {
    const { ctx, handlers, deps, slotList } = makeDeps();
    registerLongTaskMonitor(ctx as never, deps);
    const onEvent = handlers.get('session/event')!;
    const big = Array.from({ length: 60 }, (_, i) => ({ content: `任务 ${i}:描述文字较长用于撑爆预算`, status: 'pending' }));
    onEvent({ id: 's-lt' }, { type: 'todo/write', data: { todos: big } });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(slotList[0].body.length).toBeLessThan(600);
    expect(slotList[0].body).toContain('已截断');
  });

  it('upsert/close slot helpers and disabled-config no-op', async () => {
    const { deps, slotList } = makeDeps();
    await upsertTodoRefSlot(deps, '- [ ] x');
    expect(slotList).toHaveLength(1);
    expect(await closeTodoRefSlot(deps)).toBe(true);
    expect(slotList[0].status).toBe('dropped');
    expect(await closeTodoRefSlot(deps)).toBe(false);
    const off = makeDeps();
    off.deps.cfg.longTask.enabled = false;
    expect(registerLongTaskMonitor(off.ctx as never, off.deps)).toBeTypeOf("function");
    expect(off.handlers.size).toBe(0);
  });
});
