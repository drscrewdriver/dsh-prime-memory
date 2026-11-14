/**
 * 外部图融合(计划 T3.6):capabilities.graph 的三家(hindsight / holographic /
 * mnemon-native)外部图数据参与本地图谱投影。
 *
 * ## 为什么是"投影提示"而不是"落库合并"
 * 本地 graph store 是**事实库**:节点带 confidence/来源记录/族,graphLane 的
 * 检索分直接吃它。把外部节点写进去会让"外部数据主权"和"零漂移判据"同时破功
 * (外部节点没有本地来源记录,无法回溯、无法族隔离、外部删除后本地成幽灵)。
 *
 * 所以选**上下文注入**:外部图的节点/关系作为关系线索拼进投影 prompt——LLM
 * 据此对本地记录建立更准的边/别名,产物仍是**本地来源驱动**的图。外部图离线
 * 或缺席时投影行为逐字不变(注入为空 = 无后缀)。
 *
 * ## 缓存
 * 外部图变化慢而投影 job 密集;60s 缓存 + 单驱动失败跳过(图只是锦上添花,
 * 不能因为某家图接口抖动让整轮投影失败——fail-open 到无提示)。
 */
import type { MemoryLogger } from '../types.js';
import type { ExtDriverRegistry } from './registry.js';
import type { ExtSpace } from './types.js';
export interface ExtGraphHintsConfig {
    /** 每驱动贡献的节点行上限(按度数截断,防 prompt 失控)。 */
    maxLinesPerDriver: number;
    timeoutMs: number;
    cacheMs: number;
}
export interface ExtGraphHintsDeps {
    registry: ExtDriverRegistry;
    spacesOf: (driverId: string) => ExtSpace[];
    cfg: () => ExtGraphHintsConfig;
    logger?: MemoryLogger;
    now?: () => number;
}
export interface ExtGraphHints {
    (): Promise<string[]>;
    /** 测试/诊断用:清缓存。 */
    invalidate(): void;
}
export declare function makeExtGraphHints(deps: ExtGraphHintsDeps): ExtGraphHints;
