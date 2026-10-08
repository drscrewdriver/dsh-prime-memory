import { type MemoryRecord } from '../types.js';
/** 治理权重上下文(调用方从 config + 会话 cwd 组装)。 */
export interface GovernanceContext {
    /** 总开关(recall.scopeFence.enabled;W2/W3 扩展各自的开关)。false → 原样返回。 */
    enabled: boolean;
    /** 当前会话的 repoKey(basename(归一 cwd);'' = 无法识别 → 不围栏)。 */
    currentRepoKey: string;
    /** repo 不匹配乘子(recall.scopeFence.crossRepoMultiplier,默认 0.2)。 */
    crossRepoMultiplier: number;
    /** tier 检索降权开关(governance.tier.enabled,治理 W3;默认 false = tier 不参与)。 */
    tierEnabled?: boolean;
}
/** 单条命中治理后的合成权重(排序键;score 不改写)。治理关闭恒 1。 */
export declare function governanceWeightOf(rec: MemoryRecord | undefined, ctx: GovernanceContext): number;
/**
 * 对召回出口的 hits 施加治理权重:**只重排,不改写 score、不过滤、不扩集**。
 * `recordsById` 由调用方用一次批量点查组装(命中量 ≤ limit,微秒级);
 * 排序稳定:同权重保持原相对顺序(比较仅在不等时返回,Array.prototype.sort
 * 在现代 V8 为稳定排序)。
 */
export declare function applyGovernanceWeights<T extends {
    id: string;
    score: number;
}>(hits: T[], recordsById: ReadonlyMap<string, MemoryRecord>, ctx: GovernanceContext): T[];
/**
 * 四象限守卫的真值表(P0-7):work×global 任何 repo 下不减权。
 * 导出供测试直接引用,保证实现与文档同一处表达。
 */
export declare const SCOPE_FENCE_QUADRANTS: ReadonlyArray<{
    family: 'chat' | 'work';
    repoKeyName: string;
    applicability: string;
    currentRepoKey: string;
    expected: 1 | 'crossRepo';
}>;
/** tier 乘子(W3 启用;W1 先落常量表,tier.enabled=false 时调用方不走到这里)。 */
export declare const TIER_MULTIPLIER: Readonly<Record<'active' | 'wiki', number>>;
export declare function tierMultiplierOf(rec: MemoryRecord | undefined): number;
