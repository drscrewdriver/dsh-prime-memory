/**
 * §C 矛盾冻结:待裁决冲突对(pending conflict pairs)。
 *
 * 语义承自 mneme 的 dream layer:*"the dream layer does **NOT** auto-adjudicate
 * winner/loser — the conflicting pair is parked here until a human reviews it."*
 * ——冻结**不是"拦住写入"**,而是"不自动裁决":新记忆照常入 L1,与冲突的旧记忆
 * 作为**一对**停放在 `conflict_pending`,双方内容都不被改写,直到人工裁决。
 *
 * 与 §B 的关系:冻结产生的裁决结果需要凭证链才能审计——`run_id` 直接沿用该轮
 * L1 蒸馏的 `runId`,故一条待裁决对被 `memory_receipts(run_id)` 一查即可看到
 * 「这一轮到底判了什么」(findings.md §3 / §9)。
 *
 * 本文件承载契约中最纯的那一半:pair_id 的构造。
 */
import { inputDigest } from './receipts.js';
/** 冻结对的格式版本。进入 pair_id 的摘要输入,使算法演进时不会静默让新旧 id 混同。 */
export const CONFLICT_FORMAT = 'c-conflict-pending/v1';
/**
 * 冻结对的稳定 id。
 *
 * **确定性**是刻意的:`runId + winner + loser` 三元组恒产同一 pair_id,
 * 于是同一轮重复落盘被 `INSERT OR IGNORE` 吃掉——幂等来自**主键**而非调用方自觉。
 * 沿用 §B 的 `receiptIdFor` 手法(同一哈希、同一长度前缀编码),不另造一套。
 */
export function conflictPairId(runId, winnerId, loserId) {
    return inputDigest([CONFLICT_FORMAT, runId, winnerId, loserId]);
}
/** 丢弃留痕的格式版本(进 `reject_id` 的摘要输入,算法演进时不静默混同新旧 id)。 */
export const REJECT_FORMAT = 'c-conflict-rejected/v1';
/**
 * 丢弃留痕的稳定 id。
 *
 * 幂等来自**主键**而非调用方自觉(与 `conflictPairId` 同款手法、同一哈希)。
 * 输入**刻意不含 `reason`**:同一条决策被丢的原因可能随代码演进改变,但
 * 「哪一条决策被丢了」是同一件事——含 reason 会让同一条决策在演进后落成两行,
 * 审计看到的是重复的债。
 */
export function conflictRejectId(runId, recordId, winner, loser) {
    return inputDigest([REJECT_FORMAT, runId, recordId, String(winner), String(loser)]);
}
/** 未裁决时 `resolved_at` / `resolution` 的取值(空串,不用 NULL)。 */
export const CONFLICT_UNRESOLVED = '';
/**
 * R1:复看次数上限(task_2.3)。
 *
 * 达上限的对**不再被超时自动了结**(见 `listConflictPending` 的 `excludeDeferExhausted`),
 * 其唯一出口是人工裁决。这是 spec「有界性的降级声明」里那半个代价:
 * 钉子户会持续占用 `maxPending` 额度,故**必须 fail-loud 呈现**(pipeline 的 warn +
 * 读取面的 `review_state`)——静默回落等于冻结在这一路径上失效。
 */
export const DEFER_MAX = 3;
/** 三枚举的**唯一**清单:校验、SQL 过滤、测试断言共用一份,防止三处各写各的。 */
export const CONFLICT_TYPES = ['hard', 'conditional', 'supersession'];
/** 归一失败时的落点(也是列默认值与旧库回填值)。 */
export const DEFAULT_CONFLICT_TYPE = 'hard';
/**
 * fail-closed 归一 `conflict_type`(task_3.2)。
 *
 * 非字符串 / 缺失 / 空白 / 不在三枚举内 → `'hard'`。**绝不抛错、也绝不因此丢弃
 * 整条 conflict 决策**:类型是辅助轴,让它有权否决主轴(配对)是本末倒置。
 */
export function normalizeConflictType(v) {
    if (typeof v !== 'string')
        return DEFAULT_CONFLICT_TYPE;
    const s = v.trim();
    return CONFLICT_TYPES.includes(s) ? s : DEFAULT_CONFLICT_TYPE;
}
/**
 * fail-closed 归一 `claim_key`(第 3 轴)。
 *
 * 非字符串 / 缺失 → `''`(空键 = 未分组),并 `trim`。**空键不阻断配对**:
 * 「同一主题的多对冲突归并成一组」是读取面的便利,不是裁决的前提。
 */
export function normalizeClaimKey(v) {
    return typeof v === 'string' ? v.trim() : '';
}
/**
 * Phase 3(task_3.4):这条冲突**占不占**待裁决队列的额度。
 *
 * 只有 `hard` 占:另外两类是「前提不同」与「新旧取代」,消耗的是存储而不是人的
 * 注意力预算(见 config.ts 的有界性契约)。
 *
 * 抽成纯函数**只为可测**:这条判据原本是 `runExtraction` 里的一个复合条件,而管线
 * 端到端需要可注入 LLM 的夹具(本项目没有),藏在分支里就等于没有护栏。
 */
export function occupiesConflictQuota(conflictType) {
    return conflictType === DEFAULT_CONFLICT_TYPE;
}
/**
 * Phase 3(task_3.4):本轮为止的 **hard** 未裁决数 = 库内 hard 未裁决数 + 本轮已停放
 * 且**未被自动了结**的 hard 对数。
 *
 * 为什么必须带上"本轮已停放"这一半:同一轮里多条冲突连续停放时,只数库内的值会让
 * 它们一起越过上限(既有注释里的 `frozen` 项就是这个意思)。
 * 未裁决判据用 `resolvedAt === ''`:被自动了结的对写的是 `resolution='auto'` +
 * 非空 `resolved_at`,它们不进队列额度。
 */
export function pendingHardTotal(dbHardUnresolved, frozenThisRound) {
    return (dbHardUnresolved +
        frozenThisRound.filter((p) => p.resolvedAt === '' && occupiesConflictQuota(normalizeConflictType(p.conflictType)))
            .length);
}
/**
 * 按 `claim_key` 把待裁决对归并成组(task_3.3)。
 *
 * 纯函数、无 I/O:分组是**读取面的便利**,不是新的状态——故它不进库、不进快照哈希,
 * 只从既有行派生。定序刻意确定:组间按 key 升序、空键那组**排最后**
 * (人先看有主题的),组内按 `pair_id` 升序。
 */
export function groupConflictPairsByClaim(pairs) {
    const byKey = new Map();
    for (const p of pairs) {
        const key = normalizeClaimKey(p.claimKey);
        const list = byKey.get(key) ?? [];
        // 组内按 pair_id 去重:同一条对若从两条读取路径汇进来,不得让"这一组"虚胖
        if (!list.some((x) => x.pairId === p.pairId))
            list.push(p);
        byKey.set(key, list);
    }
    return [...byKey.entries()]
        .sort(([a], [b]) => {
        if (a === b)
            return 0;
        if (a === '')
            return 1;
        if (b === '')
            return -1;
        return a < b ? -1 : 1;
    })
        .map(([claimKey, list]) => ({
        claimKey,
        pairs: [...list].sort((x, y) => (x.pairId < y.pairId ? -1 : x.pairId > y.pairId ? 1 : 0)),
    }));
}
/** 由输入构造一行待裁决冲突对(未裁决态)。纯函数,无 I/O。 */
export function buildConflictPair(input) {
    const pair = {
        pairId: conflictPairId(input.runId, input.winnerId, input.loserId),
        runId: input.runId,
        winnerId: input.winnerId,
        loserId: input.loserId,
        createdAt: input.createdAt,
        resolvedAt: CONFLICT_UNRESOLVED,
        resolution: CONFLICT_UNRESOLVED,
    };
    // Phase 3(task_3.2):两轴**只在有值时写键**。无条件写 `conflictType:'hard'` 会让
    // 三处测试工厂的精确断言凭空多出字段(与 N4 同类);库里那两列的默认值本就是
    // 'hard' / '',"没传"与"传了默认值"在磁盘上是同一行,差异只该活在这一层。
    if (input.conflictType !== undefined)
        pair.conflictType = input.conflictType;
    if (input.claimKey !== undefined)
        pair.claimKey = input.claimKey;
    return pair;
}
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
export function validateConflictPair(recordId, winner, loser, knownIds, 
/** 本批次其它新记忆的 record_id(同批次互斥也可冻结)。不传 = 维持旧行为。 */
batchIds) {
    if (typeof winner !== 'string' || typeof loser !== 'string')
        return null;
    const w = winner.trim();
    const l = loser.trim();
    if (!w || !l || w === l)
        return null;
    // ③ 恰有一方是本条新记忆(另一方必然是别的 id,因为 w !== l)
    const other = w === recordId ? l : l === recordId ? w : '';
    if (!other)
        return null;
    if (!knownIds.has(other) && !batchIds?.has(other))
        return null;
    return { winnerId: w, loserId: l };
}
