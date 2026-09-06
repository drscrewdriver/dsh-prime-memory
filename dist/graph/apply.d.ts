import type { MemoryRecord } from '../types.js';
import type { GraphEdge, GraphNode, GraphProjectionResult } from './types.js';
export interface ApplyGraphProjectionOptions {
    /** 可变异的合并 scope(现有节点/边;调用方决定 scope 大小)。 */
    nodes: GraphNode[];
    edges: GraphEdge[];
    /** 本批认领的记录(族判定与时间锚的证据来源)。 */
    records: readonly MemoryRecord[];
    result: GraphProjectionResult;
    allowedRecordIds: ReadonlySet<string>;
    /** 本次投影时刻(ISO;时间锚兜底与 updatedAt 的时间基准)。 */
    now: string;
    idFactory: (prefix: 'node' | 'edge' | 'gfact') => string;
}
export interface ApplyGraphProjectionOutcome {
    nodeIds: string[];
    edgeIds: string[];
    /** 因无来源/形状非法被丢弃的提案条数(节点+fact+边;诊断日志用)。 */
    dropped: number;
}
/**
 * 实体名归一(NFKC + 小写 + 去空白/下划线/连字符):全角/半角、大小写、
 * "张 三"与"张三"、"AI-agent"与"aiagent"视作同一实体的拼写变体。
 * 归一后空串返回原串(防止空名互相合并)。
 */
export declare function normalizeEntityName(name: string): string;
/**
 * 时间锚四级链:对来源记录逐条取 activity_start_time → activity_end_time →
 * timestamps 最新 → createdAt 四级证据,跨来源取最晚。任何一级都无法解析
 * (缺字段/非法日期)时落到下一级;全部无证据才用 fallback(now),绝不猜测。
 */
export declare function anchorTimeFromRecords(records: readonly MemoryRecord[], fallbackIso: string): string;
/** 应用一次投影提案(硬校验 + 消歧 + supersede + 状态重建)。 */
export declare function applyGraphProjection(options: ApplyGraphProjectionOptions): ApplyGraphProjectionOutcome;
