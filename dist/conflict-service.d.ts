/**
 * §C 矛盾冻结的**裁决出口**(task_25)。
 *
 * 冻结把裁决权交还给人,那么必须有一个"人能把结论说回去"的出口:
 * 否则待裁决队列是只进不出的黑洞,安全阀(task_24)的自动了结会成为唯一出路——
 * 那等于把 opt-in 的冻结悄悄退回成"超时后机器自己判"。
 *
 * 工具层与 RPC 层共用本模块,保证两条出口的**语义与返回形状完全一致**
 * (与 `memory_receipts` 一样:同一份 `ReceiptsView` 供工具与端点共用)。
 */
import type { L1Store } from './store/l1.js';
/** 裁决结果的对外形状(snake_case,工具与端点共用)。 */
export interface ConflictResolutionView {
    pair_id: string;
    outcome: string;
    /** 裁决时刻(ISO)。空串 = 未生效。 */
    resolved_at: string;
    /** 因裁决从检索中退场的记录 id(无则空串)。 */
    removed_record_id: string;
    notice?: string;
}
export interface ConflictResolveDeps {
    l1: Pick<L1Store, 'listConflictPending' | 'resolveConflictPending' | 'deleteBatch' | 'syncGraphDisputed'>;
    /** `conflictFreeze.enabled`。未开启时队列恒空,直接给出提示而非静默无操作。 */
    conflictFreezeEnabled: boolean;
}
/**
 * 裁决一条待裁决对。
 *
 * 顺序刻意如此:
 * ① **先打 `resolved_at` 再退场 loser**。反过来的话,退场成功但打标失败会留下
 *    "记录已消失、队列里那条仍在待裁决"的状态——人再点一次才发现无据可依。
 *    打标用 `WHERE resolved_at = ''`,天然防重复裁决:第二次调用拿到 0 行即中止。
 * ② 退场后才**重算**图谱 `disputed`(派生字段必须由当前事实重算,见 `syncDisputed`)。
 */
export declare function resolveConflictPair(deps: ConflictResolveDeps, pairId: string, outcome: string): Promise<ConflictResolutionView>;
/** 裁决结果的人类可读渲染(工具路径用)。schema 产出的是可选字段,故按部分取值渲染。 */
export declare function renderConflictResolution(v: Partial<ConflictResolutionView>): string;
