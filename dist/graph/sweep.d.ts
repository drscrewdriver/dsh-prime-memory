import type { GraphConcept, GraphNode } from './types.js';
/** 清扫明细计数(dryRun 与落库产出同一份报告,便于「先看再动」)。 */
export interface GraphSweepReport {
    /** 扫过的可见节点数(分母)。 */
    scanned: number;
    /** ① 归档的泛称裸角色节点数。 */
    bareRoleArchived: number;
    /** ② 改名的路径名 place 数。 */
    placeRenamed: number;
    /** ② 末段仍是路径(盘符/UNC 等无法安全取名)因而改不动的 place 数。 */
    placeUnrenamed: number;
    /** ③ 剔除的别名字符串总数(节点 + 概念)。 */
    aliasesPruned: number;
    /** ④ 同义归一写回的 fact 条数。 */
    factsRenamed: number;
    /** 带 `未规范` tag 的可见节点数(结果口径,含此前已有 tag 的)。 */
    nodesUncanon: number;
    /** ⑤ currentState 与重建结果不一致因而改写的节点数。 */
    statesRebuilt: number;
    /** 概念表归一后同 (名字, 分类) 的重复行数(>0 只提示,不自动合并)。 */
    conceptDups: number;
    /** ① 被归档节点的 id(供 store 层删向量行)。 */
    archivedIds: string[];
    /**
     * ① 随归档退场可见面的 fact 条数(仅 active/disputed 行)。放在报告里是**故意**的:
     * 泛称裸角色里混着 `用户`/`AI` 这种「偏好汇聚枢纽」——指标要 0 很容易,代价是把
     * 最有内容的那两个节点从画布/检索里摘掉。入口必须自己把这笔账摊开给人看,
     * 而不是让 bareRole=0 一个好数字把它盖过去。
     */
    archivedFacts: number;
    /**
     * ① 改为**限定名**而保留可见的泛称枢纽数(`用户` → `用户@work`)。阈值见 HUB_FACTS:
     * 承载活跃 fact 过多的节点不是杂散泛称,而是偏好汇聚点——归档它等于把 158 条
     * fact 请出图谱,只为让 bareRole 变绿。R4 给的正面解法是「同名不同语境用限定名
     * 分离」,这里就照那个式子做,限定符取该行自己的 families[0](不另起名字)。
     */
    bareRoleQualified: number;
    /** ① 想限定但目标名已被占,退回归档的枢纽数(冲突不静默丢)。 */
    bareRoleBlocked: number;
    /**
     * 向量表里被清掉的「归档节点残留」行数。**由 store 层落库时填写**,纯函数不碰 I/O
     * 故恒为 0。放在同一份报告里是因为它记的是一类真实泄漏:历史 delete/merge/旧版归档
     * 把向量行留在了索引里,而这些节点在文本检索/画布/反查里早就不可见了。
     */
    vecRowsPruned: number;
    /** ① 被归档节点里的最大 fact 数(>20 即提示「这是枢纽,不是杂散泛称」)。 */
    archivedMaxFacts: number;
    /** ②③④⑤ 有变更的节点 id(供 store 层写回)。 */
    touchedIds: string[];
    /** ③④ 有变更的概念 id。 */
    touchedConceptIds: string[];
    /** ① 归档命中的名字样例(≤10,给人核对判据有没有误伤)。 */
    archivedSamples: string[];
}
/**
 * 就地清扫存量图(纯函数,无 I/O;变异传入的 nodes/concepts,与 apply 同风格)。
 *
 * @param options.nodes - 全量节点(含 archived;只动可见行)。
 * @param options.concepts - 概念行(③④ 同样适用)。
 * @param options.now - ISO 时间戳(写 updatedAt 用,由调用方注入以保证可测)。
 */
export declare function sweepStockGraph(options: {
    nodes: readonly GraphNode[];
    concepts?: readonly GraphConcept[];
    now: string;
}): GraphSweepReport;
