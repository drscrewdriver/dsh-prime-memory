/**
 * 激活计数内存聚合层(治理 W2,T2.2/P0-3 写放大护栏)。
 *
 * 三层架构(全有先例,计划 B 视角):
 * ① 内存聚合 `Map<recordId, Δ>`(学 recallStats 的零文件 I/O 注册表);
 * ② 节流批量 flush(30s / 50 次先到;**不开事务**学 recordReceipts——激活计数是
 *    **可丢观测数据**,部分写入无害,崩溃丢未刷盘增量与注入确认信号本身的有损性
 *    同级,P1-9/ADR-0017);
 * ③ 退出钩子兜底(dispose:清定时器 + 强制 flush)。
 *
 * **绝不走 worker**(memory-backend IPC 税禁令);node:sqlite 同步 API,真正的
 * 约束是每写阻塞主循环——节流聚合把 N 次注入合并为 ≤1 次写。
 */
import type { ActivationCounts, MemoryDb } from './sqlite.js';
import type { MemoryLogger } from '../types.js';
/** flush 间隔(ms);先到者触发(与 50 次阈值竞速)。 */
export declare const ACTIVATION_FLUSH_INTERVAL_MS = 30000;
/** 待聚合条数阈值:达到即立刻 flush(不等间隔)。 */
export declare const ACTIVATION_FLUSH_BATCH = 50;
export declare class ActivationTracker {
    private readonly db;
    private readonly logger?;
    private pending;
    private timer;
    private opsSinceFlush;
    private disposed;
    constructor(db: MemoryDb, logger?: MemoryLogger | undefined, opts?: {
        intervalMs?: number;
        batchThreshold?: number;
    });
    private readonly intervalMs;
    private readonly batchThreshold;
    /**
     * 计一次激活(注入或采用)。纯内存操作,零 I/O;**绝不抛**——
     * 激活信号有损,丢弃一两次计数无害,阻塞召回才是灾难。
     */
    bump(id: string, kind: 'injection' | 'adoption', anchorAt?: string): void;
    private scheduleFlush;
    /** 把聚合增量刷进 l1_activation(原子自增;失败静默——可丢观测)。返回刷掉条数。 */
    flush(): number;
    /** 退出钩子兜底:清定时器 + 强制刷盘。之后 bump 变 no-op(进程要退了)。 */
    dispose(): void;
    /** 当前待刷条数(测试/诊断用)。 */
    get pendingCount(): number;
}
/** 激活锚点解析(T2.5):decayAnchorAt ?? updatedAt;'' 归一为 updatedAt(P1-12 缺省不按最老)。 */
export declare function activationAnchorAtMs(act: ActivationCounts | undefined, updatedAt: number): number;
