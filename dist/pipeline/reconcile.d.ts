/**
 * 核对器(R1/R2)——把一条 L1 记忆拿到它自己的**来源原文**面前对质,给出三态判定。
 *
 * ## 只读边界(硬约束)
 * 本模块**绝不写 L1**。它的依赖面里没有任何写接口:`deps.evidence` 只能读原文,
 * `deps.judge` 只能产文本。判定结果只出现在内存结构与 Markdown 报告里。
 * 任何"要不要改记忆库"的决定都不在这里——那是 Phase 4 的裁决面板 + 人工二次确认。
 *
 * ## 三个状态,以及它们**不能**互相冒充
 * - `supported`   —— 原文支持这条记忆
 * - `contradicted`—— 原文与这条记忆冲突
 * - `unverifiable`—— 取不到证据 / 证据不足 / 模型没给出可核对的原文依据
 *
 * **证据缺失一律 `unverifiable`,永不 `contradicted`。** 理由不是保守,是防假阳性:
 * 本机实测 **85/391 会话已归档**(索引侧 0 行),其中 **21 个日志真的没了**——把
 * "读不到"当成"没谈过",会把这批记忆批量判成与原文冲突。**假阳性比漏检更糟**:
 * 漏检只是没查出来,假阳性会让人去"修正"一条本来正确的记忆。
 *
 * ## 反幻觉闸门(本模块的核心防线)
 * 模型必须给出 `quote`(原文片段),且该片段**必须真的出现在证据文本里**(空白归一
 * 后比对)。核不上 → **降级为 `unverifiable`**,不管模型自称 supported 还是
 * contradicted。"判定不落地就不算判定"——这是唯一能挡住"模型编一段原文来支持
 * 自己结论"的机制。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { ConversationAnchor, MemoryLogger } from '../types.js';
import type { EvidenceEvent, EvidenceFailure, EvidenceSource } from '../store/evidence-source.js';
/** 三态判定。顺序即优先级(报告与面板按此排序)。 */
export declare const RECONCILE_STATES: readonly ["contradicted", "supported", "unverifiable"];
export type ReconcileState = (typeof RECONCILE_STATES)[number];
/** 一条待核对的记忆(只取核对需要的字段,不与存储层耦合)。 */
export interface ReconcileInput {
    id: string;
    text: string;
    sourceAnchors?: readonly ConversationAnchor[];
}
/** 一条记忆的核对结果。 */
export interface MemoryVerdict {
    memoryId: string;
    /** 记忆原文(报告里要能对照着看,不能只给 id)。 */
    text: string;
    state: ReconcileState;
    /** 判定理由(模型给出的,或本地降级原因)。 */
    reason: string;
    anchors: readonly ConversationAnchor[];
    /** 模型给出**且已在证据中核实**的原文片段;核不上时为 undefined。 */
    quote?: string;
    /** 证据侧失败原因(有值时 state 必为 unverifiable)。 */
    skipped?: EvidenceFailure;
    /** 实际取证的会话 id 形态。 */
    sessionId?: string;
    /** 取到的证据条数。 */
    eventCount: number;
}
/** 核对器的依赖面——**只有读**。 */
export interface ReconcileDeps {
    evidence: EvidenceSource;
    /** 把 prompt 交给模型,返回原始文本。单测里可注入假的。 */
    judge: (prompt: {
        system: string;
        user: string;
    }) => Promise<string>;
    logger?: MemoryLogger;
}
export interface ReconcileOptions {
    /** 最多核对多少条(成本闸门的第一道;完整闸门见 task_9)。 */
    maxRecords?: number;
    /** 单条记忆允许塞进 prompt 的证据文本上限。 */
    maxEvidenceChars?: number;
    signal?: AbortSignal;
    /** 进度回调(面板/CLI 用)。 */
    onProgress?: (done: number, total: number, verdict: MemoryVerdict) => void;
}
/**
 * 证据失败 → 一律 `unverifiable`。
 *
 * 这个函数短到看起来没必要,但它把一条**不该被改写的规则**变成了可测对象:
 * 任何人都能一眼看到这里没有 `contradicted` 分支。
 */
export declare function evidenceFailureToState(_reason: EvidenceFailure): ReconcileState;
/** 空白归一:比对引文时忽略换行/空格差异(模型几乎不会逐字复现排版)。 */
export declare function normalizeForCompare(text: string): string;
/**
 * 引文是否真的在证据里。
 *
 * 这是反幻觉闸门的判定核心:模型返回的 `quote` 必须能在**提供给它的证据文本**
 * 里找到。找不到就说明它没在核对证据,而是在生成一段听起来像原文的话。
 */
export declare function quoteIsGrounded(quote: string, evidenceTexts: readonly string[]): boolean;
/** 组装核对 prompt。 */
export declare function buildReconcilePrompt(memory: ReconcileInput, events: readonly EvidenceEvent[], maxEvidenceChars: number): {
    system: string;
    user: string;
};
/**
 * 解析模型输出并施加反幻觉闸门。
 *
 * 任何异常路径(解析失败、状态非法、引文核不上)**都落到 `unverifiable`**——
 * 绝不因为"模型说了 contradicted"就把一条记忆判成冲突。
 */
export declare function parseVerdict(raw: string, evidenceTexts: readonly string[], logger?: MemoryLogger): {
    state: ReconcileState;
    reason: string;
    quote?: string;
};
/** 核对一条记忆(只读)。 */
export declare function reconcileMemory(deps: ReconcileDeps, memory: ReconcileInput, opts?: {
    maxEvidenceChars?: number;
}): Promise<MemoryVerdict>;
/**
 * 批量核对并产出报告(只读)。
 *
 * @returns 每条记忆的判定 + Markdown 报告文本 + 按状态的计数。
 */
export declare function runReconcile(deps: ReconcileDeps, memories: readonly ReconcileInput[], opts?: ReconcileOptions): Promise<{
    verdicts: MemoryVerdict[];
    report: string;
    counts: Record<ReconcileState, number>;
}>;
/**
 * 渲染 Markdown 报告。
 *
 * **跳过原因必须分开计数**:`确实没谈过` 与 `读不到` 是两件事,合并计数会让人把
 * "取不到证据"读成"这条记忆没有依据"。
 */
export declare function renderReport(verdicts: readonly MemoryVerdict[], counts: Record<ReconcileState, number>, totalInput: number, maxRecords: number): string;
/**
 * 用真实模型建 judge(生产装配用)。
 *
 * 单测注入假 judge;这里只做"把 prompt 转成模型调用"这一件事。
 */
export declare function makeModelJudge(ctx: Context, cfg: MemoryConfig, logger?: MemoryLogger): (prompt: {
    system: string;
    user: string;
}) => Promise<string>;
