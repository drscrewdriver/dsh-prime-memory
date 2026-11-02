/**
 * L1 **批内自去重**（同轮/同会话）——纯函数，零 IO、零 import 副作用。
 *
 * 为什么需要它（#现场取证，见 .agents/plans/pm-dedupe-scale-drsc-hint/findings.md §4）：
 * 既有 L1 去重只把**新记忆**和**库里的候选**对比（`store.searchCandidates`），同一批
 * `extracted[]` 之间**从不互相比较**。于是同一段对话被抽成多条碎片时，它们会一起进同一条
 * ≤20 条的 LLM 去重 prompt，只能由模型产出 `merged_content` 把内容"摞在一起"——
 * 既费一次 LLM 判定，又让落库正文变肿。
 *
 * 做法：在进 LLM 之前先做两级收拢，**只减条数、不改语义**：
 *   ① 精确层：归一化（trim / NFKC 全半角 / 空白折叠 / 去零宽）后同内容即合并；
 *   ② 向量层：**仅同 family + 同 type** 内、余弦 ≥ tau 贪心聚类。
 * 代表项规则：正文最长者（等长取 priority 高者，再等取先出现者）；其 record_id 与 content
 * **原样保留**，因此调用方可以把它自己的向量直接复用（正文没被改写，向量不会错配）。
 *
 * 明确不做：不产生合并正文（那是 LLM merge 的职责，见 ADR-0006 receipt 一致性）；
 * 不跨族/跨类合并；不替调用方决定 store/skip。
 */
/** 聚类所需的最小结构（`PendingMemory` 天然满足）。 */
export interface DedupeShaped {
    record_id: string;
    content: string;
    priority?: number;
    family?: string;
    type?: string;
    /** 只有部分调用方带这两个字段；带了就取并集，没带就不凭空造。 */
    timestamps?: number[];
    source_message_ids?: string[];
}
export interface ClusterOutcome<T> {
    /** 代表项（原对象字段 + 并入的 priority/timestamps/source_message_ids）。 */
    effective: T[];
    /** 逐簇的吸收关系（供 receipt 审计）。 */
    absorbed: Array<{
        representative: string;
        absorbed: string[];
    }>;
    /** 扁平映射：被吸收 id → 代表 id（写 receipt 用）。 */
    absorbedBy: Record<string, string>;
}
/**
 * 用于比较的归一化文本。
 * NFKC 会把全角标点/字母折到半角；零宽字符（U+200B–200F / U+FEFF）直接剔除——
 * 它们肉眼不可见，却足以让两条"同一句话"取不同 hash。
 */
export declare function normalizeForDedupe(s: string): string;
/** 余弦相似度；任一向量缺失/长度不等/零向量时返回 undefined（不可比，绝不猜）。 */
export declare function cosineMaybe(a: Float32Array | undefined, b: Float32Array | undefined): number | undefined;
/**
 * 精确层：归一化后同内容合并（含全半角/空白/零宽差异）。
 * 空内容条目**不参与**合并（各自成簇）——正文为空是上游缺陷，静默吞掉会更难查。
 */
export declare function clusterExact<T extends DedupeShaped>(items: readonly T[]): ClusterOutcome<T>;
/**
 * 向量层：**仅同 family + 同 type** 组内，余弦 ≥ tau 即并入先出现的代表簇。
 * 缺向量 / 长度不等 / 零向量 → 不可比，直接自成代表（不猜相似）。
 * 先精确层、后本层是刻意顺序：精确重复不必再花一次比较，且能让代表项更稳定。
 */
export declare function clusterByVector<T extends DedupeShaped>(items: readonly T[], vectors: ReadonlyArray<Float32Array | undefined>, tau: number): ClusterOutcome<T>;
/** `preDedupeBatch` 的可注入口：向量获取（失败可抛，由本函数降级）。 */
export type EmbedManyFn = (texts: string[]) => Promise<Array<Float32Array | undefined>>;
export interface PreDedupeOpts {
    /** 缺省 true；false 直接透传（行为与改动前逐字节一致）。 */
    enabled?: boolean;
    /** 有效区间 0.85–0.99，越界 clamp 并通过 onWarn 留痕（不抛）。 */
    tau?: number;
    onWarn?: (msg: string) => void;
}
export interface PreDedupeResult<T> {
    effective: T[];
    /** 代表项 record_id → 该正文的向量（候选召回与写侧复用同一份）。 */
    vectors: Map<string, Float32Array>;
    absorbedBy: Record<string, string>;
    /** 三级计数（日志与用例断言用）。 */
    raw: number;
    exact: number;
    vector: number;
}
/**
 * 一次完成：精确层 → （可选）向量层，并把“代表项→向量”与“被吸收→代表”两表一并交回。
 *
 * 嵌入不可用时**降级只做精确层**（catch 后留一条 warn），绝不因向量故障阻断蒸馏——
 * 它只是省 LLM 判定与写侧重嵌的优化，不是正确性前置。
 */
export declare function preDedupeBatch<T extends DedupeShaped>(items: readonly T[], embedMany: EmbedManyFn, opts?: PreDedupeOpts): Promise<PreDedupeResult<T>>;
