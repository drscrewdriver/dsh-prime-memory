import type { TraceEvent } from '../contract.js';
export interface TraceStoreOptions {
    /** 保留天数;0 = 永久保留。 */
    retentionDays: number;
    /** 单文件字节上限(超过停写 + marker)。 */
    maxFileBytes?: number;
}
export declare class TraceStore {
    private readonly dataDir;
    private readonly opts;
    /** 已停写的日期(5MB 上限触发;当日内后续事件丢弃,次日自动恢复)。 */
    private readonly truncatedDays;
    private lastPruneDay;
    private chain;
    constructor(dataDir: string, opts: TraceStoreOptions);
    /** 追加事件(异步串行链,失败静默)。 */
    append(event: TraceEvent): void;
    /** 等待挂起的写入排空(dispose 序用)。 */
    flush(): Promise<void>;
    /**
     * 尾部读取:从最近的日期文件倒序收集,按 kind 过滤,返回至多 `lines` 条
     * (按写入顺序 = 时间升序)。坏行跳过(readJsonl 同款)。
     */
    tail(lines: number, kind?: TraceEvent['kind']): Promise<TraceEvent[]>;
    private dir;
    private fileFor;
    private recentFiles;
    private writeOne;
    /** 删除超过保留期的旧日文件(retentionDays 0 = 永久)。 */
    private pruneOldDays;
}
/** 插件启动时注入(index.ts 调用);enabled=false 或 0 天保留不影响初始化本身。 */
export declare function initTraceStore(dataDir: string, opts: TraceStoreOptions): void;
/** 测试/卸载:清空单例。 */
export declare function resetTraceStore(): void;
/** 埋点入口:未初始化 = no-op。fire-and-forget,永不抛。 */
export declare function trace(event: TraceEvent): void;
/** RPC tail 数据源;未初始化返回 undefined(端点回空集)。 */
export declare function getTraceStore(): TraceStore | null;
