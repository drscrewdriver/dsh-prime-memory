import type { MemoryLogger, MemoryRecord } from '../types.js';
import type { RetireReason, SupersedeInfo } from './supersede.js';
/** 墓碑账本文件名(数据目录根下,与 memory.db / records/ 同级)。 */
export declare const RETIRE_JOURNAL_FILE = "retire-journal.jsonl";
/** 配当墓碑的退场原因(见文件头「哪些退场配当墓碑」)。 */
export declare const TOMBSTONED_REASONS: readonly RetireReason[];
export interface RetireJournalEntry {
    /** 事件类型:退场落正向墓碑,恢复落反向事件(replay 后到者胜)。 */
    ev: 'retire' | 'restore';
    id: string;
    /** ISO 8601 事件时刻。 */
    ts: string;
    /** 仅 ev='retire' 且有墓碑价值(manual/conflict)时写入。 */
    reason?: RetireReason;
    /** 内容墓碑指纹(仅 ev='retire');restore 反向事件按 id 撤销,不需要指纹。 */
    hash?: string;
    /** 外部幂等键(有则带上,Phase 2+ 的 pusher 侧交叉审计用)。 */
    extKey?: string;
}
/** 内容归一:折叠空白 + 小写。与 `computeExtKey` 的身份归一口径一致——**改动即换算法**,
 *  已有墓碑全部失配,升级须知写在这里。 */
export declare function normalizeForTombstone(content: string): string;
/** 墓碑指纹(sha256 hex)。纯函数,零 I/O。 */
export declare function tombstoneHash(content: string): string;
/**
 * 追加退场事件(同步落盘,量级 = 单次退场批的条数,微秒级)。
 * `records` 提供内容与 extKey(retire 调用点在库侧已完成,这里只派生指纹)。
 * 失败只 warn:墓碑缺一条 = 该条回到旧的已知边界,不是新故障。
 */
export declare function appendRetireJournal(dataDir: string, ids: readonly string[], info: SupersedeInfo, recordsById: ReadonlyMap<string, MemoryRecord>, logger?: MemoryLogger): void;
/** 追加恢复事件(撤销语义由 replay 的"后到者胜"给出,这里只落一行)。 */
export declare function appendRestoreJournal(dataDir: string, ids: readonly string[], logger?: MemoryLogger): void;
/** 当前活跃的墓碑集:内容指纹 → 退场原因。 */
export interface TombstoneSet {
    /** 命中活跃墓碑则返回其退场原因,否则 undefined。 */
    reasonFor(hash: string): RetireReason | undefined;
    get size(): number;
}
/**
 * 读账本并 replay 出活跃墓碑集(事件溯源,后到者胜:同一 id 最后一次 retire/restore
 * 决定生死;活着的 retire 按其 hash 建索引)。
 *
 * 坏行跳过(readJsonl 本身也跳),整体读失败回空集——重扫退化为 no-op,
 * 绝不因旁路账本阻断重建。
 */
export declare function readTombstones(dataDir: string, logger?: MemoryLogger): Promise<TombstoneSet>;
/**
 * 重建收尾的**遗忘重压**:扫本轮新产物,内容指纹命中活跃墓碑的重新压回退场。
 *
 * 单独成函数(而不是埋进 RebuildController)只为可测——环路判据不该要求
 * 跑一次端到端重建才能验证。`retire` 注入的是 `L1Store.retire`(汇流口,
 * 投射跟随与墓碑追加自然发生)。
 *
 * @returns scanned 扫过多少条候选,repressed 重新退场多少条。
 */
export declare function tombstoneResweep(opts: {
    dataDir: string;
    /** 重建窗口内的新产记录(调用方按 createdAt >= rebuildStartMs 收集)。 */
    candidates: readonly MemoryRecord[];
    retire: (ids: string[], info: SupersedeInfo) => number;
    logger?: MemoryLogger;
    now?: () => Date;
}): Promise<{
    scanned: number;
    repressed: number;
}>;
