/** 投影版本号:提示词/校验语义升级时 +1,旧版本 job 全部作废重投影。 */
export const GRAPH_PROJECTOR_VERSION = 1;
/** 单 job 认领的记录数上限(批内上下文规模可控)。 */
export const GRAPH_JOB_BATCH = 8;
/** 新蒸馏记录的投影优先级(存量补投影 ≤9999,永不倒挂)。 */
export const GRAPH_PRIORITY_NEW = 10000;
/** 存量补投影的优先级(启动/周期补齐;恒低于新蒸馏)。 */
export const GRAPH_PRIORITY_BACKFILL = 100;
/** 单 job 最大尝试次数:claim 时 +1,达到即转 dead(不再重试)。 */
export const GRAPH_JOB_MAX_ATTEMPTS = 3;
/** 失败指数退避基数:第 n 次失败后 nextAttemptAt = now + base × 2^(n-1)。 */
export const GRAPH_JOB_BACKOFF_BASE_MS = 60_000;
/** 单次检索返回上限的硬钳制(工具与 RPC 两侧共用同一钳制值)。 */
export const GRAPH_SEARCH_LIMIT_MAX = 20;
