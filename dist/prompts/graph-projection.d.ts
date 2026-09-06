import type { GraphEdge, GraphNode, GraphRecordStatus } from '../graph/types.js';
import type { MemoryRecord } from '../types.js';
/** 单条记忆在 prompt 中的字符上限(8 条/批 × 2000 字 ≈ 1.6 万字,远低于输入预算)。 */
export declare const GRAPH_RECORD_TEXT_LIMIT = 2000;
/** 上下文节点序列化时每节点携带的 active 事实条数上限。 */
export declare const GRAPH_PROMPT_FACTS_PER_NODE = 8;
/** 单条事实值在 prompt 中的字符上限。 */
export declare const GRAPH_PROMPT_FACT_CHARS = 200;
/** 投影任务无产出时的约定返回(写入 prompt 与测试)。 */
export declare const GRAPH_EMPTY_RESULT_HINT = "{\"reason\":\"\u672C\u6279\u6CA1\u6709\u503C\u5F97\u6C89\u6DC0\u7684\u5B9E\u4F53\u6216\u5173\u7CFB\",\"nodes\":[],\"edges\":[]}";
/** golden 示例:提示词展示的输出样例,同时是 apply 校验器的零丢弃回归样本。 */
export declare const GRAPH_PROJECTION_EXAMPLE: {
    reason: string;
    nodes: ({
        ref: string;
        name: string;
        type: string;
        aliases: string[];
        tags: string[];
        state: string;
        facts: {
            key: string;
            value: string;
        }[];
        confidence: number;
        sourceRecordIds: string[];
    } | {
        ref: string;
        name: string;
        type: string;
        tags: string[];
        state: string;
        facts: {
            key: string;
            value: string[];
        }[];
        confidence: number;
        sourceRecordIds: string[];
        aliases?: undefined;
    } | {
        ref: string;
        name: string;
        type: string;
        confidence: number;
        sourceRecordIds: string[];
        aliases?: undefined;
        tags?: undefined;
        state?: undefined;
        facts?: undefined;
    })[];
    edges: {
        fromRef: string;
        toRef: string;
        relation: string;
        confidence: number;
        sourceRecordIds: string[];
    }[];
};
/** 系统提示(约束常量内插;类型/关系词/上限与校验器同源)。 */
export declare function getGraphProjectionSystemPrompt(): string;
/** 上下文节点序列化(仅 active facts,有界;superseded/disputed 历史不进 prompt)。 */
export declare function serializeNodeForPrompt(node: GraphNode): string;
/** 用户上下文装配(记录 + 已有节点 + 已有边;数量上限由调用方选择后传入)。 */
export declare function buildGraphProjectionPrompt(inputs: {
    records: readonly MemoryRecord[];
    nodes: readonly GraphNode[];
    edges: readonly GraphEdge[];
}): string;
/** 生命周期词汇(节点状态中文标注,prompt/工具复用)。 */
export declare const GRAPH_STATUS_LABELS: Record<GraphRecordStatus, string>;
