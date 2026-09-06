import type { GraphEdge, GraphNode, GraphNodeSearchResult } from './types.js';
/** 字段权重(检索命中计分;名称最高、关系词最低)。 */
export declare const GRAPH_FIELD_WEIGHTS: {
    readonly name: 6;
    readonly aliases: 5;
    readonly tags: 5;
    readonly currentState: 4;
    readonly facts: 4;
    readonly relations: 3;
    readonly type: 2;
};
/**
 * 图谱节点检索:返回按 score 降序的命中(最多 limit 条;limit 钳制 1~20)。
 * 候选节点 = active | disputed(superseded/archived 不进检索)。
 */
export declare function searchGraphNodes(nodes: readonly GraphNode[], edges: readonly GraphEdge[], query: string, limit: number): GraphNodeSearchResult[];
