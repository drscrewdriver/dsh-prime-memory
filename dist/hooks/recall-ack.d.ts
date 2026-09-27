/**
 * §D 注入确认——日志回执协议(memorax-absorb Wave 3 / task_20-22)。
 *
 * 问题:`dedupe.mark` 原在 pre-step 返回注入的瞬间执行,但宿主是否真的把该
 * 注入消息收进会话历史,此时并未确认(pre-step 被其他插件覆盖/步骤取消时,
 * 模型根本没看到)——误标记会把这些记忆压制整个会话。
 *
 * 协议(两段式):
 *  ① recall.ts 构造注入消息后只登记 pending(messageId → 记录 id 集),不标记;
 *  ② capture.ts 在 `session/event` 观察到该 `user/message` 真正入日志时确认,
 *     此时才 `dedupe.mark`(与 §D 红线一致:确认匹配在 source.kind 过滤之前——
 *     注入消息的 source.kind 是 `plugin:memory`,放过滤后永远到不了匹配)。
 *
 * 超时降级(task_22):pending 超 5 分钟未确认 → 照旧标记 + 一次性提示。
 * 防确认链路自身故障导致 dedupe 永不生效、记忆每轮重注的回归;正常确认时延
 * <2s(同进程事件循环)。未确认且未超时的 pending 过期即弃(不标记)——
 * 模型没看到的东西不应被抑制,允许下轮重注。
 *
 * 进程内 volatile,容量 64 条 LRU(注入速率低,正常情况秒级确认,积压即异常)。
 */
export interface PendingInjection {
    agentId: string;
    messageId: string;
    recordIds: string[];
    at: number;
}
/** 确认后执行的实际标记动作(recall.ts 注入 = dedupe.mark 的绑定)。 */
type InjectionMarker = (agentId: string, recordIds: string[]) => void;
export declare const PENDING_TIMEOUT_MS: number;
/** recall.ts 注册实际标记动作(dedupe.mark 绑定);重复注册以最后一次为准。 */
export declare function setInjectionMarker(fn: InjectionMarker): void;
/** ① 登记待确认注入(超容量淘汰最旧——积压到 64 条说明确认链路已异常)。 */
export declare function registerPendingInjection(agentId: string, messageId: string, recordIds: string[], now?: number): void;
/**
 * ② 日志回执确认:该注入消息已真实进入会话历史。执行标记并移除 pending。
 * @returns 是否命中一条 pending(未命中 = 与本插件注入无关的事件,静默)。
 */
export declare function confirmInjectionByMessageId(messageId: string): boolean;
/**
 * 超时清扫:超时的 pending 照旧标记(降级保连续,防 dedupe 失效回归),并移除。
 * 未超时的不动。@returns 本次降级标记的条数(recall 侧据此前瞻性提示一次)。
 */
export declare function expirePendingInjections(now?: number, timeoutMs?: number): number;
/** 诊断/测试:当前 pending 条数。 */
export declare function pendingCount(): number;
/** 测试隔离:清空 pending 与 marker(模块级状态,用例间互扰)。 */
export declare function resetAckForTests(): void;
export {};
