import type { MemoryLogger, MemoryRecord } from '../types.js';
import type { ExtSyncStore } from './schema.js';
import type { ExtDriverRegistry } from './registry.js';
import type { ExtSpace } from './types.js';
export interface ExtPullConfig {
    masterEnabled: boolean;
    enabled: boolean;
    syncMode: 'shadow-read' | 'push-only' | 'two-way';
    maxItems: number;
    timeBudgetMs: number;
    /** 回灌族白名单(小写集合;空集 = 全拉)。与 push.families 分开:推什么和收什么是两件事。 */
    families: Set<string>;
}
/**
 * 首次全量导入入参（计划 ext-to-l1-import）。
 *
 * 护栏三项缺一不可：`maxItems` 与 `timeBudgetMs` 限住嵌入成本（`appendNew` 逐条向量化，
 * 本地模型单条可达秒级、远程按次计费），`onPage` 的返回值供外部中断。
 */
export interface ExtImportOptions {
    driverId: string;
    /** 省略 = 该驱动全部空间。 */
    spaceId?: string;
    maxItems: number;
    timeBudgetMs: number;
    /** 起始断点（从 `ext_import` 读回；省略 = 0）。 */
    startOffset?: number;
    /** 每页入库后回调；返回 true 请求中止。实现方用它落断点与进度。 */
    onPage?: (p: {
        spaceId: string;
        offset: number;
        imported: number;
        skipped: number;
        hasMore: boolean;
    }) => boolean | void;
}
/** 导入结果。`truncation` 必须能区分五种收尾，不得把“没完”说成“完成”。 */
export interface ExtImportSummary {
    pulled: number;
    imported: number;
    skipped: number;
    conflicts: number;
    failed: number;
    offset: number;
    truncation: 'complete' | 'capped' | 'budget' | 'cancelled' | 'unsupported';
}
export interface ExtPullerDeps {
    registry: ExtDriverRegistry;
    spacesOf: (driverId: string) => ExtSpace[];
    ext: ExtSyncStore;
    l1: {
        findIdByExtKey(extKey: string): string | undefined;
        getByIds(ids: string[]): MemoryRecord[];
        appendNew(records: MemoryRecord[]): Promise<void>;
        reviseInPlace(record: MemoryRecord): Promise<void>;
    };
    /** 墓碑硬闸:内容是否落在本地退场台账里(命中=不复活,挂 unforgettable)。 */
    isTombstoned?: (contentNorm: string) => boolean;
    /** 批量前置(每轮一次):index 侧用它同步刷新墓碑集缓存(读文件是 async,判据要 sync)。 */
    beforeBatch?: () => Promise<void>;
    cfg: () => ExtPullConfig;
    logger?: MemoryLogger;
    now?: () => number;
}
export interface PullBatchStats {
    drivers: number;
    pulled: number;
    imported: number;
    refreshed: number;
    conflicts: number;
    skipped: number;
    failed: number;
    /** 该家本就没接入站面（无 list 且无游标）：不是故障，不能混进 failed。 */
    skippedUnsupported: number;
    /**
     * 取数完整性：`none` 全部到底；`capped` 有空间撞到 maxItems；`budget` 有空间撞到时间预算；
     * `partial` 两者同时出现。**未取完不能报成 none**——否则用户会以为已全量导入。
     */
    truncation: 'none' | 'capped' | 'budget' | 'partial';
}
export interface ExtPuller {
    runBatch: () => Promise<PullBatchStats>;
    /** 首次全量导入（不受入站闸门约束）；由 importer 编排任务与断点。 */
    importSpace: (opts: ExtImportOptions) => Promise<ExtImportSummary>;
}
export declare function makeExtPuller(deps: ExtPullerDeps): ExtPuller;
