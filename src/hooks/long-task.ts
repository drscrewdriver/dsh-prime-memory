import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { ContextUsageStore } from '../store/context-usage.js';
import type { SlotStore } from '../store/slots.js';
import type { TodoRefStore, TodoItemSnapshot } from '../store/todo-ref.js';
import type { SessionModeStore } from '../store/session-modes.js';
import type { MemoryLogger } from '../types.js';

/** todo 参考槽位的受管标题(精确匹配;refreshByTitle 按它原地刷新)。 */
export const TODO_REF_SLOT_TITLE = '长任务 · 任务参考(todo)';

export interface LongTaskMonitorDeps {
  cfg: MemoryConfig;
  modes: SessionModeStore;
  slots: SlotStore;
  contextUsage: ContextUsageStore;
  todoRef: TodoRefStore;
  logger: MemoryLogger;
}

/**
 * 长任务模式的事件监听(总开关 cfg.longTask.enabled 关闭时不注册):
 *  - assistant/message 的官方 usage 输入侧 → 上下文使用量(最近值语义);
 *  - compaction/summary → 上下文坍缩归零;
 *  - todo/write → 仅长任务模式下:记录快照 + 漂移检测,并把任务清单刷进
 *    pinned `todo` 槽位(slot-recall 常驻注入,压缩后任务北极星仍在)。
 *
 * fail-open 纪律:任何异常只 warn,绝不影响会话事件主流程。
 */
export function registerLongTaskMonitor(ctx: Context, deps: LongTaskMonitorDeps): () => void {
  if (!deps.cfg.longTask.enabled) return () => {};

  const off = ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      const sid = String((session as { id?: unknown }).id ?? session);
      if (event.type === 'assistant/message') {
        const usage = (event.data as { usage?: { inputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown } })
          .usage;
        if (usage && typeof usage === 'object') {
          const total =
            num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens);
          if (total > 0) deps.contextUsage.record(sid, total);
        }
        return;
      }
      if (event.type === 'compaction/summary') {
        // 压缩坍缩:上下文规模归零,建议阈值从新基数重新逼近。
        deps.contextUsage.reset(sid);
        return;
      }
      if (event.type === 'todo/write') {
        // todo 参考只在长任务模式可用(用户显式开启才消耗注入预算)。
        if (!deps.modes.getLongTask(sid)) return;
        const raw = (event.data as { todos?: unknown }).todos;
        if (!Array.isArray(raw)) return;
        const items: TodoItemSnapshot[] = [];
        for (const t of raw) {
          if (t === null || typeof t !== 'object') continue;
          const content = String((t as { content?: unknown }).content ?? '').trim();
          if (!content) continue;
          const status = String((t as { status?: unknown }).status ?? 'pending');
          items.push({ content, status });
        }
        if (items.length === 0) return;
        const entry = deps.todoRef.record(sid, items);
        void upsertTodoRefSlot(deps, entry.text).catch((err) =>
          deps.logger.warn(`[memory] todo 参考槽位刷新失败(不影响事件流): ${msg(err)}`),
        );
      }
    } catch (err) {
      deps.logger.warn(`[memory] 长任务监听处理失败: ${msg(err)}`);
    }
  });
  return off;
}

/** 任务清单 → pinned todo 槽位(body ≤512,截断明示——截断不静默)。 */
export async function upsertTodoRefSlot(deps: LongTaskMonitorDeps, text: string): Promise<void> {
  const MAX = 512;
  let body = text;
  if (byteLen(text) > MAX) {
    let cut = text;
    while (cut.length > 0 && byteLen(cut) + byteLen('\n…(已截断,完整清单见 todo 面板)') > MAX) {
      cut = cut.slice(0, -1);
    }
    body = `${cut}\n…(已截断,完整清单见 todo 面板)`;
  }
  await deps.slots.refreshByTitle(TODO_REF_SLOT_TITLE, { body, pinned: true });
}

/** 关闭 todo 参考槽位(长任务关闭时撤下注入;无槽位 = 幂等 no-op)。 */
export async function closeTodoRefSlot(deps: LongTaskMonitorDeps): Promise<boolean> {
  const found = deps.slots
    .list()
    .find((s) => s.title === TODO_REF_SLOT_TITLE && s.status === 'open');
  if (!found) return false;
  await deps.slots.close(found.id, 'dropped');
  return true;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}
