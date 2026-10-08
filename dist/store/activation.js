/** flush 间隔(ms);先到者触发(与 50 次阈值竞速)。 */
export const ACTIVATION_FLUSH_INTERVAL_MS = 30_000;
/** 待聚合条数阈值:达到即立刻 flush(不等间隔)。 */
export const ACTIVATION_FLUSH_BATCH = 50;
export class ActivationTracker {
    db;
    logger;
    pending = new Map();
    timer = null;
    opsSinceFlush = 0;
    disposed = false;
    constructor(db, logger, opts = {}) {
        this.db = db;
        this.logger = logger;
        this.intervalMs = opts.intervalMs ?? ACTIVATION_FLUSH_INTERVAL_MS;
        this.batchThreshold = opts.batchThreshold ?? ACTIVATION_FLUSH_BATCH;
    }
    intervalMs;
    batchThreshold;
    /**
     * 计一次激活(注入或采用)。纯内存操作,零 I/O;**绝不抛**——
     * 激活信号有损,丢弃一两次计数无害,阻塞召回才是灾难。
     */
    bump(id, kind, anchorAt) {
        if (this.disposed || !id)
            return;
        try {
            const cur = this.pending.get(id) ?? { injection: 0, adopted: 0 };
            if (kind === 'injection')
                cur.injection += 1;
            else
                cur.adopted += 1;
            // 采用语义:重置衰减锚点(O-2"这条有用"=记忆刚刚证明了自己)
            if (kind === 'adoption' || anchorAt)
                cur.anchorAt = anchorAt ?? new Date().toISOString();
            this.pending.set(id, cur);
            this.opsSinceFlush++;
            if (this.opsSinceFlush >= this.batchThreshold)
                this.flush();
            else
                this.scheduleFlush();
        }
        catch (err) {
            this.logger?.warn?.(`[memory][activation] 聚合失败(忽略): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    scheduleFlush() {
        if (this.timer || this.disposed)
            return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, this.intervalMs);
        // 不阻止进程退出(退出兜底靠 dispose;定时器只是节流,不该吊住生命周期)
        this.timer.unref?.();
    }
    /** 把聚合增量刷进 l1_activation(原子自增;失败静默——可丢观测)。返回刷掉条数。 */
    flush() {
        if (this.disposed || this.pending.size === 0)
            return 0;
        const batch = [...this.pending.entries()];
        this.pending.clear();
        this.opsSinceFlush = 0;
        let n = 0;
        for (const [id, d] of batch) {
            this.db.bumpActivation(id, {
                injection: d.injection,
                adopted: d.adopted,
                ...(d.anchorAt ? { anchorAt: d.anchorAt } : {}),
            });
            n++;
        }
        return n;
    }
    /** 退出钩子兜底:清定时器 + 强制刷盘。之后 bump 变 no-op(进程要退了)。 */
    dispose() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.flush();
        this.disposed = true;
    }
    /** 当前待刷条数(测试/诊断用)。 */
    get pendingCount() {
        return this.pending.size;
    }
}
/** 激活锚点解析(T2.5):decayAnchorAt ?? updatedAt;'' 归一为 updatedAt(P1-12 缺省不按最老)。 */
export function activationAnchorAtMs(act, updatedAt) {
    if (act?.decayAnchorAt) {
        const t = Date.parse(act.decayAnchorAt);
        if (Number.isFinite(t))
            return t;
    }
    return updatedAt;
}
