import { callLLM, parseJson } from '../llm.js';
/** 三态判定。顺序即优先级(报告与面板按此排序)。 */
export const RECONCILE_STATES = ['contradicted', 'supported', 'unverifiable'];
const DEFAULT_MAX_RECORDS = 50;
const DEFAULT_MAX_EVIDENCE_CHARS = 12_000;
/**
 * 证据失败 → 一律 `unverifiable`。
 *
 * 这个函数短到看起来没必要,但它把一条**不该被改写的规则**变成了可测对象:
 * 任何人都能一眼看到这里没有 `contradicted` 分支。
 */
export function evidenceFailureToState(_reason) {
    return 'unverifiable';
}
/** 空白归一:比对引文时忽略换行/空格差异(模型几乎不会逐字复现排版)。 */
export function normalizeForCompare(text) {
    return text.replace(/\s+/g, ' ').trim();
}
/**
 * 引文是否真的在证据里。
 *
 * 这是反幻觉闸门的判定核心:模型返回的 `quote` 必须能在**提供给它的证据文本**
 * 里找到。找不到就说明它没在核对证据,而是在生成一段听起来像原文的话。
 */
export function quoteIsGrounded(quote, evidenceTexts) {
    const needle = normalizeForCompare(quote);
    // 太短的引文没有证明力("的"、"the" 之类遍地都是),一律不算落地
    if (needle.length < 4)
        return false;
    return evidenceTexts.some((text) => normalizeForCompare(text).includes(needle));
}
/** 组装核对 prompt。 */
export function buildReconcilePrompt(memory, events, maxEvidenceChars) {
    const lines = [];
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
export function parseVerdict(raw, evidenceTexts, logger) {
    let parsed;
    try {
        parsed = parseJson(raw);
    }
    catch {
        logger?.warn?.('[memory] 核对输出不是 JSON,降级为 unverifiable');
        return { state: 'unverifiable', reason: '模型输出无法解析为 JSON' };
    }
    const state = typeof parsed.state === 'string' ? parsed.state.trim() : '';
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    const quote = typeof parsed.quote === 'string' ? parsed.quote.trim() : '';
    if (!RECONCILE_STATES.includes(state)) {
        return { state: 'unverifiable', reason: reason === '' ? `未知状态:${state || '(空)'}` : reason };
    }
    // 闸门:声称 supported/contradicted 就必须拿出**可核对的**原文依据
    if (state !== 'unverifiable' && !quoteIsGrounded(quote, evidenceTexts)) {
        return {
            state: 'unverifiable',
            reason: `模型给出 ${state},但引文无法在证据中核实(反幻觉闸门拦截)`,
        };
    }
    const out = {
        state: state,
        reason,
    };
    if (quote !== '' && state !== 'unverifiable')
        out.quote = quote;
    return out;
}
/** 核对一条记忆(只读)。 */
export async function reconcileMemory(deps, memory, opts = {}) {
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
    let raw;
    try {
        raw = await deps.judge(prompt);
    }
    catch (err) {
        return {
            ...base,
            state: 'unverifiable',
            reason: `模型调用失败:${err instanceof Error ? err.message : String(err)}`,
            sessionId: result.slice.sessionId,
            eventCount: events.length,
        };
    }
    const verdict = parseVerdict(raw, events.map((e) => e.text), deps.logger);
    const out = {
        ...base,
        state: verdict.state,
        reason: verdict.reason,
        sessionId: result.slice.sessionId,
        eventCount: events.length,
    };
    if (verdict.quote !== undefined)
        out.quote = verdict.quote;
    return out;
}
/**
 * 批量核对并产出报告(只读)。
 *
 * @returns 每条记忆的判定 + Markdown 报告文本 + 按状态的计数。
 */
export async function runReconcile(deps, memories, opts = {}) {
    const maxRecords = opts.maxRecords ?? DEFAULT_MAX_RECORDS;
    const selected = memories.slice(0, maxRecords);
    const verdicts = [];
    for (const memory of selected) {
        if (opts.signal?.aborted === true)
            break;
        const verdict = await reconcileMemory(deps, memory, { maxEvidenceChars: opts.maxEvidenceChars });
        verdicts.push(verdict);
        opts.onProgress?.(verdicts.length, selected.length, verdict);
    }
    const counts = { contradicted: 0, supported: 0, unverifiable: 0 };
    for (const verdict of verdicts)
        counts[verdict.state] += 1;
    return { verdicts, report: renderReport(verdicts, counts, memories.length, maxRecords), counts };
}
function formatAnchor(anchor) {
    return anchor.step === undefined ? `t${anchor.turn}` : `t${anchor.turn} s${anchor.step}`;
}
/**
 * 渲染 Markdown 报告。
 *
 * **跳过原因必须分开计数**:`确实没谈过` 与 `读不到` 是两件事,合并计数会让人把
 * "取不到证据"读成"这条记忆没有依据"。
 */
export function renderReport(verdicts, counts, totalInput, maxRecords) {
    const skipped = new Map();
    for (const verdict of verdicts) {
        if (verdict.skipped === undefined)
            continue;
        skipped.set(verdict.skipped, (skipped.get(verdict.skipped) ?? 0) + 1);
    }
    const out = [];
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
        const meaning = {
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
        if (verdict.quote !== undefined)
            out.push(`- 原文片段:> ${verdict.quote}`);
        out.push('');
    }
    return out.join('\n');
}
/**
 * 用真实模型建 judge(生产装配用)。
 *
 * 单测注入假 judge;这里只做"把 prompt 转成模型调用"这一件事。
 */
export function makeModelJudge(ctx, cfg, logger) {
    return async (prompt) => callLLM(ctx, cfg, {
        system: prompt.system,
        user: prompt.user,
        // 核对不是蒸馏层,借用抽取档的 token 预算(输出只有一个短 JSON)
        maxTokens: 1024,
        temperature: 0,
        logger,
    });
}
