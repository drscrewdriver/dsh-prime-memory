import type { ExtLaneProvider } from '../store/l1.js';
import type { ExtDriverRegistry } from './registry.js';
import type { ExternalHit, ExtSpace } from './types.js';
import type { MemoryLogger } from '../types.js';
export interface ExtLaneConfig {
    /** 单驱动在一次融合里的最大贡献条数(config lane.maxItemsPerDriver)。 */
    maxItemsPerDriver: number;
    /** 单驱动请求超时(ms)。 */
    requestTimeoutMs: number;
    /** 路内容硬截(防超大外部正文挤爆注入预算;applyRecallBudget 之前的第一刀)。 */
    maxContentChars: number;
    /** 连续失败到该值开熔断。 */
    failureThreshold: number;
    /** 熔断开路时长(ms)。 */
    openMs: number;
}
export interface ExtLaneDeps {
    registry: ExtDriverRegistry;
    /** 每驱动参与检索的空间集(装配时定;Phase 1 一驱动一空间)。 */
    spacesOf: (driverId: string) => ExtSpace[];
    cfg: () => ExtLaneConfig;
    logger?: MemoryLogger;
    now?: () => number;
}
/** 驱动在 lane 视角的即时状态(面板/探针共用;不导出内部 Map)。 */
export interface ExtLaneStatus {
    driverId: string;
    enabled: boolean;
    circuit: 'closed' | 'open';
    failStreak: number;
    openedUntil: number;
    lastError: string;
}
/** 跨驱动 rank 交错:每家第 i 名依次入列(按 driverId 定序,确定性可复现)。 */
export declare function interleaveByRank(groups: Array<{
    driverId: string;
    hits: ExternalHit[];
}>): Array<{
    driverId: string;
    hit: ExternalHit;
}>;
export interface ExtLane {
    provider: ExtLaneProvider;
    statusOf(): ExtLaneStatus[];
    /** 记一次成功(探针路径共用熔段位;lane 内调用,外部面板探活成功也回灌这里)。 */
    noteSuccess(driverId: string): void;
    noteFailure(driverId: string, message: string): void;
}
export declare function makeExtLane(deps: ExtLaneDeps): ExtLane;
