import { type FullViewEdge, type FullViewNode } from './preview.js';
import type { GraphEdge, GraphNode } from './types.js';
/** 骨架层占比(度量为 nodeCap)。 */
export declare const EXPLORER_QUOTA_SKELETON = 0.6;
/** 新鲜层占比(度量为 nodeCap)。 */
export declare const EXPLORER_QUOTA_FRESH = 0.2;
export interface ExplorerSelectCaps {
    nodeCap?: number;
    edgeCap?: number;
}
export interface ExplorerSelection {
    nodes: FullViewNode[];
    edges: FullViewEdge[];
    /** 任一维触顶(渲染侧必须据此提示"仅画部分",不得静默少画)。 */
    truncated: boolean;
    /** 各层实际入选数(合计 === nodes.length;诊断与单测断言用)。 */
    counts: {
        skeleton: number;
        fresh: number;
        tail: number;
    };
    /** 截断前的可见节点总数(页面显示 "M/N 节点")。 */
    totalVisible: number;
    totalEdges: number;
}
/**
 * 主函数。纯计算:不查库、不落库。`nodes`/`edges` 由调用方一次性装载
 * (GraphStore.loadGraph),与 buildFullView 共享同一份入参。
 */
export declare function selectExplorerNodes(nodes: readonly GraphNode[], edges: readonly GraphEdge[], caps?: ExplorerSelectCaps): ExplorerSelection;
