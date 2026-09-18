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
export function conflictPairId(runId: string, winnerId: string, loserId: string): string {
  return inputDigest([CONFLICT_FORMAT, runId, winnerId, loserId]);
}

/**
 * 裁决结论。
 * - `winner` / `loser`:人工判定哪一方为真(另一方从检索库退场);
 * - `both`:两条都保留——人工判定它们其实是**各自独立的事实**,不是矛盾
 *   (LLM 判错的情形,必须有出口,否则只能被迫删掉一条正确记忆);
 * - `auto`:**机器**按 LLM 给出的 winner/loser 自行了结(task_24 安全阀:
 *   队列满或超时)。刻意与人工取值分开——§C 存在的理由就是"机器不该替人裁决",
 *   若自动了结在人眼里与人工结论无从区分,那个行为会以"悄悄发生"的形式回来。
 */
export type ConflictResolution = 'winner' | 'loser' | 'both' | 'auto';

/** 未裁决时 `resolved_at` / `resolution` 的取值(空串,不用 NULL)。 */
export const CONFLICT_UNRESOLVED = '';

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
}

/** 构建冻结对所需的输入。 */
export interface ConflictPairInput {
  runId: string;
  winnerId: string;
  loserId: string;
  createdAt: string;
}

/** 由输入构造一行待裁决冲突对(未裁决态)。纯函数,无 I/O。 */
export function buildConflictPair(input: ConflictPairInput): ConflictPair {
  return {
    pairId: conflictPairId(input.runId, input.winnerId, input.loserId),
    runId: input.runId,
    winnerId: input.winnerId,
    loserId: input.loserId,
    createdAt: input.createdAt,
    resolvedAt: CONFLICT_UNRESOLVED,
    resolution: CONFLICT_UNRESOLVED,
  };
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
export function validateConflictPair(
  recordId: string,
  winner: unknown,
  loser: unknown,
  knownIds: ReadonlySet<string>,
  /** 本批次其它新记忆的 record_id(同批次互斥也可冻结)。不传 = 维持旧行为。 */
  batchIds?: ReadonlySet<string>,
): { winnerId: string; loserId: string } | null {
  if (typeof winner !== 'string' || typeof loser !== 'string') return null;
  const w = winner.trim();
  const l = loser.trim();
  if (!w || !l || w === l) return null;
  // ③ 恰有一方是本条新记忆(另一方必然是别的 id,因为 w !== l)
  const other = w === recordId ? l : l === recordId ? w : '';
  if (!other) return null;
  if (!knownIds.has(other) && !batchIds?.has(other)) return null;
  return { winnerId: w, loserId: l };
}
