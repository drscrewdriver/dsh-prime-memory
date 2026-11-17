/**
 * 每回合一次(per-turn)注入闸 —— issue #35。
 *
 * 宿主 `agent/pre-step` 是**按 step** 触发的(`agent-loop/src/agent.ts` 的
 * `preStep()` 在 `turn()` 的 step 循环体内),而常驻注入的语义是"本轮上下文里
 * 有一份就够"。不去重的后果:一个回合 n 步就注入 n 份完全相同的规则文本
 * (实测 66 步 = 66 × 1019 字符),规则被切成碎片夹在工具结果与推理之间 ——
 * 既稀释权重,又污染"上下文里出现过几次"这类推理。
 *
 * 键 = agentId + turn。**不是**全局单例:slot-recall 与 skill-recall 各持一份,
 * 否则一段注入会把另一段在同回合里挡掉。
 *
 * 纯内存状态(回合内语义,进程重启即新回合),零 import,便于单测。
 */
export class TurnInjectGate {
    cap;
    /** agentId → 最后一次放行的回合记账(置尾刷新,淘汰顺序对应最近活跃)。 */
    seen = new Map();
    constructor(cap = 512) {
        this.cap = Math.max(1, cap);
    }
    /**
     * 申请本回合的注入额度。
     * @returns `true` = 本回合首次,应当注入;`false` = 本回合已注入过。
     *
     * `turn` 非有限数(旧宿主/异常 payload)时**放行**:拿不到回合边界就不做去重,
     * 退化到修复前行为 —— 静默不注入才是真回归。
     */
    claim(agentId, turn, sessionKey) {
        if (!Number.isFinite(turn))
            return true;
        const last = this.seen.get(agentId);
        if (last !== undefined && last.turn === turn)
            return false;
        this.seen.delete(agentId);
        this.seen.set(agentId, { turn, sessionKey });
        while (this.seen.size > this.cap) {
            const oldest = this.seen.keys().next().value;
            if (oldest === undefined)
                break;
            this.seen.delete(oldest);
        }
        return true;
    }
    /**
     * 该会话的上下文被压缩/清空:作废名下所有 agent 的记账。
     *
     * 压缩把旧上下文逐出后,模型手里已经没有那份槽位文本了 —— 同回合必须允许重注,
     * 否则去重会把"氧气"也一并断掉。返回作废条数(0 = 无人在册,调用方可跳过日志)。
     */
    invalidateSession(sessionKey) {
        let n = 0;
        for (const [agentId, hit] of this.seen) {
            if (hit.sessionKey === sessionKey) {
                this.seen.delete(agentId);
                n++;
            }
        }
        return n;
    }
    /** 单 agent 记账复位(agent 重建/清空时用)。 */
    reset(agentId) {
        this.seen.delete(agentId);
    }
    get size() {
        return this.seen.size;
    }
}
