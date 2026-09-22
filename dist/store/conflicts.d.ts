/** 冻结对的格式版本。进入 pair_id 的摘要输入,使算法演进时不会静默让新旧 id 混同。 */
export declare const CONFLICT_FORMAT = "c-conflict-pending/v1";
/**
 * 冻结对的稳定 id。
 *
 * **确定性**是刻意的:`runId + winner + loser` 三元组恒产同一 pair_id,
 * 于是同一轮重复落盘被 `INSERT OR IGNORE` 吃掉——幂等来自**主键**而非调用方自觉。
 * 沿用 §B 的 `receiptIdFor` 手法(同一哈希、同一长度前缀编码),不另造一套。
 */
export declare function conflictPairId(runId: string, winnerId: string, loserId: string): string;
/** 丢弃留痕的格式版本(进 `reject_id` 的摘要输入,算法演进时不静默混同新旧 id)。 */
export declare const REJECT_FORMAT = "c-conflict-rejected/v1";
/**
 * 丢弃原因。当前**只有**一种:`validateConflictPair` 返回 `null`(配不成对)。
 *
 * 曾并列的 `'freeze-off'` 已删除:关闭态**不落痕**(结构性不可达),该取值永不写入,
 * 留着它就是一条会误导读者的死枚举(审计 S2)。
 */
export type ConflictRejectReason = 'not-pair';
/**
 * 丢弃留痕的稳定 id。
 *
 * 幂等来自**主键**而非调用方自觉(与 `conflictPairId` 同款手法、同一哈希)。
 * 输入**刻意不含 `reason`**:同一条决策被丢的原因可能随代码演进改变,但
 * 「哪一条决策被丢了」是同一件事——含 reason 会让同一条决策在演进后落成两行,
 * 审计看到的是重复的债。
 */
export declare function conflictRejectId(runId: string, recordId: string, winner: unknown, loser: unknown): string;
/**
 * 一条被丢弃的 conflict 决策(`conflict_rejected` 表一行)。
 *
 * 存的是 LLM 的**原始输出**(`winnerRaw` / `loserRaw`):被丢的决策往往正是
 * 因为那两个值不合法,存规范化后的值会把「为什么被丢」这件事抹掉。
 */
export interface ConflictRejected {
    rejectId: string;
    runId: string;
    recordId: string;
    winnerRaw: string;
    loserRaw: string;
    reason: ConflictRejectReason;
    createdAt: string;
}
/**
 * 裁决结论。
 * - `winner` / `loser`:人工判定哪一方为真(另一方从检索库退场);
 * - `both`:两条都保留——人工判定它们其实是**各自独立的事实**,不是矛盾
 *   (LLM 判错的情形,必须有出口,否则只能被迫删掉一条正确记忆);
 * - `auto`:**机器**按 LLM 给出的 winner/loser 自行了结(task_24 安全阀:
 *   队列满或超时)。刻意与人工取值分开——§C 存在的理由就是"机器不该替人裁决",
 *   若自动了结在人眼里与人工结论无从区分,那个行为会以"悄悄发生"的形式回来。
 * - `defer`(R1,task_2.2):**不是结论**——"我看了,但判不了"。它不进本枚举的
 *   "已裁决"语义:写的是 `reviewed_at`/`deferred_at`/`defer_count`,**不写** `resolved_at`,
 *   该对**留在待裁决队列**里。放进 `resolution` 列会污染"已裁决"的判据
 *   (`resolved_at = ''`),故它只作为**入参取值**存在。
 */
export type ConflictResolution = 'winner' | 'loser' | 'both' | 'auto' | 'defer';
/** 未裁决时 `resolved_at` / `resolution` 的取值(空串,不用 NULL)。 */
export declare const CONFLICT_UNRESOLVED = "";
/**
 * R1:复看次数上限(task_2.3)。
 *
 * 达上限的对**不再被超时自动了结**(见 `listConflictPending` 的 `excludeDeferExhausted`),
 * 其唯一出口是人工裁决。这是 spec「有界性的降级声明」里那半个代价:
 * 钉子户会持续占用 `maxPending` 额度,故**必须 fail-loud 呈现**(pipeline 的 warn +
 * 读取面的 `review_state`)——静默回落等于冻结在这一路径上失效。
 */
export declare const DEFER_MAX = 3;
/**
 * §C Phase 3(task_3.2):冲突的**类型**轴(第 2 轴)。
 *
 * - `hard`:事实层面直接互斥(默认,拿不准一律落这里);
 * - `conditional`:各自前提不同才显得矛盾(环境 / 配置 / 工作区);
 * - `supersession`:新旧取代(旧的在更强证据下让位,但**仍不自动裁决**)。
 *
 * 语义上只有 `hard` 占待裁决队列的额度(task_3.4):另外两类消耗的是存储,
 * 不是人的注意力预算。
 */
export type ConflictType = 'hard' | 'conditional' | 'supersession';
/** 三枚举的**唯一**清单:校验、SQL 过滤、测试断言共用一份,防止三处各写各的。 */
export declare const CONFLICT_TYPES: readonly ConflictType[];
/** 归一失败时的落点(也是列默认值与旧库回填值)。 */
export declare const DEFAULT_CONFLICT_TYPE: ConflictType;
/**
 * fail-closed 归一 `conflict_type`(task_3.2)。
 *
 * 非字符串 / 缺失 / 空白 / 不在三枚举内 → `'hard'`。**绝不抛错、也绝不因此丢弃
 * 整条 conflict 决策**:类型是辅助轴,让它有权否决主轴(配对)是本末倒置。
 */
export declare function normalizeConflictType(v: unknown): ConflictType;
/**
 * fail-closed 归一 `claim_key`(第 3 轴)。
 *
 * 非字符串 / 缺失 → `''`(空键 = 未分组),并 `trim`。**空键不阻断配对**:
 * 「同一主题的多对冲突归并成一组」是读取面的便利,不是裁决的前提。
 */
export declare function normalizeClaimKey(v: unknown): string;
/**
 * Phase 3(task_3.4):这条冲突**占不占**待裁决队列的额度。
 *
 * 只有 `hard` 占:另外两类是「前提不同」与「新旧取代」,消耗的是存储而不是人的
 * 注意力预算(见 config.ts 的有界性契约)。
 *
 * 抽成纯函数**只为可测**:这条判据原本是 `runExtraction` 里的一个复合条件,而管线
 * 端到端需要可注入 LLM 的夹具(本项目没有),藏在分支里就等于没有护栏。
 */
export declare function occupiesConflictQuota(conflictType: ConflictType): boolean;
/**
 * Phase 3(task_3.4):本轮为止的 **hard** 未裁决数 = 库内 hard 未裁决数 + 本轮已停放
 * 且**未被自动了结**的 hard 对数。
 *
 * 为什么必须带上"本轮已停放"这一半:同一轮里多条冲突连续停放时,只数库内的值会让
 * 它们一起越过上限(既有注释里的 `frozen` 项就是这个意思)。
 * 未裁决判据用 `resolvedAt === ''`:被自动了结的对写的是 `resolution='auto'` +
 * 非空 `resolved_at`,它们不进队列额度。
 */
export declare function pendingHardTotal(dbHardUnresolved: number, frozenThisRound: readonly ConflictPair[]): number;
/** 按 `claim_key` 归并后的一组(task_3.3)。 */
export interface ConflictClaimGroup {
    /** 该组的 `claim_key`;**空串代表"未分组"那一组**(恒排在最后)。 */
    claimKey: string;
    /** 组内成员,按 `pair_id` 升序且**已按 pair_id 去重**。 */
    pairs: ConflictPair[];
}
/**
 * 按 `claim_key` 把待裁决对归并成组(task_3.3)。
 *
 * 纯函数、无 I/O:分组是**读取面的便利**,不是新的状态——故它不进库、不进快照哈希,
 * 只从既有行派生。定序刻意确定:组间按 key 升序、空键那组**排最后**
 * (人先看有主题的),组内按 `pair_id` 升序。
 */
export declare function groupConflictPairsByClaim(pairs: readonly ConflictPair[]): ConflictClaimGroup[];
/** 一条待裁决冲突对(与 `conflict_pending` 表一行同形)。 */
export interface ConflictPair {
    pairId: string;
    /** 产生该冻结的 L1 蒸馏批次 id(接 §B 凭证链)。 */
    runId: string;
    /** LLM 建议的胜方 id。**只是进入待裁决对时的排序位,不代表最终结论**。 */
    winnerId: string;
    /** LLM 建议的败方 id。同上。 */
    loserId: string;
    createdAt: string;
    /** 空串 = 未裁决。 */
    resolvedAt: string;
    /** 空串 = 未裁决;否则为 {@link ConflictResolution}。 */
    resolution: string;
    /**
     * R1 未决态(task_2.0):人工复看时刻。空串 = **没看过**(`unseen`)。
     *
     * **三字段一律可选 `?`**(审计 N4):必填会破三处测试工厂
     * (`conflict-list` / `conflict-freeze-safety` / `conflict-freeze-resolve`)的
     * `typecheck`。可选还顺带保证旧快照反序列化出的对象依然合法。
     */
    reviewedAt?: string;
    /** R1:最近一次 `defer` 的时刻。**超时基准 = `deferredAt ?? createdAt`**(task_2.3)。 */
    deferredAt?: string;
    /** R1:复看次数。达上限(task_2.3 取 3)后不再被 `auto` 了结,改为 fail-loud 呈现。 */
    deferCount?: number;
    /**
     * Phase 3(task_3.2/3.3):类型轴(第 2 轴)与 claim 键(第 3 轴)。
     *
     * 两个都**可选**:三处测试工厂手搓的对、以及旧快照反序列化出的对象都没有它们
     * (与审计 N4 同理由——必填会破 `typecheck`),读取面一律按 `?? 'hard'` / `?? ''` 兜底。
     */
    conflictType?: ConflictType;
    claimKey?: string;
}
/** 构建冻结对所需的输入。 */
export interface ConflictPairInput {
    runId: string;
    winnerId: string;
    loserId: string;
    createdAt: string;
    /** Phase 3:类型轴与 claim 键;省略时**不写键**(与 Phase 2 三列同样的审慎)。 */
    conflictType?: ConflictType;
    claimKey?: string;
}
/** 由输入构造一行待裁决冲突对(未裁决态)。纯函数,无 I/O。 */
export declare function buildConflictPair(input: ConflictPairInput): ConflictPair;
/**
 * 校验 LLM 给出的 conflict 决策是否**够得着一条冻结对**。
 *
 * 三条都必需,缺一即无法停放,调用方须回落 `store`(信息绝不丢):
 * ① winner / loser 都是非空 id;
 * ② 二者**不同**——指向同一条记录是无效输出(承自 mneme 的 `validateDecisions`);
 * ③ **恰有一方是本条新记忆**(`recordId`),另一方是**可核实的对手**:
 *    候选池里的已有记录(`knownIds`),**或同一批次里的另一条新记忆**(`batchIds`)。
 *
 * 关于 `batchIds`(2026-09-18 取证后放宽,见 findings R6 / Agent A):
 * 此前另一方只认 `knownIds`(候选池 ∪ target_ids),而**同批次新记忆的 id 不在其中**
 * ——它们是本轮刚生成的、尚未入库。于是"本轮两条新记忆互相矛盾"这种最典型的
 * "机器判不了"情形,模型即便正确 emit 了 `conflict`,也**必然被判不成对而回落 store**。
 * 实测:模型在生产 prompt 下对同批次矛盾 2/2 会 emit,但那一跳从未落库。
 *
 * 为何仍要求"恰有一方是 `recordId`":`conflict` 是**挂在某一条新记忆名下的决策**,
 * 若允许"另外两条新记忆"配对,同一对会被每个兄弟重复申报一次。锁定一方为本条,
 * 配对就唯一。
 *
 * 返回规范化后的 `{ winnerId, loserId }`,或 `null`(表示不构成冻结对)。
 */
export declare function validateConflictPair(recordId: string, winner: unknown, loser: unknown, knownIds: ReadonlySet<string>, 
/** 本批次其它新记忆的 record_id(同批次互斥也可冻结)。不传 = 维持旧行为。 */
batchIds?: ReadonlySet<string>): {
    winnerId: string;
    loserId: string;
} | null;
