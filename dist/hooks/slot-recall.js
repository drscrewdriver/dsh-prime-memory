import { createUserMessage } from '@deepseek-ai/dsh-llm';
export function registerSlotRecall(ctx, cfg, slots, logger, _live) {
    const buildInjection = () => {
        if (!cfg.slots.enabled || !cfg.slots.inject)
            return null;
        const { slots: picked, truncatedCount } = slots.alwaysOn(cfg.slots.maxAlwaysOnBytes);
        if (picked.length === 0)
            return null;
        const lines = picked.map((s) => {
            const head = `[${s.kind}] ${s.title}`;
            return s.body ? `${head}: ${s.body}` : head;
        });
        if (truncatedCount > 0) {
            lines.push(`… 另有 ${truncatedCount} 个常驻槽位因预算未显示,可用 memory_slot_list 查看`);
        }
        return '【激活槽位 · 常驻上下文】\n' + lines.join('\n');
    };
    ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision.kind === 'reject' || (payload.signal && payload.signal.aborted))
            return decision;
        if (!cfg.slots.enabled)
            return decision;
        try {
            // validUntil 机械清算(纯比较,不触发任何 LLM):每次注入前先过期到期条目,
            // 否则 `validUntil` 只是装饰——过期槽位会一直常驻注入。无到期条目时零写盘。
            await slots.expireDue();
            const text = buildInjection();
            if (!text)
                return decision;
            const injection = createUserMessage({
                content: [{ type: 'text', text }],
                // form 受宿主类型约束(仅 recall/snapshot/notice/...),槽位常驻注入沿用 'recall' 分组
                source: { kind: 'plugin', plugin: 'memory', form: 'recall' },
            });
            return { kind: 'enter', messages: [injection, ...decision.messages] };
        }
        catch (err) {
            logger.warn(`[memory] 槽位常驻注入失败(跳过本轮): ${err instanceof Error ? err.message : String(err)}`);
            return decision;
        }
    }, { prepend: true });
    return { buildInjection };
}
