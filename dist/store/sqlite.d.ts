import type { EmbeddingProviderInfo } from './embedding.js';
import type { L0MessageRecord, MemoryFamily, MemoryLogger, MemoryRecord } from '../types.js';
export interface StoreInitResult {
    /** embedding 配置(provider/model/维度)变化,需要后台全量重嵌入。 */
    needsReindex: boolean;
    reason?: string;
}
export interface StoreCapabilities {
    ftsSearch: boolean;
    vectorSearch: boolean;
}
import { CostLedger } from './cost-ledger.js';
import type { BucketRow, CostAggregate, CostByLayer } from './cost-ledger.js';
export type { BucketRow, CostAggregate, CostByLayer } from './cost-ledger.js';
import type { CostByModel } from '../contract.js';
import { GraphStore } from './graph-store.js';
import type { L1Receipt, ReceiptQuery, ReceiptRetentionOptions } from './receipts.js';
import type { ConflictPair } from './conflicts.js';
/** L1 检索命中(含 BM25/余弦归一分数)。 */
export interface L1SearchHit {
    id: string;
    content: string;
    type: string;
    priority: number;
    scene_name: string;
    score: number;
    family: MemoryFamily;
}
/** L0 检索命中。 */
export interface L0SearchHit extends L0MessageRecord {
    score: number;
}
export declare class MemoryDb {
    private db;
    private degraded;
    private ftsAvailable;
    private vecLoaded;
    private vecLoadWarned;
    /** 向量维度:活切换嵌入源时会变——vec0 表随维度重建。 */
    private dimensions;
    private readonly logger?;
    private stmtUpsertL1;
    private stmtGetL1;
    /** 主表存在性点查(防御性 FTS 删除的前置判断,走主键索引)。 */
    private stmtL1Exists;
    private stmtDeleteL1Meta;
    private stmtDeleteL1Vec?;
    private stmtInsertL1Vec?;
    private stmtSearchL1Vec?;
    private stmtL1FtsInsert;
    private stmtL1FtsDelete;
    private stmtL1FtsSearch;
    private stmtL1FtsSearchFamily;
    /** 成本账本(token_cost 表族;init 内初始化,未就绪时方法返回零值)。 */
    readonly costLedger: CostLedger;
    /** 图谱存储(graph_* 表族;init 独立 try/catch,失败仅图谱 no-op)。 */
    readonly graphStore: GraphStore;
    private stmtUpsertL0;
    private stmtGetL0;
    private stmtL0Exists;
    private stmtDeleteL0Vec?;
    private stmtInsertL0Vec?;
    private stmtSearchL0Vec?;
    private stmtL0FtsInsert;
    private stmtL0FtsDelete;
    private stmtL0FtsSearch;
    /** 按块缓存的 IN 语句(表名/动作/尺寸 → 预编译语句):热路径不再每次动态 prepare。 */
    private readonly inStmts;
    constructor(dbPath: string, dimensions: number, logger?: MemoryLogger);
    isDegraded(): boolean;
    getCapabilities(): StoreCapabilities;
    /** 统一事务边界:fn 抛出即 ROLLBACK 并把错误上抛(替代散落的手写 BEGIN/COMMIT/ROLLBACK)。 */
    private withTransaction;
    /**
     * 加载 sqlite-vec 扩展并建 schema。构造后必须调用一次。
     * providerInfo 变化(provider/model/维度)时 drop 向量表并返回 needsReindex。
     */
    init(providerInfo?: EmbeddingProviderInfo): StoreInitResult;
    /** 惰性加载 sqlite-vec(纯 FTS 起步后切本地嵌入时补加载);失败只停用向量能力并告警一次。 */
    private ensureVecLoaded;
    /**
     * 活切换嵌入源:provider/model/维度任一变化 → drop 向量表按新维度重建,
     * 返回 needsReindex=true(调用方后台重嵌,全部成功后 markEmbeddingSynced);
     * 配置未变化 → false(切回同一模型不重嵌)。
     * 新维度 > 0 但 sqlite-vec 不可用 → ok=false(调用方向用户说明,维持 FTS)。
     */
    swapProvider(info: EmbeddingProviderInfo): {
        ok: boolean;
        needsReindex: boolean;
        error?: string;
    };
    /** l1_vec 物理表的向量维度(建表 DDL 里的 float[N]);无表返回 null。 */
    private physicalVecDims;
    private initSchema;
    private prepareL1VecStatements;
    private prepareL0VecStatements;
    private dropVectorTables;
    private tableExists;
    private hasColumn;
    /**
     * 时间增强列:valid_from / valid_to / persistence。
     *
     * 与 family 列同款增量迁移——DDL 契约不改,只在缺列时补,幂等。
     * 存储形态与 created_time/updated_time 一致(ISO-8601 UTC 的 TEXT),
     * 于是区间比较既可按字典序,也能沿用 idx_l1_updated 的既有用法。
     *
     * 存量数据的 metadata.activity_start_time/activity_end_time 是这两列的前身,不回填:
     * 图谱时间锚仍读 metadata,列由新写入路径填充。
     */
    private ensureTemporalColumns;
    /** 重建后的 l1_fts 从 l1_records 全量回灌(仅在 drop 重建时调用;iterate 流式防大库内存峰值)。 */
    private backfillL1Fts;
    /** 重建后的 l0_fts 从 l0_conversations 全量回灌(仅 drop 重建时调用;iterate 流式)。 */
    private backfillL0Fts;
    private readEmbeddingMeta;
    private writeEmbeddingMeta;
    /** 通用字符串 kv(embedding_meta 表兼作元数据 kv 存储,如 FTS 分词器版本戳)。 */
    private readMetaString;
    private writeMetaString;
    /**
     * 持久化 embedding meta(语义:物理向量表当前对应的 provider/维度)。
     * 活切换在 swapProvider 成功后即写(表已是新维度);启动/补齐链在
     * 缺失向量补齐收敛(missing=0)后写——缺失行补齐判据是行数差,不依赖 meta。
     */
    markEmbeddingSynced(info: EmbeddingProviderInfo): void;
    /** upsert 一条 L1(元数据 + FTS 同步;embedding 非零时写向量)。失败返回 false 不抛。 */
    upsertL1(record: MemoryRecord, embedding?: Float32Array): boolean;
    /**
     * 批量 upsert L1(单事务;与单条同语义:FTS 失败整批回滚)。
     * 追加/导入热路径用它——逐条开事务在 WAL FULL 下每条一次 fsync。
     * 整批失败时回退逐条写入:好记录照常入库、坏记录只丢自身——否则
     * JSONL 事实源已先行追加,检索库却整批缺失且无自动重导路径(批次空洞)。
     */
    upsertL1Batch(records: MemoryRecord[], embeddings?: Array<Float32Array | undefined>): boolean;
    /** 事务内的单条写入体(upsertL1 / upsertL1Batch 共用;调用方负责事务)。 */
    private upsertL1InTx;
    /** 批量删除 L1(元数据 + 向量 + FTS),返回删除条数。IN 按 ≤900 分块(避变量数上限)。
     *  删除成功后触发图谱删除传播(来源全失效的节点/边惰性标 archived;失败不影响删除结果)。 */
    deleteL1Batch(ids: string[]): number;
    private inStatement;
    /**
     * 清空 L1 检索库全部数据(重建用)。records/FTS 直接 DELETE;
     * 向量表走 DROP + 重建(vec0 的全表 DELETE 语义不可靠,dropVectorTables
     * 会连 l0_vec 一起删——L0 向量必须保留——故此处单独处理 l1_vec)。
     * L0 表与 embedding_meta 不动:backfill 的行数比对天然重新一致。
     * 图谱表族一并清空——图谱是 L1 的可重建投影,记录清空即投影作废(B2)。
     */
    clearL1(): boolean;
    countL1(): number;
    /** 全量读取(调试/迁移/重嵌入用;检索请走 FTS/向量)。 */
    getAllL1(): MemoryRecord[];
    getL1ByIds(ids: string[]): MemoryRecord[];
    /**
     * §B 决策凭证批量落盘。`INSERT OR IGNORE` + 确定性 `receipt_id`
     * (见 `receipts.ts` 的 `receiptIdFor`)→ 同一次 run 重放不产生重复行。
     * 返回实际新增条数(被忽略的重复不计)。
     *
     * 刻意**不开事务**:凭证是旁路观测数据,单条独立、重放幂等,部分写入无害;
     * 为它引入事务只会把失败面扩大。调用方另有 `persistReceiptsSafely` 兜底不抛。
     *
     * 写入后**顺带执行保留策略**(task_18)。把裁剪挂在这里而不是交给调用方,
     * 是为了让"有界"成为**结构性保证**:任何写路径都不可能忘记裁剪,
     * 因而表容量不可能随使用时间无界增长。裁剪自身失败只 warn——
     * 它是省空间的动作,失败了最坏是这次没省下来,绝不能因此弄丢刚落盘的凭证
     * (故裁剪在写入**之后**,且包在 try 里)。
     */
    recordReceipts(rows: readonly L1Receipt[], opts?: ReceiptRetentionOptions): number;
    /**
     * §C 矛盾冻结(task_22):落盘待裁决冲突对。
     *
     * `INSERT OR IGNORE`——幂等来自 **pair_id 主键**而非调用方自觉:
     * `conflictPairId(runId, winner, loser)` 对同一三元组恒等,故一轮蒸馏重复落盘
     * 只会得到一行。与 §B 凭证同一手法(那边是 `receipt_id` 主键)。
     *
     * 与凭证不同,这里**不做保留裁剪**:待裁决对是**欠人的债**,不是观测数据。
     * 裁剪它等于把用户还没看的裁决请求悄悄删掉,那是丢工作而不是省空间。
     * 有界性交给 task_24 的队列上限(超限不再停放、回落自动裁决),语义是
     * 「**不收新的**」而非「**偷偷删旧的**」。
     *
     * @returns 实际新插入的行数。
     */
    recordConflictPending(rows: readonly ConflictPair[]): number;
    /** §C 冻结:把来源命中冲突集的图谱节点标 `disputed`(薄缝,便于单测替换)。 */
    markSourcesDisputed(recordIds: readonly string[]): number;
    /**
     * §B 凭证保留策略(task_18):只保留**最新**的 `maxRuns` 个 run,更老的整批删除。
     * 返回被删除的行数。
     *
     * 两条刻意的约束:
     * - **粒度是 run,不是行**。按行裁剪会切出"半截批次",而 task_19 的按 run 回溯
     *   正是要回答"这一轮蒸馏都判了什么"——一个少了尾巴的批次会给出**看似完整、
     *   实则遗漏**的结论,比查不到更糟。整批留、整批删,回溯的原子性才有保证。
     * - **只碰 `l1_receipts`,绝不碰 `l1_records`**。前者是可再生/可丢弃的观测数据,
     *   后者是用户的事实源。为省几 MB 而波及记忆本体,是把容量优化做成了数据丢失。
     *
     * `maxRuns <= 0` 或非有限值一律**不裁剪**——"传 0 即清空"是个太容易被误触的
     * 语义,宁可把它定义为无效输入。
     *
     * 定序取每 run 的 `MAX(decided_at)`(凭证的 decided_at 在一批内恒定)并以
     * `run_id` 兜底,使同一时刻产生的多个 run 也有**确定**的相对序,裁剪结果可复现。
     */
    trimReceipts(maxRuns: number): number;
    /**
     * §B 双维回溯(task_19):按 `record_id` / `run_id` 查判定史,两维同给为 **AND**。
     *
     * 两条刻意的行为:
     * - **两维都不给返回空,而不是全表**。「查全部凭证」不是本能力的目标;把缺参
     *   兜成全表,会让一次误调用变成全库判定史导出。调用方本就该先拒绝这种用法
     *   (工具层给提示、端点层直接报错),这里是第二道,方向一致。
     * - **定序确定**:`decided_at DESC, run_id DESC`。回溯的价值在于可复现——
     *   同一问题两次问出不同顺序,核对时就会怀疑是不是数据变了。`run_id` 兜底
     *   同一毫秒内的多批(L1 蒸馏是 LLM 调用,同刻两批罕见但非不可能)。
     *   新的在前,与 `listL1` 的倒序口径一致。
     */
    listReceipts(opts: ReceiptQuery & {
        limit: number;
    }): L1Receipt[];
    /** 同维度命中的**总条数**(不受 limit 影响,供"还有多少条没显示"提示)。 */
    countReceipts(opts: ReceiptQuery): number;
    /** 浏览列表(UI 用):按更新时间倒序,支持类型/场景/族/Hall 过滤与分页。失败返回空。 */
    listL1(opts: {
        type?: string;
        scene?: string;
        family?: string;
        hall?: string;
        limit: number;
        offset: number;
    }): {
        items: MemoryRecord[];
        total: number;
    };
    /** 场景名去重列表(UI 筛选器数据源)。失败返回空。 */
    distinctL1Scenes(): string[];
    /** FTS5 BM25 检索(family 缺省不过滤)。失败返回空数组(调用方降级)。 */
    searchL1Fts(query: string, limit: number, family?: string): L1SearchHit[];
    /** vec0 余弦 KNN 检索(score = 1 - cosine distance;family 过滤走过度召回 + 回查过滤,vec0 无法 WHERE)。失败返回空数组。 */
    searchL1Vector(embedding: Float32Array, topK: number, family?: string): L1SearchHit[];
    /** 批量 upsert L0 消息(元数据 + FTS;embeddings 与 records 等长,可省略)。 */
    upsertL0Batch(records: L0MessageRecord[], embeddings?: Array<Float32Array | undefined>): boolean;
    /** 记录一次蒸馏调用成本(委托 cost-ledger;语义见 CostLedger.insertCostCall)。 */
    insertCostCall(provider: string, model: string, layer: string, inputChars: number, outputTokens: number, reasoningTokens: number, retentionDays: number): void;
    /** 查询 token_cost 单窗口聚合(委托 cost-ledger;降级/异常返回零值)。 */
    aggregateCost(since: number): {
        total: CostAggregate;
        byModel: CostByModel[];
    };
    /** 按层级归并聚合(委托 cost-ledger;降级/异常返回空数组)。 */
    aggregateCostByLayer(since: number): CostByLayer[];
    /** 按时间桶 + model 聚合(委托 cost-ledger;趋势图与日均/周均/月均共用)。 */
    aggregateByBucket(bucketMs: number, offsetMs: number, since: number, layer: string): BucketRow[];
    countL0(): number;
    /** 统计 recorded_at >= iso 的消息数(状态面板"今日捕获"用)。 */
    countL0Since(iso: string): number;
    /** 统计某会话已捕获消息数(session-stats 数据源;idx_l0_session_id 索引点查)。 */
    countL0BySession(sessionId: string): number;
    /** 按会话取最近消息(时间升序返回;走 idx_l0_session_id 索引)。
     *  蒸馏背景参考专用——按会话现查替代全局内存数组(ADR-0003)。 */
    recentL0BySession(sessionId: string, limit: number): L0MessageRecord[];
    /** L0 全量列举(重建快照用;按时间升序,事务一致性避开 JSONL 追加竞态)。 */
    listL0All(): L0MessageRecord[];
    /** 重建成本预估(一次全表聚合:会话数 / 消息数 / 字符量)。 */
    l0RebuildEstimate(): {
        sessions: number;
        messages: number;
        chars: number;
    };
    /** 向量表行数(backfill 判据:与元数据行数的差值即缺失向量数;不可用时返回 -1)。 */
    countL1Vec(): number;
    countL0Vec(): number;
    searchL0Fts(query: string, limit: number): L0SearchHit[];
    searchL0Vector(embedding: Float32Array, topK: number): L0SearchHit[];
    /** L1 缺失向量的记录数(排除 skip 集后的补齐判据;向量能力不可用返回 -1)。 */
    countL1VecMissing(exclude?: Set<string>): number;
    /** L0 缺失向量的记录数(同上)。 */
    countL0VecMissing(exclude?: Set<string>): number;
    private countVecMissing;
    /**
     * 待重嵌入的 L1:只取缺失向量的记录(增量),排除 skip 集里已判定
     * "当前 provider 下不可嵌入(零向量)"的 id——缺 1 条不再全量重嵌,
     * 零向量记录也不再反复喂给 embeddings API(死循环双根因)。
     */
    getL1ForReindex(exclude?: Set<string>): Array<{
        id: string;
        content: string;
    }>;
    /** 待重嵌入的 L0(增量 + 排除 skip 集,同 getL1ForReindex)。 */
    getL0ForReindex(exclude?: Set<string>): Array<{
        id: string;
        text: string;
    }>;
    getVecSkipSet(kind: 'l1' | 'l0'): Set<string>;
    addVecSkippedIds(kind: 'l1' | 'l0', ids: string[]): void;
    clearVecSkipIds(kind: 'l1' | 'l0'): void;
    /** 只更新向量行(重嵌入用)。 */
    updateL1Vec(id: string, embedding: Float32Array): boolean;
    updateL0Vec(id: string, embedding: Float32Array, recordedAt: string): boolean;
    /**
     * 批量更新 L1 向量行(重嵌入热路径):单事务写入整批——逐条每行一次隐式事务,
     * 批量场景(万级记录重嵌)开销集中在 fsync 上。
     * 整批失败回退逐条:好行照常入库,坏行只丢自身(向量行 id 寻址,无顺序依赖)。
     * 返回成功写入的行数(零向量行防御性跳过、不计入)。
     */
    updateL1VecBatch(items: Array<{
        id: string;
        embedding: Float32Array;
    }>): number;
    /** L0 版 updateL1VecBatch(语义同:单事务 + 失败回退逐条)。recordedAt 整批统一。 */
    updateL0VecBatch(items: Array<{
        id: string;
        embedding: Float32Array;
    }>, recordedAt: string): number;
    close(): void;
}
/** 全零向量(cosine 未定义,不可入向量表)。reindex 侧用它区分"不可嵌入"与"写入失败"。 */
export declare function isZeroVector(vec: Float32Array): boolean;
