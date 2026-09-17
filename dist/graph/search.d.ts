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
 * 图谱命中 → L1 记录 id 序列(§D 第 3 路 RRF 的输入;纯函数,无 I/O)。
 *
 * 图谱是**可重建派生投影**,节点/fact 的 `sourceRecordIds` 是它回链 L1 的唯一凭证
 * (types.ts:6-7)。此处把"节点排名"翻译成"L1 记录排名":
 *
 * - **保序**:按命中的 score 降序依次展开来源,先出现的记录 = 更高排名;
 * - **去重**:同一 L1 记录可能被多个节点/fact 引用,只占首次出现的位置
 *   (重复占位会凭空抬高该记录在 RRF 里的权重);
 * - **节点自身来源优先于其 fact 来源**:节点的 sourceRecordIds 是它的身份来源,
 *   而单个 fact 的来源可能引向与该查询无关的旁支记录;
 * - **只取 active fact**:superseded 是历史状态,不该把旧记录拉进当前检索结果;
 * - **不查库**:返回的 id 可能已被删除(墓碑边界),由调用方按"取不到的跳过"处理。
 */
export declare function graphHitRecordIds(hits: readonly GraphNodeSearchResult[]): string[];
/**
 * 图谱节点检索:返回按 score 降序的命中(最多 limit 条;limit 钳制 1~20)。
 * 候选节点 = active | disputed(superseded/archived 不进检索)。
 */
export declare function searchGraphNodes(nodes: readonly GraphNode[], edges: readonly GraphEdge[], query: string, limit: number): GraphNodeSearchResult[];
