/**
 * L0 捕获 Hook:订阅 session/event,按轮次缓冲 user/assistant 消息,
 * turn/end 时清洗并交给 Runner 落盘 + 触发蒸馏。
 *
 * 冷启动保护:插件激活时间之前的事件不捕获(防止恢复会话时倾倒全部历史)。
 */
import { randomBytes } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { MemoryConfig } from '../config.js';
import type { MemoryRunner } from '../pipeline/runner.js';
import type { SessionModeStore } from '../store/session-modes.js';
import type { L0Store } from '../store/l0.js';
import type { LiveSettingsHandle } from '../settings.js';
import type { ConversationAnchor, ConversationMessage, MemoryLogger } from '../types.js';
import { blocksToText } from '../util/text.js';
import { redactSecrets } from '../util/redact.js';
import { sanitizeText, shouldCaptureL0, stripCodeBlocks } from '../util/sanitize.js';
import { foldRecoverableTurns, readPersistedEventsViaServices } from './capture-recovery.js';
import { confirmInjectionByMessageId } from './recall-ack.js';

/** §C 一次性告警标记:脱敏自身异常时放行原文,只提示一次(不阻断捕获)。 */
let redactWarnedOnce = false;

/**
 * §C 捕获单点脱敏(memorax-absorb):`capture.redactSecrets !== false` 时把
 * 8 类密钥替换为 `[REDACTED:<KIND>]`。位置在 sanitize 之后、L0/蒸馏分发之前——
 * 同一份 messages 覆盖 L0 JSONL/L0 SQLite/蒸馏输入三条下游,无分裂态。
 * 红线:脱敏失败放行原文 + 一次性 warn(不阻断捕获)。
 */
function redactContent(content: string, cfg: MemoryConfig, logger: MemoryLogger): string {
  if (cfg.capture?.redactSecrets === false) return content;
  try {
    return redactSecrets(content).text;
  } catch (err) {
    if (!redactWarnedOnce) {
      redactWarnedOnce = true;
      logger.warn(`[memory] 脱敏失败,本轮放行原文(一次性提示): ${err instanceof Error ? err.message : String(err)}`);
    }
    return content;
  }
}

/**
 * 需要进缓冲的事件类型。流式 chunk(text-delta/reasoning 等)一秒钟可达数百条,
 * 缓冲它们会把 MAX_BUFFER 撑爆、把轮次头部(turn/start + user 消息)裁掉——
 * 2026-08-16 真实事故:长回复轮次丢失 user 消息。
 *
 * `step/start` (2026-09-17 加入,R7):只为 **fold 出 step 坐标** 而缓冲,自身不落盘。
 * 实测占比仅 **0.68%**(`memory-evidence-reconcile/findings.md` 容量表),相对
 * 47% 的 streaming delta 可忽略;换来的是 `user/message` 也能拿到同轮 step。
 */
const RELEVANT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'turn/start',
  'turn/end',
  'step/start',
]);

export function isCaptureRelevant(type: string): boolean {
  return RELEVANT_TYPES.has(type);
}

const MAX_BUFFER = 500;

/**
 * 按会话缓冲轮次事件。turn 被消费后剩余前缀为空即删除 Map 条目——
 * 条目随会话数累积是慢泄漏(每会话残留一个数组引用,宿主长跑不释放)。
 */
export class CaptureBuffers {
  private readonly map = new Map<string, SessionEvent[]>();

  /** 活跃缓冲条目数(诊断/冒烟用)。 */
  get size(): number {
    return this.map.size;
  }

  push(sid: string, event: SessionEvent): void {
    let buf = this.map.get(sid);
    if (!buf) {
      buf = [];
      this.map.set(sid, buf);
    }
    buf.push(event);
    trimBuffer(buf);
  }

  /** 取出该 turn 的全部事件(不含 turn/start 自身);无匹配 start 时返回整个缓冲。 */
  takeTurn(sid: string, turn: number): SessionEvent[] {
    const buf = this.map.get(sid);
    if (!buf) return [];
    const startIdx = findTurnStart(buf, turn);
    const turnEvents = startIdx === -1 ? buf : buf.slice(startIdx + 1);
    const rest = startIdx === -1 ? [] : buf.slice(0, startIdx);
    if (rest.length === 0) this.map.delete(sid);
    else this.map.set(sid, rest);
    return turnEvents;
  }
}

/**
 * 注册 L0 捕获。返回 L0 串行链的冲刷函数(dispose 序在关库前 await,
 * 排队中的 turn 消息先落盘);capture 关闭时返回 undefined。
 */
export function registerCapture(
  ctx: Context,
  cfg: MemoryConfig,
  runner: MemoryRunner,
  l0: L0Store,
  logger: MemoryLogger,
  live: LiveSettingsHandle,
  modes: SessionModeStore,
): (() => Promise<void>) | undefined {
  if (!cfg.capture.enabled) return;
  const startFloor = Date.now();
  const buffers = new CaptureBuffers();
  // task_8 一次性提示标记:宿主读日志服务不可得时只提示一次(防每次 resume 刷屏)
  let warnedRecoveryUnavailable = false;
  // L0 即时落盘链:turn/end 立刻写,不被蒸馏队列(慢 LLM 调用)阻塞;
  // 串行化保证同轮次顺序与单次写入(进程退出时排队中的 L0 不再依赖蒸馏完成)
  let l0Queue: Promise<void> = Promise.resolve();

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      const s = live.get();
      if (!s.enabled || !s.capture) return;
      const sid = String(session.id ?? session);
      // §D 日志回执(memorax-absorb):注入消息以原样 user/message 入日志时在此确认,
      // 才真正 dedupe.mark。**必须置于 source.kind 过滤之前**——过滤在
      // turnEventsToMessages 内且只放行 kind='user',注入消息(kind='plugin',本线 v3 署名)
      // 走不到那里;也置于 off 档返回之前(确认与档位无关,且代价是一次 Map 查找)。
      if (event.type === 'user/message') {
        const mid = (event.data as { id?: unknown }).id;
        if (typeof mid === 'string' && mid) confirmInjectionByMessageId(mid);
      }
      // off 档:本会话对记忆系统完全隐身(不缓冲、不写 L0、不蒸馏)
      if (modes.get(sid) === 'off') return;
      if (!isCaptureRelevant(event.type)) return;
      if (event.time < startFloor) {
        // 冷启动保护拦截的 user 消息记 info(罕见,但正是"整轮只剩 assistant"现象的线索)
        if (event.type === 'user/message') {
          logger.info(
            `[memory] L0 跳过早于插件启动的 user 消息(冷启动保护,早 ${startFloor - event.time}ms)`,
          );
        }
        return;
      }
      buffers.push(sid, event);

      if (event.type === 'turn/end') {
        const turn = event.data.turn;
        const turnEvents = buffers.takeTurn(sid, turn);
        const messages = turnEventsToMessages(turnEvents, cfg, logger, sid, turn);
        if (messages.length > 0) {
          const roles = messages.reduce<Record<string, number>>((acc, m) => {
            acc[m.role] = (acc[m.role] ?? 0) + 1;
            return acc;
          }, {});
          // 轮末档位生效(中途切档:本轮按 turn/end 时的档位蒸馏)
          const mode = modes.get(sid);
          if (mode === 'off') {
            logger.info(`[memory] turn=${turn} 结束时档位为关闭,本轮不落盘不蒸馏(session=${sid})`);
            return;
          }
          logger.info(
            `[memory] L0 捕获 turn=${turn} ${messages.length} 条(${Object.entries(roles)
              .map(([k, v]) => `${k}=${v}`)
              .join('/')} ,session=${sid},mode=${mode})`,
          );
          // L0 立刻落盘(不等蒸馏)
          const n = messages.length;
          l0Queue = l0Queue
            .then(() => l0.append(sid, messages))
            .then(() => logger.info(`[memory] L0 落盘 ${n} 条`))
            .catch((err) =>
              logger.warn(`[memory] L0 落盘失败: ${err instanceof Error ? err.message : String(err)}`),
            );
          runner.enqueue(sid, messages, mode);
        }
      }
    } catch (err) {
      logger.warn(`[memory] session/event 处理失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── §A 崩溃恢复(memorax-absorb Wave 1 / task_7):resume 时对账宿主持久化日志,
  // 补收 (L0 水位线, 末尾] 内 bracket 完整的尾轮(≤2 轮)——崩溃轮在缓冲丢失后
  // 仍可从持久化层找回(persistence 会给孤儿轮补 interrupted 闭合,探针② 实证 98 处)。
  // fail-open 纪律:任何异常只 warn,不阻塞会话启动;幂等 = 水位线 + 逐 turn 存在性检查。
  ctx.on(
    'agent/session-start',
    (payload) => {
      try {
        if (payload.source !== 'resume') return;
        const s = live.get();
        if (!s.enabled || !s.capture) return;
        const session = payload.agent?.session;
        const sid = session?.id !== undefined && session.id !== null ? String(session.id) : '';
        if (!sid) return;
        const mode = modes.get(sid);
        if (mode === 'off') return; // off 档对记忆系统完全隐身,对齐现行为
        let events: readonly SessionEvent[] | undefined = session?.events;
        if (!events || events.length === 0) {
          // task_8 降级链:events 不可得(宿主版本偏差)时依次试
          // ctx.sessionQuery.readSession / ctx.sessionPersistence.readFrom(守卫探针式)
          const get = (ctx as { get?: (name: string) => unknown }).get;
          const svcs =
            typeof get === 'function'
              ? ({
                  sessionQuery: get.call(ctx, 'sessionQuery'),
                  sessionPersistence: get.call(ctx, 'sessionPersistence'),
                } as Parameters<typeof readPersistedEventsViaServices>[0])
              : {};
          const degraded = readPersistedEventsViaServices(svcs, sid);
          if (degraded === undefined) {
            if (!warnedRecoveryUnavailable) {
              warnedRecoveryUnavailable = true;
              logger.info('[memory] resume 恢复:宿主读日志服务不可得,跳过对账(一次性提示)');
            }
            return;
          }
          events = degraded;
        }
        const watermark = l0.maxCapturedTurn(sid);
        const brackets = foldRecoverableTurns(events, watermark);
        if (brackets.length === 0) return;
        let recovered = 0;
        let skipped = 0;
        let total = 0;
        for (const bracket of brackets) {
          if (l0.hasAnyL0Message(sid, bracket.turn)) {
            // 部分写残行:水位线只判"整轮无",存在性检查兜底——整轮跳过,宁少收不重复
            skipped += 1;
            continue;
          }
          const messages = turnEventsToMessages(bracket.events, cfg, logger, sid, bracket.turn);
          if (messages.length === 0) continue;
          recovered += 1;
          total += messages.length;
          const n = messages.length;
          l0Queue = l0Queue
            .then(() => l0.append(sid, messages))
            .then(() => logger.info(`[memory] L0 恢复落盘 ${n} 条`))
            .catch((err) =>
              logger.warn(`[memory] L0 恢复落盘失败: ${err instanceof Error ? err.message : String(err)}`),
            );
          runner.enqueue(sid, messages, mode);
        }
        if (recovered > 0 || skipped > 0) {
          logger.info(
            `[memory] resume 对账:水位线 ${watermark ?? '无'} → 恢复 ${recovered} 轮 ${total} 条,幂等跳过 ${skipped} 轮(session=${sid})`,
          );
        }
      } catch (err) {
        logger.warn(`[memory] resume 恢复失败(不阻塞会话启动): ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // 冲刷 = 等待串行链排空(链上每环自带 catch,永不 reject)。
  // 注:极小概率在 await 期间又入队的新消息会落到链尾——其 JSONL 事实源照写、
  // DB 写入由 upsert 内部兜底(关库后 warn),下次重建自愈。
  return () => l0Queue;
}

/**
 * 缓冲上限裁剪(防御性;RELEVANT_TYPES 过滤后基本不可达)。
 * 铁律:进行中轮次(turn/start 之后、turn/end 之前)的事件绝不裁——
 * 只裁最早一个未闭合 turn/start 之前的已完成前缀。
 */
export function trimBuffer(buf: SessionEvent[]): void {
  if (buf.length <= MAX_BUFFER) return;
  let openStart = -1;
  let closed = true;
  for (let i = 0; i < buf.length; i++) {
    const t = buf[i].type;
    if (t === 'turn/start' && closed) {
      openStart = i;
      closed = false;
    } else if (t === 'turn/end') {
      closed = true;
      openStart = -1;
    }
  }
  const floorIdx = openStart === -1 ? Math.max(0, buf.length - MAX_BUFFER) : openStart;
  if (floorIdx > 0) buf.splice(0, floorIdx);
}

/** 找到与 turn/end 同 turn 的最后一个 turn/start 的索引(含自身)。 */
function findTurnStart(buf: SessionEvent[], turn: number): number {
  for (let i = buf.length - 1; i >= 0; i--) {
    const e = buf[i];
    if (e.type === 'turn/start' && e.data.turn === turn) return i;
  }
  return -1;
}

/** 把轮次事件转成 L0 消息(仅真实 user 消息 + assistant 消息,清洗过滤)。 */
function turnEventsToMessages(
  events: SessionEvent[],
  cfg: MemoryConfig,
  logger: MemoryLogger,
  sessionId: string,
  turn: number,
): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  /**
   * step fold(R7):`assistant/message` 与 `tool/result` 自带 `{turn, step}`,
   * 但 `user/message` **不带**(内核 `types.d.ts:274` 对 `:291-324`)。按 seq 序
   * 推进当前 step,让轮内的 user 消息也能拿到**同轮**坐标。
   *
   * 红线:`step/start` 之前出现的 user 消息**留空 step**,不拿上一轮的 step 顶替
   * ——"轮内第一个 step 尚未开始"是真的没有坐标,编一个比留空更糟。
   */
  let currentStep: number | undefined;
  for (const event of events) {
    // step 边界推进 fold 游标(不作为消息落盘,故不参与 out)
    if (event.type === 'step/start') {
      const s = (event.data as { step?: unknown }).step;
      if (typeof s === 'number' && Number.isFinite(s)) currentStep = s;
      continue;
    }
    if (event.type === 'user/message') {
      const msg = event.data as UserMessage;
      // 只捕获真实用户输入(source.kind === 'user'),跳过插件注入上下文
      if (msg.source?.kind !== 'user') {
        logger.info(`[memory] L0 跳过非用户来源消息(source.kind=${msg.source?.kind ?? 'none'})`);
        continue;
      }
      const content = redactContent(sanitizeText(blocksToText(msg.content)), cfg, logger);
      if (shouldCaptureL0(content)) {
        const anchor: ConversationAnchor = { sessionId, turn };
        if (currentStep !== undefined) anchor.step = currentStep;
        out.push(makeMessage('user', content, event.time, cfg.capture.maxMessageChars, anchor));
      }
    } else if (event.type === 'assistant/message') {
      const data = event.data as { message: AssistantMessage; turn?: unknown; step?: unknown };
      let content = sanitizeText(blocksToText(data.message?.content));
      if (cfg.capture.stripCodeBlocks) content = stripCodeBlocks(content);
      content = redactContent(content, cfg, logger);
      if (shouldCaptureL0(content)) {
        // 事件自带 turn/step 优先(fold 只服务于不带该字段的事件类型)
        const evTurn = typeof data.turn === 'number' && Number.isFinite(data.turn) ? data.turn : turn;
        const evStep = typeof data.step === 'number' && Number.isFinite(data.step) ? data.step : currentStep;
        const anchor: ConversationAnchor = { sessionId, turn: evTurn };
        if (evStep !== undefined) anchor.step = evStep;
        out.push(makeMessage('assistant', content, event.time, cfg.capture.maxMessageChars, anchor));
      }
    }
  }
  if (out.length > 0) {
    logger.debug?.(`[memory] 轮次消息 ${events.length} 事件 → ${out.length} 条(清洗过滤后)`);
  }
  return out;
}

function makeMessage(
  role: 'user' | 'assistant',
  content: string,
  timestamp: number,
  maxChars: number,
  anchor?: ConversationAnchor,
): ConversationMessage {
  const msg: ConversationMessage = {
    id: `msg_${Date.now()}_${randomBytes(3).toString('hex')}`,
    role,
    content: content.slice(0, maxChars),
    timestamp,
  };
  if (anchor !== undefined) msg.anchor = anchor;
  return msg;
}
