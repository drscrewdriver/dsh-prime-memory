/**
 * 记忆治理服务层(治理 W3,T3.1/T3.2/T3.4/T3.7)。
 *
 * 两个入口:
 * - `exportRecordsCsv`:PAGE 游标分页导出(**禁用 getAllL1**——万条库同步全表
 *   载入会阻塞主线程,计划 B 视角);产物是**导出副本非移动**(T3.13,源记录不动)。
 * - `applyVerdicts`:CSV 回传裁决。**破坏性动作纪律(I-14)**:干跑默认
 *   (`dryRun !== false`)、执行前落快照(requireSnapshot 常量 true)、
 *   乐观并发逐行校验(行级拒绝不整批作废)、上限截断回报 truncated、
 *   高影响项(instruction / persona≥80)要求 confirmHighImpact。
 */
import type { L1Store } from './store/l1.js';
/** 单页游标大小(与 memport 每批 ≤200 的纪律对齐)。 */
export declare const GOVERNANCE_PAGE_SIZE = 200;
/** 单次裁决回传条数上限;超限**显式回报** truncated,绝不静默截断(P1-6)。 */
export declare const VERDICTS_MAX_ROWS = 200;
/** verdict 词表(单一来源;新增值必须同步端点文档与词表一致性测试,I-17)。 */
export declare const VERDICT_VALUES: readonly ["retire", "restore", "demote-to-wiki", "promote-to-active", "move-scope", "mark-adopted", "keep"];
export type RecordVerdict = (typeof VERDICT_VALUES)[number];
export declare function normalizeVerdict(raw: unknown): RecordVerdict | undefined;
export interface VerdictRowInput {
    id: string;
    verdict: unknown;
    /** 乐观并发快照:回传的 updatedAt(导出时给的值);不符 = 行级拒绝(skippedStale)。 */
    updatedAt?: unknown;
    note?: unknown;
    /** move-scope:<repo> 的 repo 目标(或 verdict 列内联 `move-scope:<repo>`)。 */
    repo?: unknown;
}
export interface VerdictApplyRow {
    id: string;
    verdict: string;
    status: 'applied' | 'skippedStale' | 'skippedHighImpact' | 'skippedInvalid' | 'notFound' | 'noop';
    notice?: string;
}
export interface VerdictApplyResult {
    requested: number;
    applied: number;
    truncated: number;
    skippedStale: number;
    skippedHighImpact: number;
    skippedInvalid: number;
    notFound: number;
    noop: number;
    dryRun: boolean;
    snapshot?: string;
    rows: VerdictApplyRow[];
}
/**
 * 导出记忆 CSV(T3.1/T3.13):**游标分页 + 副本非移动**。
 * updatedAt 快照列供回传乐观并发(T3.7)。repo/applicability 列名不用裸词
 * `scope`(P1-4 四义术语表,ADR-0015)。
 */
export declare function exportRecordsCsv(store: L1Store, opts?: {
    limit?: number;
    retired?: boolean;
}): {
    csv: string;
    total: number;
};
export interface VerdictDeps {
    store: L1Store;
    /** 执行前可信快照(I-14:requireSnapshot 常量 true 的落点;失败应抛)。 */
    createSnapshot: (reason: string) => Promise<string>;
    /** 高权限门(records-restore 同款;破坏性动作的第二道闸)。 */
    memoryMutate: boolean;
}
/**
 * 裁决预演(T3.2):与 apply 同一套逐行校验,零写。
 * 返回与 apply 同形的行级结论,供面板/CSV 编辑者先看后拍。
 */
export declare function previewVerdicts(deps: VerdictDeps, rowsIn: VerdictRowInput[]): Promise<VerdictApplyResult>;
/**
 * 裁决应用(T3.2/T3.4/T3.7)。
 *
 * - **干跑默认**(省略 dryRun = true)——省略即安全是破坏性动作的唯一合法默认;
 * - **执行前落快照**(requireSnapshot 常量 true,不给关):快照失败即拒绝执行;
 * - **逐行乐观并发**:回传 updatedAt ≠ 库内值 → 该行 skippedStale(不整批作废);
 * - **高影响二次确认**:instruction / persona≥80 需 confirmHighImpact,否则该行跳过;
 * - **上限显式回报**:超 VERDICTS_MAX_ROWS 的尾部计入 truncated,绝不静默丢弃;
 * - verdict 路由(词表见 VERDICT_VALUES):retire→retire();restore→restore()(清
 *   validTo 回召回面);demote-to-wiki→setTier('wiki')+入队 L2 重聚类;
 *   promote-to-active→**仅对未退场记录** setTier('active')(已退场 noop+提示改用
 *   restore,Issue 5);move-scope→patchRepoKey;mark-adopted→bumpActivation;
 *   keep→noop(留痕在返回行)。
 */
export declare function applyVerdicts(deps: VerdictDeps, rowsIn: VerdictRowInput[], opts?: {
    dryRun?: boolean;
    confirmHighImpact?: boolean;
}): Promise<VerdictApplyResult>;
