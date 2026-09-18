import { blocksToText } from '../util/text.js';
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_MAX_CHARS = 40_000;
const DEFAULT_TIMEOUT_MS = 5_000;
/**
 * 会话 id 的**候选形态**。
 *
 * 实测(2026-09-17 全量扫描):索引 `sessions.session_id` 里有**两种形态**——
 * 带 `session-` 前缀 267 个、纯 uuid 124 个。**只试一种会静默漏掉 124 个会话**
 * (不报错,只是永远查不到)。故此处按"两种都试"处理,并保留调用方原值在首位。
 *
 * @param sessionId - 任意形态的会话 id。
 * @returns 去重后的候选列表,原值优先。
 */
export function sessionIdCandidates(sessionId) {
    const trimmed = sessionId.trim();
    if (trimmed === '')
        return [];
    const bare = trimmed.startsWith('session-') ? trimmed.slice('session-'.length) : trimmed;
    const prefixed = `session-${bare}`;
    const out = [];
    for (const candidate of [trimmed, prefixed, bare]) {
        if (candidate !== '' && !out.includes(candidate))
            out.push(candidate);
    }
    return out;
}
/** 从事件负载里取整数坐标;非有限数一律视为"没有"(绝不拿 0 顶替)。 */
function intOrUndefined(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function seqOf(event, fallback) {
    return intOrUndefined(event.seq) ?? fallback;
}
/**
 * 按 seq 序 fold 出每个事件的 `(turn, step)` 坐标。
 *
 * **与捕获侧同一条 fold 规则**(`hooks/capture.ts:192-247`):`turn/start` 推进
 * turn 并**清空** step;`step/start` 推进 step;事件自带 `data.turn`/`data.step`
 * 时**优先用自带的**。
 *
 * 红线:任何边界事件之前的事件**坐标留空**,不拿上一轮/默认值顶替——"还没开始"
 * 是真的没有坐标,编一个比留空更糟(会让锚点匹配到错误的回合)。
 */
export function foldEventAnchors(events) {
    const out = new Map();
    let currentTurn;
    let currentStep;
    events.forEach((event, index) => {
        const seq = seqOf(event, index);
        const data = (event.data ?? {});
        if (event.type === 'turn/start') {
            currentTurn = intOrUndefined(data.turn) ?? currentTurn;
            currentStep = undefined;
        }
        else if (event.type === 'step/start') {
            currentStep = intOrUndefined(data.step) ?? currentStep;
        }
        const turn = intOrUndefined(data.turn) ?? currentTurn;
        const step = intOrUndefined(data.step) ?? currentStep;
        if (turn === undefined)
            return; // 坐标留空:该事件不参与锚点匹配
        const anchor = { sessionId: '', turn };
        if (step !== undefined)
            anchor.step = step;
        out.set(seq, anchor);
    });
    return out;
}
/** 锚点是否命中某一坐标:锚点没带 step 时**整轮皆命中**(轮内首个 step 之前的消息即此形态)。 */
export function anchorMatches(anchor, point) {
    if (anchor.turn !== point.turn)
        return false;
    if (anchor.step === undefined)
        return true;
    return anchor.step === point.step;
}
/**
 * 忠实投影一条事件为证据文本。
 *
 * 只投影**形状已核实**的类型;其余类型一律给空串——**不猜形状**。空串的条目由
 * 上层 `EVIDENCE_TYPES` 与"非空文本"两道筛选挡在证据之外(见 `projectEvent`)。
 *
 * 只投影**形状已核实**的类型;其余类型一律给空串——**不猜形状**。空串的条目由
 * 上层 `EVIDENCE_TYPES` 与"非空文本"两道筛选挡在证据之外(见 `projectEvent`)。
 */
export function projectEventText(event) {
    if (event.type === 'user/message') {
        const data = event.data;
        /**
         * 只认 `source.kind === 'user'`。**这不是洁癖,是必须**(2026-09-17 真机实测):
         * 真实日志里 `user/message` 的 kind 分布为 `plugin` **745** / `user` **387** /
         * `skill-catalog` 58 / `agent-instructions` 22 / 其余 42 —— **只有 31% 是真人
         * 发言**。少了这道过滤,证据里近七成是系统注入的样板(召回记忆块、技能目录、
         * agent 指令),核对报告会被自己的注入内容污染。
         */
        if (data.source?.kind !== 'user')
            return '';
        return blocksToText(data.content);
    }
    if (event.type === 'assistant/message') {
        const data = event.data;
        return blocksToText(data.message?.content);
    }
    if (event.type === 'tool/result')
        return toolResultText(event.data);
    if (event.type === 'tool/call')
        return toolCallText(event.data);
    return '';
}
/**
 * `tool/result` 的**确切**读取路径(2026-09-17 真机核实,非推断):
 *
 * ```
 * data.message.content[]  →  { type: 'tool-result', toolCallId, content: [{ type: 'text', text }], isError? }
 * ```
 *
 * ⚠️ 初版写的是 `data.content ?? data.result?.content`——**这两处都不存在**。
 * 而 `blocksToText` 只认 `text`/`reasoning` 块,直接喂外层块(类型为 `tool-result`)
 * 也只会得到空串。必须下钻一层到 `block.content`。
 */
function toolResultText(data) {
    const content = data?.message?.content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block?.type !== 'tool-result')
            continue;
        const text = blocksToText(block.content);
        if (text.trim() === '')
            continue;
        parts.push(block.isError === true ? `[工具报错] ${text}` : text);
    }
    return parts.join('\n');
}
/** `tool/call` 的确切形状:`data.{name, arguments}`,`arguments` 是 JSON 字符串。 */
function toolCallText(data) {
    const payload = data;
    const callName = typeof payload?.name === 'string' ? payload.name : '';
    const args = typeof payload?.arguments === 'string' ? payload.arguments : '';
    if (callName === '' && args === '')
        return '';
    return args === '' ? callName : `${callName} ${args}`;
}
/**
 * 产出证据文本的事件类型。**边界事件(`turn/start`、`step/start`、`turn/end`)
 * 不在此列**——它们参与坐标 fold,但不作为证据条目导出:零文本条目会占满配额
 * 却不出内容(初版实测:3 条配额被两个边界事件吃掉)。
 *
 * `tool/call` **在列**:助手消息里的 `tool-call` 块被 `blocksToText` 丢掉(它只认
 * `text`/`reasoning`),所以"当时到底做了什么"只能靠 `tool/call` 补齐。缺了它,
 * 报告里会看到工具**结果**却不知道对应的调用是什么。
 */
const EVIDENCE_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result']);
/** 投影一条事件(含坐标);无坐标或非文本事件返回 undefined。 */
function projectEvent(event, index, point) {
    if (point === undefined)
        return undefined;
    if (!EVIDENCE_TYPES.has(event.type))
        return undefined;
    const text = projectEventText(event);
    // 空文本条目不进证据(插件注入上下文即此形态:零文本条目只会稀释报告)
    if (text.trim() === '')
        return undefined;
    const out = {
        seq: seqOf(event, index),
        type: event.type,
        text,
    };
    const turn = intOrUndefined(point.turn);
    if (turn !== undefined)
        out.turn = turn;
    if (point.step !== undefined)
        out.step = point.step;
    const time = intOrUndefined(event.time);
    if (time !== undefined)
        out.time = time;
    return out;
}
/** 带超时的读取:超时不抛,归一为 `timeout` 分类。 */
async function withTimeout(work, timeoutMs) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout', detail: `超过 ${timeoutMs}ms` }), timeoutMs);
    });
    try {
        const result = await Promise.race([
            work().then((value) => ({ ok: true, value })),
            timeout,
        ]);
        return result;
    }
    catch (err) {
        return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * 从宿主 `ctx` 安全取内核 `sessionQuery`(取不到就 `undefined`,**绝不抛**)。
 *
 * 为什么不用 `ctx.sessionQuery`:宿主 `ctx` 是 Proxy,它的 `get` 陷阱在属性既不在
 * 原型链上、服务又没挂载时**直接抛** `cannot get property "sessionQuery" without
 * inject`(`@deepseek-ai/cordis/lib/index.js:672-698`)。也就是说 `ctx.sessionQuery?.x`
 * 里的 `?.` **拦不住**这种失败——守卫还没轮到就已经抛了。
 *
 * `ctx.get(name)` 才是安全面:`ReflectService.get` 走 `_getImpl`,**取不到返回
 * `undefined`**(`cordis/lib/index.js:762-771`)。`dsh-search-index` 在生产里用的正是
 * 这个取法(`src/index.ts:625`),此处与它对齐。
 *
 * 另:`inject` 里**不能**声明 `sessionQuery`——它缺失时要降级(见 `src/index.ts` 的
 * "降级铁律"),写成硬依赖会让插件在缺该服务的环境里直接挂载失败。
 *
 * @param ctx - 宿主上下文(结构类型,便于单测注入假 ctx)。
 * @returns 内核会话查询服务面,或 undefined。
 */
export function resolveSessionQuery(ctx) {
    const getter = ctx?.get;
    if (typeof getter !== 'function')
        return undefined;
    try {
        const value = getter.call(ctx, 'sessionQuery');
        if (value === null || typeof value !== 'object')
            return undefined;
        return value;
    }
    catch {
        // 非标准 ctx(或服务解析期异常):一律降级为"没有这个能力"
        return undefined;
    }
}
/**
 * 建一个证据读取器。
 *
 * @param query - 内核 `ctx.sessionQuery`(可为 undefined:此时一律 `no-service`)。
 * @param logger - 可选诊断日志。
 * @returns 只读的取证面。
 */
export function createEvidenceSource(query, logger) {
    /**
     * 按候选 id 形态逐个试;每个形态先 `listEvents`(轻量),再 `readSession`。
     * 全部失败才判 `session-unreadable`——**先试尽力,再断言缺失**。
     */
    async function readEvents(sessionId) {
        for (const candidate of sessionIdCandidates(sessionId)) {
            if (query?.listEvents !== undefined) {
                try {
                    const events = await query.listEvents(candidate);
                    if (events.length > 0)
                        return { id: candidate, events };
                }
                catch {
                    // 该形态读不到就换下一个;失败原因不在此处定性
                }
            }
            if (query?.readSession !== undefined) {
                try {
                    const snapshot = await query.readSession(candidate);
                    if (snapshot.events.length > 0)
                        return { id: candidate, events: snapshot.events };
                }
                catch {
                    // 同上
                }
            }
        }
        return undefined;
    }
    return {
        async byAnchors(req) {
            if (req.anchors.length === 0)
                return { ok: false, reason: 'no-anchor' };
            if (query?.listEvents === undefined && query?.readSession === undefined) {
                // 能力缺失与"没谈过"必须分开:前者不能触发任何对记忆的处置
                return { ok: false, reason: 'no-service', detail: 'ctx.sessionQuery 未挂载' };
            }
            const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            const read = await withTimeout(() => readEvents(req.sessionId), timeoutMs);
            if (!read.ok) {
                if (read.reason === 'error')
                    logger?.warn(`[memory] 取证失败: ${read.detail ?? ''}`);
                return { ok: false, reason: read.reason, detail: read.detail };
            }
            if (read.value === undefined) {
                return { ok: false, reason: 'session-unreadable', detail: `尝试过 ${sessionIdCandidates(req.sessionId).join(' / ')}` };
            }
            const anchorIndex = foldEventAnchors(read.value.events);
            const maxEvents = req.maxEvents ?? DEFAULT_MAX_EVENTS;
            const maxChars = req.maxChars ?? DEFAULT_MAX_CHARS;
            const events = [];
            let chars = 0;
            let truncated = false;
            read.value.events.forEach((event, index) => {
                if (truncated)
                    return;
                const seq = seqOf(event, index);
                const point = anchorIndex.get(seq);
                if (point === undefined)
                    return;
                if (!req.anchors.some((anchor) => anchorMatches(anchor, point)))
                    return;
                const projected = projectEvent(event, index, point);
                if (projected === undefined)
                    return;
                if (events.length >= maxEvents || chars + projected.text.length > maxChars) {
                    truncated = true;
                    return;
                }
                chars += projected.text.length;
                events.push(projected);
            });
            if (events.length === 0) {
                // 会话读到了但这一轮没有记录:与"会话整个读不到"是两回事
                return { ok: false, reason: 'anchor-not-found' };
            }
            return { ok: true, slice: { sessionId: read.value.id, anchors: req.anchors, events, truncated } };
        },
    };
}
