import type { L1ExtSyncHook } from '../store/l1.js';
import type { MemoryLogger, MemoryRecord } from '../types.js';
import type { ExtSyncStore } from './schema.js';
import type { ExtDriverRegistry } from './registry.js';
import type { ExtSpace } from './types.js';
export interface ExtPusherConfig {
    /** 双闸一:外部记忆总装闸(cfg.extMemory.enabled)。 */
    masterEnabled: boolean;
    /** 双闸二:推送引擎自身闸(cfg.extMemory.push.enabled)。 */
    enabled: boolean;
    syncMode: 'shadow-read' | 'push-only' | 'two-way';
    /** add 推送的族白名单(小写集合;空集 = 全推)。 */
    families: Set<string>;
    maxItems: number;
    timeBudgetMs: number;
    settleTimeoutMs: number;
    maxAttempts: number;
    backoffMs: number[];
    allowHardDelete: boolean;
    settleScanLimit: number;
}
export interface ExtPusherDeps {
    registry: ExtDriverRegistry;
    spacesOf: (driverId: string) => ExtSpace[];
    ext: ExtSyncStore;
    l1: {
        getByIds(ids: string[]): MemoryRecord[];
    };
    cfg: () => ExtPusherConfig;
    /** 请求尽快跑一轮泵(index 侧实现:runner.enqueueExtSyncTask + 单飞占位)。 */
    wake: () => void;
    logger?: MemoryLogger;
    now?: () => number;
}
export interface PushBatchStats {
    processed: number;
    done: number;
    skipped: number;
    settled: number;
    orphans: number;
    failed: number;
    dead: number;
    gated: number;
}
/** 影子行的稳定主键:三元组的 sha 前缀——同一 (driver,space,record) 恒等,
 *  upsert 走冲突更新不裂变。**不用分隔符拼原文**:嵌入式 NUL/长路径在
 *  sqlite 绑定的字符串处理上有截断前科,纯 hex 键没有这个形状问题。 */
export declare function shadowIdFor(driverId: string, spaceId: string, recordId: string): string;
export interface ExtPusher {
    hook: L1ExtSyncHook;
    runBatch: () => Promise<PushBatchStats>;
}
export declare function makeExtPusher(deps: ExtPusherDeps): ExtPusher;
