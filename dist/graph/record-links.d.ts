import type { GraphEdge, GraphNode, GraphNodeType } from './types.js';
/** 关联跳转的缺省条数上限(邻居与回落记录各吃一份)。 */
export declare const RECORD_LINKS_LIMIT_DEFAULT = 60;
/** 条数硬钳制上界(与 list-records 的单页上限同量级,再大没有可读性)。 */
export declare const RECORD_LINKS_LIMIT_MAX = 200;
/** 跳数上界:2 跳足够看清"经由谁连到谁";3 跳在百级图上是全图,在千级图上是噪声。 */
export declare const RECORD_LINKS_HOPS_MAX = 2;
/**
 * 每个实体/邻居随带的来源记录预览条数(保最新)。
 *
 * 没有它,第三层「点邻居 → 跳到那条记录」就断了:面板拿到邻居 id 却不知道它
 * 的来源是谁,只能再发一次 graph-node-get。截 5 条是为了不把整条来源链(上限 128)
 * 塞进一个列表项。
 */
export declare const RECORD_LINKS_SOURCE_PREVIEW = 5;
export interface RecordLinkEntity {
    id: string;
    name: string;
    type: GraphNodeType;
    /** active 边双向计数(与 preview.degreeMaps 同口径)。 */
    degree: number;
    causalDegree: number;
    /** 来源记录预览(保最新、≤RECORD_LINKS_SOURCE_PREVIEW;起点自身已排除)。 */
    recordIds: string[];
}
export interface RecordLinkNeighbor {
    id: string;
    name: string;
    type: GraphNodeType;
    /** 该条边的关系词(平行多边各占一条,不合并——合并就丢关系)。 */
    relation: string;
    causal: boolean;
    /** 经由哪个上游节点连出(多层展开时形成"起点 → via → 邻居"的可回溯链)。 */
    viaEntityId: string;
    degree: number;
    /** 本邻居是第几跳(1 = 实体的直接邻居)。 */
    hop: number;
    /** 邻居的来源记录预览(保最新、≤RECORD_LINKS_SOURCE_PREVIEW)——第三层跳转的落点。 */
    recordIds: string[];
}
export interface RecordLinksResult {
    /** 层2:起点记录作为来源的实体节点(degree 降序)。 */
    entities: RecordLinkEntity[];
    /** 层3:实体邻居(因果优先 → degree 降 → updatedAt 新 → id 升)。 */
    neighbors: RecordLinkNeighbor[];
    /** 回落记录的 id 集(已去重、已排除起点自身、按"来源节点排名"顺序、≤limit)。 */
    neighborRecordIds: string[];
    /** 邻居或回落记录任一维触顶。 */
    truncated: boolean;
}
export interface RecordLinksOpts {
    /** 1..RECORD_LINKS_HOPS_MAX,缺省 1。 */
    hops?: number;
    /** 1..RECORD_LINKS_LIMIT_MAX,缺省 RECORD_LINKS_LIMIT_DEFAULT。 */
    limit?: number;
}
/**
 * 主函数。`recordId` 命中零个实体时返回全空结构(不抛)——这条记录还没被投影进图
 * (图谱默认关闭 / 投影未跑到 / 该记录无可抽实体),都是正常态而非错误态。
 */
export declare function buildRecordLinks(nodes: readonly GraphNode[], edges: readonly GraphEdge[], recordId: string, opts?: RecordLinksOpts): RecordLinksResult;
