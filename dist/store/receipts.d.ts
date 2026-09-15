/** 摘要格式版本。进入 canonical 串,使算法演进时**不会静默**让新旧凭证看起来可比。 */
export declare const DIGEST_FORMAT = "l1-receipts/v1";
/**
 * 候选池**有序序列** → 稳定摘要(sha256 hex)。
 *
 * 语义:`searchCandidates` 返回的是**已排序**的候选池,「当时看到哪些候选、按什么序」
 * 就是去重决策的输入。故本函数**顺序敏感**——换个序即不同摘要,而不是把候选当集合。
 *
 * 三项刻意的设计:
 * - **顺序敏感**:见上。集合语义会丢掉"哪条候选排在最前"这一信息。
 * - **重复不折叠**:`['r1','r1']` 与 `['r1']` 摘要不同。候选池里的重复本身是事实
 *   (例如同一记录被两条通路召回),折叠掉等于篡改输入。
 * - **长度前缀编码**:逐项写 `${len}:${id}\n` 而非直接拼接。否则 `['a|b']` 与
 *   `['a','b']`(以及 `['a\nb']` 与 `['a','b']`)会碰撞——分隔符出现在 id 里时,
 *   序列化就不再是单射,摘要也就失去了作为输入指纹的意义。
 *
 * 纯函数:无 I/O、无时间、无随机。同输入**恒**同输出,这是凭证可复算的前提。
 */
export declare function inputDigest(candidateIds: readonly string[]): string;
/**
 * 凭证保留上限:**最多保留多少个 run**。
 *
 * 为什么按 **run 数**而不是按天数(§B task_18):
 * 本策略要防的是「`memory.db` 无限增长」。时间窗口**给不出这个保证**——
 * 阈值(比如 90 天)与写入速率无关,一个高频用户 90 天能写进任意多行,
 * 无界增长只是被推迟,不是被消除。run 数上限则**直接给出行的上界**
 * (`maxRuns × 每 run 记录数`),这是"有界"与"看起来有界"的区别。
 * 代价是:一个几乎不用的用户,历史可能只剩最近 1000 次蒸馏——
 * 但凭证是**诊断设施**,诊断需要的是"最近发生了什么",不是考古。
 *
 * 1000 这个量级的依据:一轮 L1 蒸馏通常落 5~20 条凭证,故上限约 1~2 万行
 * (数 MB 量级,在同为单文件的 `memory.db` 里不构成压力);而 L1 蒸馏本身要
 * 调一次 LLM,现实中每小时至多几次——1000 轮 ≈ 活跃使用数月。
 *
 * **为什么是常量而不是配置项**:配置项要接 schema、契约与设置页,为一个
 * 诊断表的容量引入用户可见面,收益与面积不成比例(YAGNI)。真需要调,
 * 改这里即可,且 `recordReceipts(rows, { maxRuns })` 已留出显式注入口。
 */
export declare const RECEIPTS_MAX_RUNS = 1000;
/** 裁剪策略的可选入参。省略时用 {@link RECEIPTS_MAX_RUNS}。 */
export interface ReceiptRetentionOptions {
    /** 最多保留的 run 数;<=0 或非有限值视为"不裁剪"。 */
    maxRuns?: number;
}
/**
 * 凭证的决策类型。
 * - 前四项是 LLM 明确给出的动作;
 * - `skip_missing` 表示**根本没拿到可用决策**(模型没返回 / 返回了非法动作)。
 *   刻意与 `skip` 分开:回溯"这条为什么没进记忆"时,「模型决定不存」与
 *   「模型没答」是完全不同的两件事,合并会让 §B 失去一半诊断力。
 */
export type L1ReceiptKind = 'store' | 'update' | 'merge' | 'skip' | 'skip_missing';
/** 一条凭证(与 `l1_receipts` 表一行同形)。 */
export interface L1Receipt {
    receiptId: string;
    runId: string;
    recordId: string;
    kind: L1ReceiptKind;
    inputDigest: string;
    decidedAt: string;
}
/** 构建凭证所需的单条输入(与 `runExtraction` 的 `matches` 逐项对应)。 */
export interface ReceiptInput {
    recordId: string;
    /** 该次判定召回的候选池(有序,顺序进入摘要)。 */
    candidateIds: readonly string[];
    /** 模型给出的动作;缺失/非法时传 undefined。 */
    action: string | undefined;
}
/**
 * §B 双维回溯的查询入参(task_19)。
 *
 * 两个维度对应两类**互不替代**的问题,故同为可选、同给时为 **AND**:
 * - 只给 `recordId` →「这条记忆**出自哪一轮**,当时看到什么候选池、被判成了什么」
 * - 只给 `runId`    →「上一轮蒸馏都判了什么」(那一批的全部决策,跨多条记录)
 * - 两维同给        →「这条记录在那一轮里被判成了什么」(唯一一条)
 *
 * **`recordId` 维度的取值面必须如实说清**:`pipeline/l1.ts` 对每条抽取结果执行
 * `record_id: newId('mem')`——**每轮新铸 id,从不复用**。故一个 `record_id`
 * 在现实中只可能属于**一轮** run,该维度目前**恒返回 0 或 1 行**。
 * 它回答的是「出自哪」,不是「历次变更」;查询层按可多行实现(一旦将来复用 id,
 * 或模型给的 id 被沿用,无需改这里),但**不要拿"判定史"这种说法承诺现状**——
 * 这是本任务执行期发现并修正的一处**说过头**。
 *
 * **两维都不给不是"查全部"**:那会让一次误调用变成全库判定史导出。调用方
 * (工具层 / 端点层)必须先拒绝这种用法;数据层在此再兜一层,返回空而非全表。
 */
export interface ReceiptQuery {
    recordId?: string;
    runId?: string;
}
/** 二维回溯命中的是哪个维度(供调用方与用户确认"我查的是哪一类问题")。 */
export type ReceiptDimension = 'record' | 'run' | 'both' | 'none';
export declare function dimensionOf(q: ReceiptQuery): ReceiptDimension;
/**
 * 回放视图的一行。**snake_case 且与 DB 列同形**——凭证是给人核对的原始证据,
 * 中间再套一层 camelCase 命名只会让"表里写的"与"工具吐的"对不上,
 * 核对时多一次心算就是多一次出错机会。
 */
export interface ReceiptView {
    receipt_id: string;
    run_id: string;
    record_id: string;
    kind: L1ReceiptKind;
    input_digest: string;
    decided_at: string;
}
/** 工具层与 RPC 层**共用**的回溯结果形状(一个事实源,两处消费)。 */
export interface ReceiptsView {
    dimension: ReceiptDimension;
    items: ReceiptView[];
    /** 该维度命中的总条数(不受 `limit` 影响;`items` 才是分页窗口)。 */
    total: number;
    /** 非结果的状态提示(工具层拒答时用;端点层以报错代替)。 */
    notice?: string;
}
export declare function toReceiptView(r: L1Receipt): ReceiptView;
/** 回溯结果条数上限(与 `list-records` 同量级;超出窗口由 `total` 提示还有多少)。 */
export declare const RECEIPTS_QUERY_LIMIT_MAX = 200;
/**
 * 一次蒸馏执行的 run 标识。
 *
 * **为什么不是"由输入切片推导出的确定性值"**——v1 曾这么设计，实测后被推翻：
 * `pipeline/l1.ts` 对每条抽取结果执行 `record_id: newId('mem')`，
 * **模型给的 record_id 被丢弃，记录 id 是运行时生成的**。因此"同一批消息重跑"
 * 必然产生**不同的 record_id**，也就必然产生不同的凭证。把 run_id 做成切片的函数
 * 换不来任何跨次幂等，只会让两次**互不相干的执行**挤在同一个 run_id 下，
 * 反而破坏「一个 run = 一次执行」的归因。
 *
 * 于是幂等的真正边界是：**同一次 run 内，同一条记录只留一条凭证**
 * （`receipt_id = f(run, record)` + `INSERT OR IGNORE`）。
 * 这才是"同一决策不重复落盘"在本代码库里能成立的那个含义。
 *
 * 命名沿用仓库既有惯例（`newId('mem')` / `newJobId()` → `前缀_时间戳_随机`）。
 */
export declare function newRunId(): string;
/** receipt_id = f(run, record) —— 幂等的落点(同 run 同记录只留一条)。 */
export declare function receiptIdFor(runId: string, recordId: string): string;
/** 动作归一:只认四个合法动作,其余一律记 `skip_missing`(不采信模型的非法输出)。 */
export declare function normalizeKind(action: string | undefined): L1ReceiptKind;
/** 纯映射:决策集 → 凭证行。无 I/O,便于单测与复算。 */
export declare function buildReceipts(runId: string, decidedAt: string, items: readonly ReceiptInput[]): L1Receipt[];
/** 凭证落盘的最小写入缝(与 `L1Store.recordReceipts` 同形)。 */
export type ReceiptWriter = (rows: readonly L1Receipt[]) => number;
/**
 * **失败隔离**:凭证是旁路观测设施,绝不是主链路的单点。
 *
 * L1 蒸馏已经把新记忆写进事实源了;此时若凭证写失败还向上抛,等于让一个
 * 「记录决策」的附属动作把「产生记忆」的主流程打死——代价与收益完全不成比例。
 * 故此处只记 warn,永不抛出。
 */
export declare function persistReceiptsSafely(write: ReceiptWriter, rows: readonly L1Receipt[], logger?: {
    warn: (msg: string) => void;
}): void;
