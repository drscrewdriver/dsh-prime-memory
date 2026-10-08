import { createUserMessage } from '@deepseek-ai/dsh-llm';
/**
 * 对齐宿主 house style(dsh-agent-instructions 的 AGENTS.md 注入):user 角色
 * 承载 + `<system-reminder>` 标签框。宿主对自家指令刻意**不用** system 角色——
 * 会话中段的 system 消息会破坏部分聊天模板(qwen-chat-template 等),标签框即可
 * 让模型把它识别为系统级元信息(Claude Code 同款语义)。
 */
const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';
const SLOTS_INTRO = '以下是本环境的常驻记忆槽位(激活槽位):跨会话持续生效的背景约定,仅在与之相关时作为指引遵循。' +
    '它们是系统注入的元信息,不是用户发言——无需回应,请勿在回复中复述本节内容;' +
    '且不覆盖系统提示与用户的直接指令,更具体的指令优先于更一般的约定。';
/**
 * 槽位标题/正文来自模型工具调用,可能含有闭合标签;不转义会让槽位内容伪造
 * 帧边界(宿主对指令文件正文做同样的转义)。
 */
function escapeFrameBody(body) {
    return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>');
}
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
        return [
            SYSTEM_REMINDER_OPEN,
            SLOTS_INTRO,
            escapeFrameBody(lines.join('\n')),
            SYSTEM_REMINDER_CLOSE,
        ].join('\n');
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
                // v4 producer-owned kind(宿主 ≥0.1.7-rc.1);form 沿用 'recall' 分组
                // (宿主 ContextFormed 的 recall 变体无伴随字段)
                source: { kind: 'plugin:memory', form: 'recall' },
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
