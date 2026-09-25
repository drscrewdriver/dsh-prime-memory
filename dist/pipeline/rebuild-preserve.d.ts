/**
 * 保留式重建:清空 L1 前判定**哪些记忆不可能被 L0 重蒸馏出来**,并把这些保住。
 *
 * ## 为什么需要这个模块
 *
 * `RebuildController.prepare()` 的语义是"清空 L1 检索库 → 从 L0 全量重蒸馏"。
 * 这个语义对**由 L0 蒸馏而来**的记忆是自洽的(清掉也能再造一遍),但对
 * **不由 L0 派生**的记忆是破坏性的:`memory_add` / `memory_import` 写进来的
 * 外部记忆(其他 AI 工具导出的记忆包)在任何会话日志里都没有对应位置,
 * 重建不会再造出它们。实测(`_analysis_output` 探针,2026-09-17)这类记录
 * 当时有 19 条存活,涉及 `__manual__` 与若干外部导入场景名。
 *
 * ## 判据为什么是 `source_message_ids`,而不是"有没有锚点"
 *
 * 计划书原稿写的是"无来源记忆(**导入类 / 无锚点类**)",但实测推翻了后半句:
 *
 * - 检索库 `l1_records` **没有 `source_message_ids` 列**(见 `types.ts:224` 的
 *   既有注释"JSONL 事实源保留;检索库不存该列"),所以判据只能来自**事实源**;
 * - 检索库里 `dsh_source_anchors` 的命中数是 **0/740** —— task_31 落地的锚点
 *   写入**尚未产出任何一行**(没有新的蒸馏发生过)。把"无锚点"当判据会把
 *   **全部 740 条**都判成"要保留",重建直接退化成空操作。
 *
 * 所以判据取事实源里的 `source_message_ids`:非空 ⇒ 该记忆的位置在 L0 日志里
 * 有据可查、重建能再造;空/缺失 ⇒ 造不出来,**必须保留**。
 *
 * ## 为什么必须取"事实源 ∩ 检索库"
 *
 * 事实源是**只增不改**的历史(合并/更新产出新 id 后,旧行仍留在 JSONL)。
 * 实测:事实源 1,694 个唯一 id,检索库 740 个,`事实源 ∩ 检索库 == 检索库`
 * (即检索库是事实源的真子集,反向差集为 0)。其中**已从检索库退场、但没有
 * `source_message_ids` 的有 25 条** —— 按事实源无脑恢复会**复活这 25 条已删记录**。
 * 故保留集 = 事实源无来源 **且** 检索库仍存在,两个条件缺一不可。
 *
 * ## 静默缺席的处理
 *
 * 事实源读不出来时,"没有记录需要保留"与"不知道哪些记录需要保留"长得一模一样。
 * 后者若按前者处理,重建就**静默退化**成原来的破坏性行为。故 `gateClear()` 在
 * 事实源不可读(或可读但零记录)**且检索库非空**时**拒绝放行**,而不是放行。
 */
import type { MemoryRecord } from '../types.js';
/** 事实源读取结果的失败原因。成功时为 undefined。 */
export type FactSourceFailure = 'dir-missing' | 'read-error';
export interface FactSourceRead {
    /** 事实源是否可读。false 时 `records` 必为空。 */
    readonly ok: boolean;
    readonly records: readonly MemoryRecord[];
    /** 实际读到的文件数(诊断用:0 个文件与目录缺失是两回事)。 */
    readonly files: number;
    readonly reason?: FactSourceFailure;
    /** 读取异常原文(仅 `read-error` 时)。 */
    readonly detail?: string;
}
/** 保留原因。 */
export type PreserveReason = 
/** 事实源里没有 `source_message_ids` —— 不是从 L0 蒸馏来的。 */
'no-source'
/** 内容为空白 —— 重蒸馏不会产出空记忆,保留它也无从重造。 */
 | 'empty-content'
/**
 * 检索库里有、事实源里**完全没有**这一行 —— 来源无从证明。
 *
 * 实测该集合当前为 **0**(检索库 740 ⊆ 事实源 1,694),所以它不是常规路径,
 * 而是**事实源部分损坏时的兜底**:`readJsonl` 会静默跳过坏行(`util/io.ts:78`),
 * 半张文件坏掉时"事实源里没有它"会与"它本来就没有来源"长得一样。
 * 判不出来源的记忆一律留下 —— 留错是多一条待去重的记录,丢掉是不可逆的。
 */
 | 'unprovenanced';
export interface PreserveEntry {
    readonly record: MemoryRecord;
    readonly reason: PreserveReason;
}
export interface PreservePlan {
    /** 清空后要原样放回的记忆。 */
    readonly preserved: readonly PreserveEntry[];
    /** 可由 L0 重蒸馏的记忆条数(不保留,重建会再造)。 */
    readonly rederivable: number;
    /**
     * 事实源里无来源、但**已从检索库退场**的条数 —— 已被合并/取代,
     * 恢复它们等于复活已删记录。**只计数,不恢复**。
     */
    readonly retiredNoSource: number;
    /** 事实源唯一 id 数(含已退场)。 */
    readonly factCount: number;
    /** 检索库条数。 */
    readonly dbCount: number;
}
/** 判定单条记录是否可由 L0 重蒸馏出来(事实源侧判据)。 */
export declare function isRederivable(record: MemoryRecord): boolean;
/**
 * 读取事实源目录(`<dataDir>/records/*.jsonl`)。
 *
 * 只读 `*.jsonl` 顶层文件:`archiveDerived()` 把旧目录整体改名为
 * `records.bak.<ts>`,它是**兄弟目录**不是文件,不会被 glob 命中。
 * **必须在 `archiveDerived()` 之前调用** —— 归档之后事实源就搬走了。
 */
export declare function readFactSource(recordsDir: string): Promise<FactSourceRead>;
/**
 * 出保留计划。纯函数:输入事实源记录 + 检索库现存记录,输出要保留什么。
 *
 * 两个方向都保守:事实源说"这条没来源"要留,**检索库里查不到出处**也要留
 * (`unprovenanced`)—— 判据缺失时留,而不是丢。
 *
 * `liveDbRecords` 由调用方从**检索库**取(它没有 `source_message_ids` 列,
 * 只用来回答"这条还在不在"),恢复时以检索库副本为准 —— 那是当前检索态。
 */
export declare function planPreserve(factRecords: readonly MemoryRecord[], liveDbRecords: readonly MemoryRecord[]): PreservePlan;
/** 清空闸门的判定码。 */
export type ClearGateCode = 
/** 放行。 */
'ok'
/** 放行:检索库本来就是空的,没有可失去的东西。 */
 | 'empty-db'
/** **拒绝**:事实源目录读不到,而检索库非空 —— 判不出该保留什么。 */
 | 'source-missing'
/** **拒绝**:事实源可读但零记录,而检索库非空 —— 事实源异常,同上。 */
 | 'source-empty';
export interface ClearGate {
    readonly allowed: boolean;
    readonly code: ClearGateCode;
    /** 面向用户的中文说明(会进 `RebuildStatus.error`,故必须讲清怎么补救)。 */
    readonly note: string;
}
/**
 * 清空前的守门判定。
 *
 * 拒绝而不是放行,是因为"没有需要保留的"与"不知道有没有需要保留的"在数据上
 * 无法区分(见文件头「静默缺席的处理」)。检索库为空时不存在可失去的记忆,
 * 故那一路照常放行 —— 不把功能卡死在干净环境上。
 */
export declare function gateClear(read: FactSourceRead, plan: PreservePlan): ClearGate;
/** 恢复结果。**逐条核实**,不靠 `appendNew` 的"没抛就算成功"。 */
export interface PreserveRestoreResult {
    readonly attempted: number;
    readonly restored: number;
    readonly missing: readonly string[];
}
/**
 * 把保留集放回检索库 + 事实源。
 *
 * 走 `L1Store.appendNew` 而不是 `db.upsertL1`:前者**双写**(JSONL 事实源 + 检索库),
 * 而此刻 `records/` 刚被 `archiveDerived()` 改名走,只写检索库会让这些记忆
 * 再次成为"没有事实源副本"的孤儿 —— 下一次重建就再也判不出它们了。
 */
export declare function restorePreserved(l1: {
    appendNew: (records: MemoryRecord[]) => Promise<void>;
    getByIds: (ids: string[]) => MemoryRecord[];
}, plan: PreservePlan): Promise<PreserveRestoreResult>;
/** 面向日志/状态栏的一行摘要。 */
export declare function describePlan(plan: PreservePlan): string;
