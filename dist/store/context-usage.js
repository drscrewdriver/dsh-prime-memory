/**
 * 会话上下文使用量(长任务模式 §上下文估计)。
 *
 * 数据源:assistant/message 官方 usage 的输入侧(inputTokens + cache 读/写)——
 * 最新一条 assistant 消息的输入侧 ≈ 该时刻的上下文规模,取"最近值"而非累加
 * (每轮输入侧已含全部历史)。compaction/summary 后上下文坍缩,归零重计。
 *
 * 纯内存 per-session Map(热路径,session/event 每事件触达;不落盘——
 * 重启后首条 assistant 消息即可重建,丢失窗口无建议价值)。
 */
export class ContextUsageStore {
    logger;
    latest = new Map();
    /** 上一次归零时间(compaction 诊断透出;可省)。 */
    compactedAt = new Map();
    constructor(logger) {
        this.logger = logger;
    }
    /** 记录最近一次官方输入侧 token 数(只增语义由调用方保证传"最新一轮")。 */
    record(sessionId, inputTokens) {
        if (!Number.isFinite(inputTokens) || inputTokens < 0)
            return;
        this.latest.set(sessionId, Math.round(inputTokens));
    }
    /** 压缩坍缩:归零并记录时刻。 */
    reset(sessionId) {
        if (this.latest.delete(sessionId))
            this.compactedAt.set(sessionId, Date.now());
    }
    /** 最近输入侧 token 数(无样本 = undefined)。 */
    latestTokens(sessionId) {
        return this.latest.get(sessionId);
    }
    /** 上下文占窗口百分比(窗口未知或无样本 = null)。 */
    percentOfWindow(sessionId, contextWindowTokens) {
        const used = this.latest.get(sessionId);
        if (used === undefined || !Number.isFinite(contextWindowTokens) || (contextWindowTokens ?? 0) <= 0) {
            return null;
        }
        return Math.min(100, Math.round((used / contextWindowTokens) * 100));
    }
    /** 测试与停机清理。 */
    clear() {
        this.latest.clear();
        this.compactedAt.clear();
    }
}
