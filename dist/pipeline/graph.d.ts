/**
 * 图谱投影管线:claim → 上下文装配 → LLM 投影 → 纯函数校验落库。
 *
 * LLM 调用发生在事务外(GraphStore 的 claim/complete 是两个独立事务缝)——
 * 单一 LLM 并发源仍是 runner 的串行泵,本文件不做任何并发控制。
 * 上下文装配的纯函数(selectContextNodes/selectContextEdges)独立导出,
 * 上下文有界性(节点 ≤80 / 边 ≤120 / 仅 active facts)是 G4 验收面。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { GraphStore } from '../store/graph-store.js';
import type { MemoryLogger, MemoryRecord } from '../types.js';
import type { GraphEdge, GraphNode, GraphProjectionResult } from '../graph/types.js';
/** claim 上下文装配的节点上限(词法相关 + 最近更新,总量封顶)。 */
export declare const GRAPH_CONTEXT_NODE_LIMIT = 80;
/** 保底携带的最近更新节点数(图谱冷启动后有"当前关注点"锚)。 */
export declare const GRAPH_CONTEXT_RECENT_NODES = 24;
/** claim 上下文装配的边上限。 */
export declare const GRAPH_CONTEXT_EDGE_LIMIT = 120;
/**
 * 选择进入投影上下文的已有节点:与批内记录词法相关(名称/别名/标签与记录内容
 * token 相交,归一去重)优先,再按更新时间新→旧补足最近节点,总量 ≤80。
 * 词法相关的判定复用 normalizeEntityName + tokenize,不 includes。
 */
export declare function selectContextNodes(records: readonly MemoryRecord[], nodes: readonly GraphNode[], limit?: number): GraphNode[];
/** 选择进入上下文的边:两端都入选节点的 active 边,按更新时间新→旧,≤120。 */
export declare function selectContextEdges(nodes: readonly GraphNode[], edges: readonly GraphEdge[], limit?: number): GraphEdge[];
/**
 * 执行一次图谱投影(claim 一个 job → LLM → 校验落库;无 job 时静默返回)。
 * 返回是否实际认领了任务(泵据此决定是否续排)。失败转 fail(退避/封顶由
 * GraphStore 管),不向 runner 上抛。
 */
export declare function runGraphProjection(ctx: Context, cfg: MemoryConfig, graphs: GraphStore, logger: MemoryLogger): Promise<boolean>;
/** 投影输出解析与形状归一:非对象/缺数组字段回空结构(校验侧再逐条把关)。 */
export declare function parseProjection(raw: string, logger?: MemoryLogger): GraphProjectionResult;
