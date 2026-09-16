/**
 * 证据读取器(R1)——把 L1 记忆的**来源锚点**还原成会话原文。
 *
 * 取原文的位置(2026-09-17 重估,见 `memory-evidence-reconcile/findings.md`):
 * 走**内核 `ctx.sessionQuery`** 直连,不再等 search-index 的 `content-fetch`。
 * 内核已提供 `readSession` / `listEvents` / `readEvent`;`content-fetch` 只是同
 * 一服务之上的 HTTP loopback 包装,服务的是拿不到 `ctx` 的消费者。本插件是宿主
 * 插件,手里就有 `ctx`,不需要那一跳(少一层进程边界与失败点)。
 *
 * **红线**:`docs.text` 永远不得当保真来源——它是切词前的抽取文本、只含可检索
 * 事件。本模块只读内核原始事件。
 *
 * **红线**:这里的投影是**忠实投影**,与捕获侧策略**不同**——不 `stripCodeBlocks`、
 * 不按 `maxMessageChars` 截断、不做 `shouldCaptureL0` 的"值不值得记"筛选。捕获
 * 可以为省 token 丢东西,取证不行:取证要的就是"他当时到底说了什么"。
 * 唯一保留的过滤是 `user/message` 的 `source.kind === 'user'`——插件注入的上下文
 * 不是用户发言,计入证据会污染判定。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ConversationAnchor } from '../types.js';
import { blocksToText } from '../util/text.js';

/**
 * 内核 `ctx.sessionQuery` 的最小结构面。
 *
 * 结构性镜像而非值导入:插件不依赖官方包,且必须能在服务缺失时**降级**而不是
 * 挂载失败(见 `src/index.ts` 的"降级铁律")。两个读法都声明为可选——不同版本
 * 的内核可能只提供其中之一。
 */
export interface SessionQueryLike {
  readSession?: (sessionId: string) => Promise<{ session: { id?: string }; events: readonly SessionEvent[] }>
  listEvents?: (sessionId: string) => Promise<readonly SessionEvent[]>
}

/** 一条投影后的证据事件(面板与报告直接消费的形状)。 */
export interface EvidenceEvent {
  seq: number
  turn?: number
  step?: number
  type: string
  time?: number
  text: string
}

/** 一次成功的取证。 */
export interface EvidenceSlice {
  /** 实际命中的会话 id 形态(可能与请求时的形态不同,见 `sessionIdCandidates`)。 */
  sessionId: string
  /** 本次请求的锚点,原样回显,便于报告逐条对应。 */
  anchors: readonly ConversationAnchor[]
  events: readonly EvidenceEvent[]
  /** 因条数/长度上限被裁剪时为 true——**报告必须显式标注**,不得当成取全了。 */
  truncated: boolean
}

/**
 * 取证失败的**分类**。这不是错误码装饰:task_8b 要求「找不到」必须可区分,
 * 且只有"确实没谈过"才允许靠近 `contradicted`;下面标 `skipped` 的三类
 * **一律跳过并原样保留记忆**,绝不删改。
 */
export type EvidenceFailure =
  /** 内核没挂 sessionQuery(插件环境不支持)——能力缺失,不是"没谈过"。 */
  | 'no-service'
  /** 这条记忆根本没有锚点(改造前的老记忆)——需先定位候选,不是"没谈过"。 */
  | 'no-anchor'
  /** 两种 id 形态都读不到会话:日志已删/被 prune——task_8b 第③类。 */
  | 'session-unreadable'
  /** 会话读到了,但锚点坐标在该会话里找不到该轮——索引/日志未覆盖该轮。 */
  | 'anchor-not-found'
  /** 超出取证超时。 */
  | 'timeout'
  /** 其他读取异常(已捕获,不向上抛)。 */
  | 'error'

export interface EvidenceOk {
  ok: true
  slice: EvidenceSlice
}

export interface EvidenceFail {
  ok: false
  reason: EvidenceFailure
  /** 可诊断的补充信息(错误文本、超时的毫秒数等)。 */
  detail?: string
}

export type EvidenceResult = EvidenceOk | EvidenceFail

export interface EvidenceRequest {
  sessionId: string
  anchors: readonly ConversationAnchor[]
  /** 最多取回多少条事件(默认 200)。超出即 `truncated`。 */
  maxEvents?: number
  /** 证据文本总长上限(默认 40000 字符)。超出即 `truncated`。 */
  maxChars?: number
  /** 单次取证超时(默认 5000ms)。 */
  timeoutMs?: number
}

/** 证据读取器的对外面。 */
export interface EvidenceSource {
  byAnchors: (req: EvidenceRequest) => Promise<EvidenceResult>
}

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
export function sessionIdCandidates(sessionId: string): string[] {
  const trimmed = sessionId.trim();
  if (trimmed === '') return [];
  const bare = trimmed.startsWith('session-') ? trimmed.slice('session-'.length) : trimmed;
  const prefixed = `session-${bare}`;
  const out: string[] = [];
  for (const candidate of [trimmed, prefixed, bare]) {
    if (candidate !== '' && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/** 从事件负载里取整数坐标;非有限数一律视为"没有"(绝不拿 0 顶替)。 */
function intOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function seqOf(event: SessionEvent, fallback: number): number {
  return intOrUndefined((event as { seq?: unknown }).seq) ?? fallback;
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
export function foldEventAnchors(events: readonly SessionEvent[]): Map<number, ConversationAnchor> {
  const out = new Map<number, ConversationAnchor>();
  let currentTurn: number | undefined;
  let currentStep: number | undefined;
  events.forEach((event, index) => {
    const seq = seqOf(event, index);
    const data = (event.data ?? {}) as { turn?: unknown; step?: unknown };
    if (event.type === 'turn/start') {
      currentTurn = intOrUndefined(data.turn) ?? currentTurn;
      currentStep = undefined;
    } else if (event.type === 'step/start') {
      currentStep = intOrUndefined(data.step) ?? currentStep;
    }
    const turn = intOrUndefined(data.turn) ?? currentTurn;
    const step = intOrUndefined(data.step) ?? currentStep;
    if (turn === undefined) return; // 坐标留空:该事件不参与锚点匹配
    const anchor: ConversationAnchor = { sessionId: '', turn };
    if (step !== undefined) anchor.step = step;
    out.set(seq, anchor);
  });
  return out;
}

/** 锚点是否命中某一坐标:锚点没带 step 时**整轮皆命中**(轮内首个 step 之前的消息即此形态)。 */
export function anchorMatches(anchor: ConversationAnchor, point: ConversationAnchor): boolean {
  if (anchor.turn !== point.turn) return false;
  if (anchor.step === undefined) return true;
  return anchor.step === point.step;
}

/**
 * 忠实投影一条事件为证据文本。
 *
 * 只投影**形状已核实**的类型;其余类型一律给空串——**不猜形状**。空串的条目由
 * 上层 `EVIDENCE_TYPES` 与"非空文本"两道筛选挡在证据之外(见 `projectEvent`)。
 *
 * ⚠️ `tool/result` 的负载形状**尚未真机核实**,故按"取得到就取"的宽容读法处理。
 * 真机实调(task_7 验证项)必须确认后把这里改成确切读法。
 */
export function projectEventText(event: SessionEvent): string {
  if (event.type === 'user/message') {
    const data = event.data as { source?: { kind?: unknown }; content?: unknown };
    if (data.source?.kind !== 'user') return '';
    return blocksToText(data.content as Parameters<typeof blocksToText>[0]);
  }
  if (event.type === 'assistant/message') {
    const data = event.data as { message?: { content?: unknown } };
    return blocksToText(data.message?.content as Parameters<typeof blocksToText>[0]);
  }
  if (event.type === 'tool/result') {
    const data = event.data as { content?: unknown; result?: { content?: unknown } };
    const blocks = data.content ?? data.result?.content;
    if (blocks === undefined) return '';
    return blocksToText(blocks as Parameters<typeof blocksToText>[0]);
  }
  return '';
}

/**
 * 产出证据文本的事件类型。**边界事件(`turn/start`、`step/start`、`turn/end`)
 * 不在此列**——它们参与坐标 fold,但不作为证据条目导出:零文本条目会占满配额
 * 却不出内容(初版实测:3 条配额被两个边界事件吃掉)。
 */
const EVIDENCE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

/** 投影一条事件(含坐标);无坐标或非文本事件返回 undefined。 */
function projectEvent(event: SessionEvent, index: number, point: ConversationAnchor | undefined): EvidenceEvent | undefined {
  if (point === undefined) return undefined;
  if (!EVIDENCE_TYPES.has(event.type)) return undefined;
  const text = projectEventText(event);
  // 空文本条目不进证据(插件注入上下文即此形态:零文本条目只会稀释报告)
  if (text.trim() === '') return undefined;
  const out: EvidenceEvent = {
    seq: seqOf(event, index),
    type: event.type,
    text,
  };
  const turn = intOrUndefined(point.turn);
  if (turn !== undefined) out.turn = turn;
  if (point.step !== undefined) out.step = point.step;
  const time = intOrUndefined((event as { time?: unknown }).time);
  if (time !== undefined) out.time = time;
  return out;
}

/** 带超时的读取:超时不抛,归一为 `timeout` 分类。 */
async function withTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; reason: 'timeout' | 'error'; detail?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; reason: 'timeout'; detail: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout', detail: `超过 ${timeoutMs}ms` }), timeoutMs);
  });
  try {
    const result = await Promise.race([
      work().then((value) => ({ ok: true as const, value })),
      timeout,
    ]);
    return result;
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 建一个证据读取器。
 *
 * @param query - 内核 `ctx.sessionQuery`(可为 undefined:此时一律 `no-service`)。
 * @param logger - 可选诊断日志。
 * @returns 只读的取证面。
 */
export function createEvidenceSource(
  query: SessionQueryLike | undefined,
  logger?: { warn: (m: string) => void },
): EvidenceSource {
  /**
   * 按候选 id 形态逐个试;每个形态先 `listEvents`(轻量),再 `readSession`。
   * 全部失败才判 `session-unreadable`——**先试尽力,再断言缺失**。
   */
  async function readEvents(sessionId: string): Promise<{ id: string; events: readonly SessionEvent[] } | undefined> {
    for (const candidate of sessionIdCandidates(sessionId)) {
      if (query?.listEvents !== undefined) {
        try {
          const events = await query.listEvents(candidate);
          if (events.length > 0) return { id: candidate, events };
        } catch {
          // 该形态读不到就换下一个;失败原因不在此处定性
        }
      }
      if (query?.readSession !== undefined) {
        try {
          const snapshot = await query.readSession(candidate);
          if (snapshot.events.length > 0) return { id: candidate, events: snapshot.events };
        } catch {
          // 同上
        }
      }
    }
    return undefined;
  }

  return {
    async byAnchors(req: EvidenceRequest): Promise<EvidenceResult> {
      if (req.anchors.length === 0) return { ok: false, reason: 'no-anchor' };
      if (query?.listEvents === undefined && query?.readSession === undefined) {
        // 能力缺失与"没谈过"必须分开:前者不能触发任何对记忆的处置
        return { ok: false, reason: 'no-service', detail: 'ctx.sessionQuery 未挂载' };
      }
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const read = await withTimeout(() => readEvents(req.sessionId), timeoutMs);
      if (!read.ok) {
        if (read.reason === 'error') logger?.warn(`[memory] 取证失败: ${read.detail ?? ''}`);
        return { ok: false, reason: read.reason, detail: read.detail };
      }
      if (read.value === undefined) {
        return { ok: false, reason: 'session-unreadable', detail: `尝试过 ${sessionIdCandidates(req.sessionId).join(' / ')}` };
      }

      const anchorIndex = foldEventAnchors(read.value.events);
      const maxEvents = req.maxEvents ?? DEFAULT_MAX_EVENTS;
      const maxChars = req.maxChars ?? DEFAULT_MAX_CHARS;
      const events: EvidenceEvent[] = [];
      let chars = 0;
      let truncated = false;
      read.value.events.forEach((event, index) => {
        if (truncated) return;
        const seq = seqOf(event, index);
        const point = anchorIndex.get(seq);
        if (point === undefined) return;
        if (!req.anchors.some((anchor) => anchorMatches(anchor, point))) return;
        const projected = projectEvent(event, index, point);
        if (projected === undefined) return;
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
