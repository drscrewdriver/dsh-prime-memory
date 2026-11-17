import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { TurnInjectGate } from './turn-inject-gate.js';
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
/** 会话键:与 recall.ts 的 sessionKey 同源(agent.session?.id ?? agent.id)。 */
function sessionOf(agent) {
    return String(agent.session?.id ?? agent.id);
}
export function registerSlotRecall(ctx, cfg, slots, logger, _live) {
    /** per-turn 去重闸(本 hook 独享,不与 skill-recall 共享)。 */
    const gate = new TurnInjectGate();
    /** 组装注入文本;返回条数供调用方判断"空槽位回合不烧额度"。 */
    const pick = () => {
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
        return {
            text: [
                SYSTEM_REMINDER_OPEN,
                SLOTS_INTRO,
                escapeFrameBody(lines.join('\n')),
                SYSTEM_REMINDER_CLOSE,
            ].join('\n'),
            count: picked.length,
        };
    };
    const buildInjection = () => pick()?.text ?? null;
    // 压缩完成(无 error)→ 上下文已被摘要替换,模型手里没有那份槽位文本了:
    // 作废记账,允许同回合重注。判定与 recall.ts 的 PostCompactionTracker 同源。
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'compaction/end' || event.data?.error)
            return;
        const sid = String(session.id ?? session);
        if (gate.invalidateSession(sid) > 0) {
            logger.debug?.(`[memory] 压缩完成:作废槽位注入记账,同回合可重注(session=${sid})`);
        }
    });
    // 清空/压缩重建的 agent:记账整体复位(resume/startup 不重置——历史仍在,模型还持有)。
    ctx.on('agent/created', (payload) => {
        if (payload.source === 'compact' || payload.source === 'clear')
            gate.reset(payload.agent.id);
        return undefined;
    });
    ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision.kind === 'reject' || (payload.signal && payload.signal.aborted))
            return decision;
        if (!cfg.slots.enabled)
            return decision;
        try {
            // validUntil 机械清算(纯比较,不触发任何 LLM):每次注入前先过期到期条目,
            // 否则 `validUntil` 只是装饰——过期槽位会一直常驻注入。无到期条目时零写盘。
            // 注意:清算留在**每步**路径上(不是每回合),否则同回合内到期的槽位会因去重继续生效。
            await slots.expireDue();
            // 先判"有没有可注入内容",再扣额度:空槽位回合不该白烧掉本回合的注入机会。
            const hit = pick();
            if (!hit)
                return decision;
            if (!gate.claim(payload.agent.id, payload.turn, sessionOf(payload.agent)))
                return decision;
            const injection = createUserMessage({
                content: [{ type: 'text', text: hit.text }],
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
