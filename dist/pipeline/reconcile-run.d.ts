import { RECONCILE_STATE_FILE_VERSION } from '../store/file-versions.js';
import type { EvidenceSource } from '../store/evidence-source.js';
import type { MemoryLogger } from '../types.js';
import { type MemoryVerdict, type ReconcileDeps, type ReconcileInput, type ReconcileState } from './reconcile.js';
/**
 * 三重上限 + 调用数上限。**每一项都是硬闸门**:超了就裁掉并在计划里写清楚裁了什么。
 */
export interface ReconcileBudget {
    /** 单次运行最多核对多少条记忆。 */
    maxRecords: number;
    /** 单条记忆最多用几个锚点(锚点多 = 证据长 = 贵)。 */
    maxAnchorsPerMemory: number;
    /** 单条记忆的证据文本上限(字符)。 */
    maxEvidenceChars: number;
    /** 单次运行最多多少次模型调用(有锚点且未完成的条目才会产生调用)。 */
    maxCalls: number;
}
export declare const DEFAULT_RECONCILE_BUDGET: ReconcileBudget;
/** 预估结果(展示给人看的就是这个)。 */
export interface ReconcileEstimate {
    /** 输入里一共有多少条记忆。 */
    total: number;
    /** 其中带锚点(会花钱)的条数。 */
    billable: number;
    /** 没有锚点(免费,直接跳过)的条数。 */
    skippedNoAnchor: number;
    /** 因上限被裁掉的条数。 */
    trimmedByRecords: number;
    /** 因 `maxCalls` 被裁掉的条数。 */
    trimmedByCalls: number;
    /** 会被使用的锚点总数(裁剪后)。 */
    anchors: number;
    /** 已在上次运行中完成、本次不会重复计费的条数。 */
    alreadyDone: number;
    /** 输入字符上界(记忆正文 + 证据上限)。 */
    estInputChars: number;
    /** 输入 token 上界(按既有 CHARS_PER_TOKEN 口径,与官方同式)。 */
    estInputTokens: number;
    /** 模型调用次数上界。 */
    estCalls: number;
}
/** 预估 + 裁剪后的执行计划。**只有它能进 `executeReconcile`。** */
export interface ReconcilePlan {
    budget: ReconcileBudget;
    estimate: ReconcileEstimate;
    /** 裁剪后的待核对条目。 */
    memories: readonly ReconcileInput[];
    /** 人类可读的预估说明(面板/CLI 直接展示)。 */
    summary: string;
}
/** 断点续跑状态文件。 */
export interface ReconcileRunState {
    version: typeof RECONCILE_STATE_FILE_VERSION;
    runId: string;
    startedAt: number;
    updatedAt: number;
    /** 已完成条目键:`<memoryId>:<内容哈希前 8 位>`。 */
    done: string[];
}
/** 内容哈希前 8 位:**正文一变就必须重核**(见模块头注释)。 */
export declare function contentHash(text: string): string;
/** 续跑键:`(memoryId, 内容哈希)`。 */
export declare function resumeKey(memory: Pick<ReconcileInput, 'id' | 'text'>): string;
/** 状态文件路径(与 `pendingPathFor` / `state.json` 同目录)。 */
export declare function reconcileStatePathFor(dataDir: string): string;
/**
 * 读状态。
 *
 * **读侧分类**(文件层加固 T2.10,审计 D2 点名补上):原注释写「文件损坏/版本不符
 * 一律当作空状态」——损坏**不再静默**:`missing` 是首次运行(不告警),而
 * `corrupt` / `unreadable` / `unknown_version` 一律记诊断后才按空状态继续。
 * 「不覆盖」由 `atomicWriteJson` 的覆盖保护兜住(损坏文件写不进去,会显式报错)。
 *
 * 仍然**不抛**:续跑状态只是"跳过已判条目"的优化,坏了重跑一遍即可,不该阻止运行。
 */
export declare function loadRunState(file: string, logger?: MemoryLogger): Promise<ReconcileRunState | undefined>;
/**
 * 预估并裁剪。
 *
 * @param memories - 全部候选记忆。
 * @param budget - 三重上限。
 * @param doneKeys - 上次已完成、本次要跳过的键。
 * @returns 预估 + 计划。**这是唯一能产出 `ReconcilePlan` 的入口。**
 */
export declare function planReconcile(memories: readonly ReconcileInput[], budget?: ReconcileBudget, doneKeys?: readonly string[]): ReconcilePlan;
/** 预估说明(先给人看)。**必须写清裁掉了什么**——只报"要跑多少"会让人以为跑全了。 */
export declare function renderEstimate(estimate: ReconcileEstimate, budget: ReconcileBudget): string;
export interface ExecuteReconcileOptions {
    signal?: AbortSignal;
    /** 状态文件路径;不传则不落盘(纯内存运行)。 */
    stateFile?: string;
    logger?: MemoryLogger;
    onProgress?: (done: number, total: number, verdict: MemoryVerdict) => void;
}
export interface ExecuteReconcileResult {
    verdicts: MemoryVerdict[];
    report: string;
    counts: Record<ReconcileState, number>;
    /** 本次是否因中断提前结束(续跑时从状态文件接着来)。 */
    interrupted: boolean;
    state?: ReconcileRunState;
}
/**
 * 执行计划(只读;唯一的副作用是写**续跑状态文件**,不是记忆库)。
 *
 * 逐条执行、**每条完成后原子落盘**:进程被杀也能续跑,已完成的不重复计费。
 */
export declare function executeReconcile(deps: ReconcileDeps, plan: ReconcilePlan, opts?: ExecuteReconcileOptions): Promise<ExecuteReconcileResult>;
/** 清空续跑状态(显式动作:下次运行会重核所有条目,**会重复计费**)。 */
export declare function resetRunState(file: string): Promise<void>;
/** 供装配层使用:把证据面与 judge 组装成 deps。 */
export declare function makeReconcileDeps(evidence: EvidenceSource, judge: ReconcileDeps['judge'], logger?: MemoryLogger): ReconcileDeps;
