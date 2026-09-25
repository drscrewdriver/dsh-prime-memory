/**
 * 激活槽位常驻注入 Hook。
 *
 * 在 agent/pre-step(waterfall,prepend)把 pinned 且 open 的槽位注入到每轮对话
 * 上下文——这是根治"网络规则等显式约定不被召回"的核心验收点。与 recall.ts 独立
 * 注册、可组合:两段注入各自 prepend,顺序稳定(I5)。
 *
 * 门控:仅尊重 cfg.slots.enabled / cfg.slots.inject 两个静态开关(读/注入总开关),
 * 不引入会话档位门控——槽位是跨会话持久的系统级约定,与"本会话记忆隐身"正交。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { LiveSettingsHandle } from '../settings.js';
import type { SlotStore } from '../store/slots.js';
import type { MemoryLogger } from '../types.js';
export interface SlotRecallController {
    /** 生成常驻注入文本(null = 无注入);导出供单元测试与未来复用。 */
    buildInjection(): string | null;
}
export declare function registerSlotRecall(ctx: Context, cfg: MemoryConfig, slots: SlotStore, logger: MemoryLogger, _live: LiveSettingsHandle): SlotRecallController;
