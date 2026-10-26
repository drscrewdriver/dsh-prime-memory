/**
 * 重建事实源抽象（issue #14-B）。
 *
 * ## 为什么需要这一层
 *
 * 重建原先硬编码 `MemoryDb.listL0All()`：写入侧（capture）自 T8.4 起已把 L0 正文停写、
 * 历史面交给 DRSC 投影，读侧却仍只认本地那张**冻结表**。这层把「事实源」抽成可替换的
 * provider，让本地 L0 与 DRSC 两套实现共用同一条重建管线。
 *
 * ## 两个刻意的设计约束
 *
 * 1. **`estimate()` 必须同步**：`RebuildController.start()` 是同步 RPC，要在返回前就
 *    给出体量与"能不能重建"的判定。DRSC 做不到同步报数，故 `FactEstimate.known=false`
 *    表示"未知"，调用方据此**跳过**同步前置门（改在 prepare 阶段用实际结果判定）。
 * 2. **`chunks()` 而不是"先全量再分组"**：`listL0All()` 在 3 万条量级上峰值约 88MB 且
 *    整个重建期常驻。按会话产出块，峰值降到单会话量级。`groupL0Sessions` 仍保留为
 *    纯函数（测试与本地实现的组装点），但生产路径按会话流式拉取。
 *
 * ## 不丢优先
 *
 * `snapshotIds()` 给 `planPreserve` 判 `post-watermark` 用。DRSC 实现**无法**枚举消息 id
 * （id 是采集端合成的 `drsc:<sid>:<seq>`，与事实源里的 `source_message_ids` 不同域），
 * 因此返回空集 —— 效果是**全部判为不可重蒸、全部保留**。这是安全侧失败：多保留只是多
 * 一条待去重，丢掉是不可逆。
 */
import type { ConversationMessage, MemoryLogger } from '../types.js';
import type { DrscClient } from '../clients/drsc.js';
import type { MemoryDb } from '../store/sqlite.js';
/** 重建分块：一个会话的全部消息（按时间升序）。 */
export interface RebuildChunk {
    sessionId: string;
    messages: ConversationMessage[];
}
/** 事实源侧的一条消息（与 `L0MessageRecord` 结构兼容，但不带 recordedAt/turn/step）。 */
export interface FactMessage {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}
/** 体量预估。`known=false` = 事实源无法同步报数（DRSC），字段值不可作为判定依据。 */
export interface FactEstimate {
    sessions: number;
    messages: number;
    chars: number;
    known: boolean;
}
/** 事实源覆盖范围（面板"重建只覆盖到 X"的依据）。 */
export interface FactCoverage {
    /** 覆盖到的时刻（ISO）；null = 未知/无正文。 */
    untilIso: string | null;
    sessions: number;
}
export interface FactSourceProvider {
    readonly kind: 'l0-local' | 'drsc';
    /** 同步体量预估；`known=false` 时调用方不得据此做拒绝判定。 */
    estimate(): FactEstimate;
    /**
     * 异步精确预估 + 内部预取（DRSC 在这里一次性枚举会话，`chunks()` 复用缓存）。
     *
     * 与 `estimate()` 的分工：后者是同步门（`start()` 返回前就要有结论），
     * 前者是 prepare 阶段的真实体量（能发请求、能报准确会话数）。
     */
    prepare(): Promise<FactEstimate>;
    /** 消息级流（诊断/测试用；生产走 chunks）。 */
    snapshot(): AsyncIterable<FactMessage>;
    /** 会话级流 —— 生产路径：单会话内存，不驻留全量正文。 */
    chunks(): AsyncIterable<RebuildChunk>;
    /**
     * 本次事实源的**消息 id 集**，供 `post-watermark` 判据。
     * 空集 = "判不出来" ⇒ 所有有来源的记录都会被保守判为不可重蒸并保留。
     */
    snapshotIds(): Promise<ReadonlySet<string>>;
    coverage(): FactCoverage;
}
/**
 * 把一批事实消息按会话分组（纯函数）。
 *
 * 保留这个签名是因为它有两个真实用途：① 本地实现按"一次全量"路径时可复用；
 * ② 测试要能直接断言分组与排序语义而不必起 provider。生产路径用 `chunks()` 流式，
 * 不经过这里 —— 否则又把全量正文攒回内存了。
 *
 * **仍然做归一 + 过滤**（与迁移前同口径）：入参允许是原始 L0 行，非法行（id 空、
 * role 非 user/assistant、正文空）一律丢弃。过滤不能只留在 provider 里，
 * 否则任何直接调本函数的调用方（含测试夹具）都得自己重复一遍。
 */
export declare function groupL0Sessions(records: Iterable<FactMessage | Readonly<Record<string, unknown>>>): RebuildChunk[];
/** 本地 L0 事实源（默认）：已停写的冻结存量，读面走会话点查避免全量驻留。 */
export declare class LocalL0FactSource implements FactSourceProvider {
    private readonly db;
    private readonly logger;
    readonly kind: "l0-local";
    constructor(db: MemoryDb, logger: MemoryLogger);
    estimate(): FactEstimate;
    prepare(): Promise<FactEstimate>;
    coverage(): FactCoverage;
    snapshotIds(): Promise<ReadonlySet<string>>;
    snapshot(): AsyncIterable<FactMessage>;
    chunks(): AsyncIterable<RebuildChunk>;
}
/**
 * DRSC 事实源（实验性，默认不用）：枚举会话 → 逐会话拉全量。
 *
 * 顺序说明：collector 的 `op=sessions` 按 `last_time_ms` **降序**返回，这里显式反转成
 * 升序，与本地实现的"会话按首条时间升序"对齐（上下文链的衔接方向一致）。
 */
export declare class DrscFactSource implements FactSourceProvider {
    private readonly client;
    private readonly logger;
    /** 会话分页大小（collector 侧钳 1..500）。 */
    private readonly pageSize;
    readonly kind: "drsc";
    constructor(client: DrscClient, logger: MemoryLogger, 
    /** 会话分页大小（collector 侧钳 1..500）。 */
    pageSize?: number);
    estimate(): FactEstimate;
    /** 会话枚举缓存（prepare 拉一次，chunks/snapshot 复用，不重复请求）。 */
    private sessionsCache;
    prepare(): Promise<FactEstimate>;
    coverage(): FactCoverage;
    snapshotIds(): Promise<ReadonlySet<string>>;
    private listAllSessions;
    private sessions;
    snapshot(): AsyncIterable<FactMessage>;
    chunks(): AsyncIterable<RebuildChunk>;
}
