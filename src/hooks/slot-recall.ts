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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { MemoryConfig } from '../config.js';
import type { LiveSettingsHandle } from '../settings.js';
import type { SlotStore } from '../store/slots.js';
import type { MemoryLogger } from '../types.js';

export interface SlotRecallController {
  /** 生成常驻注入文本(null = 无注入);导出供单元测试与未来复用。 */
  buildInjection(): string | null;
}

export function registerSlotRecall(
  ctx: Context,
  cfg: MemoryConfig,
  slots: SlotStore,
  logger: MemoryLogger,
  _live: LiveSettingsHandle,
): SlotRecallController {
  const buildInjection = (): string | null => {
    if (!cfg.slots.enabled || !cfg.slots.inject) return null;
    const { slots: picked, truncatedCount } = slots.alwaysOn(cfg.slots.maxAlwaysOnBytes);
    if (picked.length === 0) return null;
    const lines = picked.map((s) => {
      const head = `[${s.kind}] ${s.title}`;
      return s.body ? `${head}: ${s.body}` : head;
    });
    if (truncatedCount > 0) {
      lines.push(`… 另有 ${truncatedCount} 个常驻槽位因预算未显示,可用 memory_slot_list 查看`);
    }
    return '【激活槽位 · 常驻上下文】\n' + lines.join('\n');
  };

  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || (payload.signal && payload.signal.aborted)) return decision;
      if (!cfg.slots.enabled) return decision;
      try {
        // validUntil 机械清算(纯比较,不触发任何 LLM):每次注入前先过期到期条目,
        // 否则 `validUntil` 只是装饰——过期槽位会一直常驻注入。无到期条目时零写盘。
        await slots.expireDue();
        const text = buildInjection();
        if (!text) return decision;
        const injection = createUserMessage({
          content: [{ type: 'text', text }],
          // form 受宿主类型约束(仅 recall/snapshot/notice/...),槽位常驻注入沿用 'recall' 分组
          source: { kind: 'plugin', plugin: 'memory', form: 'recall' },
        });
        return { kind: 'enter', messages: [injection, ...decision.messages] };
      } catch (err) {
        logger.warn(`[memory] 槽位常驻注入失败(跳过本轮): ${err instanceof Error ? err.message : String(err)}`);
        return decision;
      }
    },
    { prepend: true },
  );

  return { buildInjection };
}
