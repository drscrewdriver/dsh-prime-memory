import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { ContextUsageStore } from '../store/context-usage.js';
import type { SlotStore } from '../store/slots.js';
import type { TodoRefStore } from '../store/todo-ref.js';
import type { SessionModeStore } from '../store/session-modes.js';
import type { MemoryLogger } from '../types.js';
/** todo 参考槽位的受管标题(精确匹配;refreshByTitle 按它原地刷新)。 */
export declare const TODO_REF_SLOT_TITLE = "\u957F\u4EFB\u52A1 \u00B7 \u4EFB\u52A1\u53C2\u8003(todo)";
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
export declare function registerLongTaskMonitor(ctx: Context, deps: LongTaskMonitorDeps): () => void;
/** 任务清单 → pinned todo 槽位(body ≤512,截断明示——截断不静默)。 */
export declare function upsertTodoRefSlot(deps: LongTaskMonitorDeps, text: string): Promise<void>;
/** 关闭 todo 参考槽位(长任务关闭时撤下注入;无槽位 = 幂等 no-op)。 */
export declare function closeTodoRefSlot(deps: LongTaskMonitorDeps): Promise<boolean>;
