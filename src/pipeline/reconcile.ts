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
import { callLLM, parseJson } from '../llm.js';
import type { ConversationAnchor, MemoryLogger } from '../types.js';
import type { EvidenceEvent, EvidenceFailure, EvidenceSource } from '../store/evidence-source.js';

/** 三态判定。顺序即优先级(报告与面板按此排序)。 */
export const RECONCILE_STATES = ['contradicted', 'supported', 'unverifiable'] as const;
export type ReconcileState = (typeof RECONCILE_STATES)[number];

/** 一条待核对的记忆(只取核对需要的字段,不与存储层耦合)。 */
export interface ReconcileInput {
  id: string
  text: string
  sourceAnchors?: readonly ConversationAnchor[]
}

/** 一条记忆的核对结果。 */
export interface MemoryVerdict {
  memoryId: string
  /** 记忆原文(报告里要能对照着看,不能只给 id)。 */
  text: string
  state: ReconcileState
  /** 判定理由(模型给出的,或本地降级原因)。 */
  reason: string
  anchors: readonly ConversationAnchor[]
  /** 模型给出**且已在证据中核实**的原文片段;核不上时为 undefined。 */
  quote?: string
  /** 证据侧失败原因(有值时 state 必为 unverifiable)。 */
  skipped?: EvidenceFailure
  /** 实际取证的会话 id 形态。 */
  sessionId?: string
  /** 取到的证据条数。 */
  eventCount: number
}

/** 核对器的依赖面——**只有读**。 */
export interface ReconcileDeps {
  evidence: EvidenceSource
  /** 把 prompt 交给模型,返回原始文本。单测里可注入假的。 */
  judge: (prompt: { system: string; user: string }) => Promise<string>
  logger?: MemoryLogger
}

export interface ReconcileOptions {
  /** 最多核对多少条(成本闸门的第一道;完整闸门见 task_9)。 */
  maxRecords?: number
  /** 单条记忆允许塞进 prompt 的证据文本上限。 */
  maxEvidenceChars?: number
  signal?: AbortSignal
  /** 进度回调(面板/CLI 用)。 */
  onProgress?: (done: number, total: number, verdict: MemoryVerdict) => void
}

const DEFAULT_MAX_RECORDS = 50;
const DEFAULT_MAX_EVIDENCE_CHARS = 12_000;

/**
 * 证据失败 → 一律 `unverifiable`。
 *
 * 这个函数短到看起来没必要,但它把一条**不该被改写的规则**变成了可测对象:
 * 任何人都能一眼看到这里没有 `contradicted` 分支。
 */
export function evidenceFailureToState(_reason: EvidenceFailure): ReconcileState {
  return 'unverifiable';
}

/** 空白归一:比对引文时忽略换行/空格差异(模型几乎不会逐字复现排版)。 */
export function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 引文是否真的在证据里。
 *
 * 这是反幻觉闸门的判定核心:模型返回的 `quote` 必须能在**提供给它的证据文本**
 * 里找到。找不到就说明它没在核对证据,而是在生成一段听起来像原文的话。
 */
export function quoteIsGrounded(quote: string, evidenceTexts: readonly string[]): boolean {
  const needle = normalizeForCompare(quote);
  // 太短的引文没有证明力("的"、"the" 之类遍地都是),一律不算落地
  if (needle.length < 4) return false;
  return evidenceTexts.some((text) => normalizeForCompare(text).includes(needle));
}

/** 组装核对 prompt。 */
export function buildReconcilePrompt(
  memory: ReconcileInput,
  events: readonly EvidenceEvent[],
  maxEvidenceChars: number,
): { system: string; user: string } {
  const lines: string[] = [];
  let used = 0;
  for (const event of events) {
    const where = `t${event.turn ?? '?'}${event.step === undefined ? '' : ` s${event.step}`}`;
    const line = `[${where} ${event.type} #${event.seq}] ${event.text}`;
    if (used + line.length > maxEvidenceChars) {
      lines.push('...(证据超长,后续条目已截断)');
      break;
    }
    used += line.length;
    lines.push(line);
  }
  const system = [
    '你是一个记忆核对员。给你一条「记忆」和它在会话里的「原文证据」,判断这条记忆是否与原文相符。',
    '',
    '只输出一个 JSON 对象,不要解释、不要 Markdown 代码块:',
    '{"state": "supported|contradicted|unverifiable", "reason": "一句话理由", "quote": "支撑你判断的原文片段"}',
    '',
    '规则:',
    '- supported:原文明确支持这条记忆。',
    '- contradicted:原文明确与这条记忆冲突。**只有当你确信冲突时才用它。**',
    '- unverifiable:证据不足以判断、证据与记忆无关、或原文本身含糊。',
    '- quote 必须**逐字**来自上面的证据文本。核不上会被判为 unverifiable。',
    '- 拿不准就选 unverifiable。**不要猜。**',
  ].join('\n');
  const user = [
    `记忆:${memory.text}`,
    '',
    '原文证据:',
    lines.length === 0 ? '(空)' : lines.join('\n'),
  ].join('\n');
  return { system, user };
}

/**
 * 解析模型输出并施加反幻觉闸门。
 *
 * 任何异常路径(解析失败、状态非法、引文核不上)**都落到 `unverifiable`**——
 * 绝不因为"模型说了 contradicted"就把一条记忆判成冲突。
 */
export function parseVerdict(
  raw: string,
  evidenceTexts: readonly string[],
  logger?: MemoryLogger,
): { state: ReconcileState; reason: string; quote?: string } {
  let parsed: { state?: unknown; reason?: unknown; quote?: unknown };
  try {
    parsed = parseJson<{ state?: unknown; reason?: unknown; quote?: unknown }>(raw);
  } catch {
    logger?.warn?.('[memory] 核对输出不是 JSON,降级为 unverifiable');
    return { state: 'unverifiable', reason: '模型输出无法解析为 JSON' };
  }
  const state = typeof parsed.state === 'string' ? parsed.state.trim() : '';
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
  const quote = typeof parsed.quote === 'string' ? parsed.quote.trim() : '';

  if (!(RECONCILE_STATES as readonly string[]).includes(state)) {
    return { state: 'unverifiable', reason: reason === '' ? `未知状态:${state || '(空)'}` : reason };
  }
  // 闸门:声称 supported/contradicted 就必须拿出**可核对的**原文依据
  if (state !== 'unverifiable' && !quoteIsGrounded(quote, evidenceTexts)) {
    return {
      state: 'unverifiable',
      reason: `模型给出 ${state},但引文无法在证据中核实(反幻觉闸门拦截)`,
    };
  }
  const out: { state: ReconcileState; reason: string; quote?: string } = {
    state: state as ReconcileState,
    reason,
  };
  if (quote !== '' && state !== 'unverifiable') out.quote = quote;
  return out;
}

/** 核对一条记忆(只读)。 */
export async function reconcileMemory(
  deps: ReconcileDeps,
  memory: ReconcileInput,
  opts: { maxEvidenceChars?: number } = {},
): Promise<MemoryVerdict> {
  const maxEvidenceChars = opts.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS;
  const anchors = memory.sourceAnchors ?? [];
  const base = { memoryId: memory.id, text: memory.text, anchors };

  if (anchors.length === 0) {
    // 改造前的老记忆没有坐标。**不猜**——猜一条会话出来对质,比不核对更糟。
    const skipped = evidenceFailureToState('no-anchor');
    return { ...base, state: skipped, reason: '这条记忆没有来源锚点,无法定位原文', skipped: 'no-anchor', eventCount: 0 };
  }

  const sessionId = anchors[0]?.sessionId ?? '';
  const result = await deps.evidence.byAnchors({ sessionId, anchors, maxChars: maxEvidenceChars });
  if (!result.ok) {
    return {
      ...base,
      state: evidenceFailureToState(result.reason),
      reason: `取不到原文证据(${result.reason})${result.detail === undefined ? '' : `:${result.detail}`}`,
      skipped: result.reason,
      eventCount: 0,
    };
  }

  const events = result.slice.events;
  if (events.length === 0) {
    return {
      ...base,
      state: 'unverifiable',
      reason: '锚点定位到了会话,但没有取到任何证据文本',
      eventCount: 0,
    };
  }

  const prompt = buildReconcilePrompt(memory, events, maxEvidenceChars);
  let raw: string;
  try {
    raw = await deps.judge(prompt);
  } catch (err) {
    return {
      ...base,
      state: 'unverifiable',
      reason: `模型调用失败:${err instanceof Error ? err.message : String(err)}`,
      sessionId: result.slice.sessionId,
      eventCount: events.length,
    };
  }

  const verdict = parseVerdict(raw, events.map((e) => e.text), deps.logger);
  const out: MemoryVerdict = {
    ...base,
    state: verdict.state,
    reason: verdict.reason,
    sessionId: result.slice.sessionId,
    eventCount: events.length,
  };
  if (verdict.quote !== undefined) out.quote = verdict.quote;
  return out;
}

/**
 * 批量核对并产出报告(只读)。
 *
 * @returns 每条记忆的判定 + Markdown 报告文本 + 按状态的计数。
 */
export async function runReconcile(
  deps: ReconcileDeps,
  memories: readonly ReconcileInput[],
  opts: ReconcileOptions = {},
): Promise<{ verdicts: MemoryVerdict[]; report: string; counts: Record<ReconcileState, number> }> {
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_RECORDS;
  const selected = memories.slice(0, maxRecords);
  const verdicts: MemoryVerdict[] = [];
  for (const memory of selected) {
    if (opts.signal?.aborted === true) break;
    const verdict = await reconcileMemory(deps, memory, { maxEvidenceChars: opts.maxEvidenceChars });
    verdicts.push(verdict);
    opts.onProgress?.(verdicts.length, selected.length, verdict);
  }
  const counts: Record<ReconcileState, number> = { contradicted: 0, supported: 0, unverifiable: 0 };
  for (const verdict of verdicts) counts[verdict.state] += 1;
  return { verdicts, report: renderReport(verdicts, counts, memories.length, maxRecords), counts };
}

function formatAnchor(anchor: ConversationAnchor): string {
  return anchor.step === undefined ? `t${anchor.turn}` : `t${anchor.turn} s${anchor.step}`;
}

/**
 * 渲染 Markdown 报告。
 *
 * **跳过原因必须分开计数**:`确实没谈过` 与 `读不到` 是两件事,合并计数会让人把
 * "取不到证据"读成"这条记忆没有依据"。
 */
export function renderReport(
  verdicts: readonly MemoryVerdict[],
  counts: Record<ReconcileState, number>,
  totalInput: number,
  maxRecords: number,
): string {
  const skipped = new Map<string, number>();
  for (const verdict of verdicts) {
    if (verdict.skipped === undefined) continue;
    skipped.set(verdict.skipped, (skipped.get(verdict.skipped) ?? 0) + 1);
  }

  const out: string[] = [];
  out.push('# 记忆核对报告');
  out.push('');
  out.push(`- 输入记忆:${totalInput} 条(本次核对 ${verdicts.length} 条,上限 ${maxRecords})`);
  out.push(`- 与原文冲突(**需人工确认**):**${counts.contradicted}**`);
  out.push(`- 原文支持:${counts.supported}`);
  out.push(`- 无法判定:${counts.unverifiable}`);
  out.push('');
  out.push('> 本报告**只读**产出,不对记忆库做任何改动。是否修正由人工在裁决面板确认。');
  out.push('');

  if (skipped.size > 0) {
    out.push('## 跳过原因分布(未取到证据,内存一律保留)');
    out.push('');
    out.push('| 原因 | 条数 | 含义 |');
    out.push('|---|---|---|');
    const meaning: Record<string, string> = {
      'no-anchor': '这条记忆没有来源锚点(改造前的老记忆)',
      'no-service': '宿主未挂载 sessionQuery,取证能力不可用',
      'session-unreadable': '会话日志已不存在(归档后被清理)',
      'anchor-not-found': '会话读到了,但该轮次没有记录',
      timeout: '取证超时',
      error: '取证过程出错',
    };
    for (const [reason, count] of [...skipped.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`| \`${reason}\` | ${count} | ${meaning[reason] ?? '—'} |`);
    }
    out.push('');
    out.push('> 这些条目**不是**"与原文不符",只是**这次取不到原文**。');
    out.push('');
  }

  out.push('## 逐条判定');
  out.push('');
  for (const verdict of verdicts) {
    const anchors = verdict.anchors.length === 0 ? '(无锚点)' : verdict.anchors.map(formatAnchor).join(', ');
    out.push(`### \`${verdict.memoryId}\` — ${verdict.state}`);
    out.push('');
    out.push(`- 记忆:${verdict.text}`);
    out.push(`- 锚点:${anchors}${verdict.sessionId === undefined ? '' : `(会话 \`${verdict.sessionId}\`)`}`);
    out.push(`- 证据条数:${verdict.eventCount}`);
    out.push(`- 理由:${verdict.reason}`);
    if (verdict.quote !== undefined) out.push(`- 原文片段:> ${verdict.quote}`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * 用真实模型建 judge(生产装配用)。
 *
 * 单测注入假 judge;这里只做"把 prompt 转成模型调用"这一件事。
 */
export function makeModelJudge(ctx: Context, cfg: MemoryConfig, logger?: MemoryLogger) {
  return async (prompt: { system: string; user: string }): Promise<string> =>
    callLLM(ctx, cfg, {
      system: prompt.system,
      user: prompt.user,
      // 核对不是蒸馏层,借用抽取档的 token 预算(输出只有一个短 JSON)
      maxTokens: 1024,
      temperature: 0,
      logger,
    });
}
