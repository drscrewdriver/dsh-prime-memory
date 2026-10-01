import type { MemoryLogger } from '../types.js';
export declare const RECALL_USAGE_FILE_VERSION: 1;
export interface RecallUsageEntry {
    attempts: number;
    used: number;
    lastAttemptAt: number | null;
    lastUsedAt: number | null;
}
export interface RecallUsageSummary {
    /** 有统计的记忆条数。 */
    tracked: number;
    /** 尝试总次数(Σ attempts)。 */
    attempted: number;
    /** 使用总次数(Σ used)。 */
    used: number;
    /** 使用率(百分比整数;attempted=0 时 0)。 */
    rate: number;
}
export declare class RecallUsageStore {
    private readonly logger?;
    private readonly file;
    private entries;
    private loaded;
    private degraded;
    private degradedLogged;
    private writeTimer;
    private writeChain;
    constructor(dataDir: string, logger?: MemoryLogger | undefined);
    init(): Promise<void>;
    private ensureLoaded;
    /** 一轮召回:候选集 attempts++/lastAttemptAt=now;used 子集额外 used++/lastUsedAt=now
     *  (used 不在候选内 = 防御路径,同样算一次尝试——用了就是被尝试过)。 */
    recordAttempt(candidateIds: readonly string[], usedIds: readonly string[]): void;
    get(id: string): RecallUsageEntry | undefined;
    summary(): RecallUsageSummary;
    /** 立即落盘(去抖窗口内的兜底;测试/停机用)。 */
    flush(): Promise<void>;
    /** 同步等待在途写(测试用;无在途写时立即返回)。 */
    flushSync(): void;
    private prune;
    private schedulePersist;
    private persist;
}
