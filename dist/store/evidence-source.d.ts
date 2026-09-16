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
/**
 * 内核 `ctx.sessionQuery` 的最小结构面。
 *
 * 结构性镜像而非值导入:插件不依赖官方包,且必须能在服务缺失时**降级**而不是
 * 挂载失败(见 `src/index.ts` 的"降级铁律")。两个读法都声明为可选——不同版本
 * 的内核可能只提供其中之一。
 */
export interface SessionQueryLike {
    readSession?: (sessionId: string) => Promise<{
        session: {
            id?: string;
        };
        events: readonly SessionEvent[];
    }>;
    listEvents?: (sessionId: string) => Promise<readonly SessionEvent[]>;
}
/** 一条投影后的证据事件(面板与报告直接消费的形状)。 */
export interface EvidenceEvent {
    seq: number;
    turn?: number;
    step?: number;
    type: string;
    time?: number;
    text: string;
}
/** 一次成功的取证。 */
export interface EvidenceSlice {
    /** 实际命中的会话 id 形态(可能与请求时的形态不同,见 `sessionIdCandidates`)。 */
    sessionId: string;
    /** 本次请求的锚点,原样回显,便于报告逐条对应。 */
    anchors: readonly ConversationAnchor[];
    events: readonly EvidenceEvent[];
    /** 因条数/长度上限被裁剪时为 true——**报告必须显式标注**,不得当成取全了。 */
    truncated: boolean;
}
/**
 * 取证失败的**分类**。这不是错误码装饰:task_8b 要求「找不到」必须可区分,
 * 且只有"确实没谈过"才允许靠近 `contradicted`;下面标 `skipped` 的三类
 * **一律跳过并原样保留记忆**,绝不删改。
 */
export type EvidenceFailure = 
/** 内核没挂 sessionQuery(插件环境不支持)——能力缺失,不是"没谈过"。 */
'no-service'
/** 这条记忆根本没有锚点(改造前的老记忆)——需先定位候选,不是"没谈过"。 */
 | 'no-anchor'
/** 两种 id 形态都读不到会话:日志已删/被 prune——task_8b 第③类。 */
 | 'session-unreadable'
/** 会话读到了,但锚点坐标在该会话里找不到该轮——索引/日志未覆盖该轮。 */
 | 'anchor-not-found'
/** 超出取证超时。 */
 | 'timeout'
/** 其他读取异常(已捕获,不向上抛)。 */
 | 'error';
export interface EvidenceOk {
    ok: true;
    slice: EvidenceSlice;
}
export interface EvidenceFail {
    ok: false;
    reason: EvidenceFailure;
    /** 可诊断的补充信息(错误文本、超时的毫秒数等)。 */
    detail?: string;
}
export type EvidenceResult = EvidenceOk | EvidenceFail;
export interface EvidenceRequest {
    sessionId: string;
    anchors: readonly ConversationAnchor[];
    /** 最多取回多少条事件(默认 200)。超出即 `truncated`。 */
    maxEvents?: number;
    /** 证据文本总长上限(默认 40000 字符)。超出即 `truncated`。 */
    maxChars?: number;
    /** 单次取证超时(默认 5000ms)。 */
    timeoutMs?: number;
}
/** 证据读取器的对外面。 */
export interface EvidenceSource {
    byAnchors: (req: EvidenceRequest) => Promise<EvidenceResult>;
}
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
export declare function sessionIdCandidates(sessionId: string): string[];
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
export declare function foldEventAnchors(events: readonly SessionEvent[]): Map<number, ConversationAnchor>;
/** 锚点是否命中某一坐标:锚点没带 step 时**整轮皆命中**(轮内首个 step 之前的消息即此形态)。 */
export declare function anchorMatches(anchor: ConversationAnchor, point: ConversationAnchor): boolean;
/**
 * 忠实投影一条事件为证据文本。
 *
 * 只投影**形状已核实**的类型;其余类型一律给空串——**不猜形状**。空串的条目由
 * 上层 `EVIDENCE_TYPES` 与"非空文本"两道筛选挡在证据之外(见 `projectEvent`)。
 *
 * ⚠️ `tool/result` 的负载形状**尚未真机核实**,故按"取得到就取"的宽容读法处理。
 * 真机实调(task_7 验证项)必须确认后把这里改成确切读法。
 */
export declare function projectEventText(event: SessionEvent): string;
/**
 * 建一个证据读取器。
 *
 * @param query - 内核 `ctx.sessionQuery`(可为 undefined:此时一律 `no-service`)。
 * @param logger - 可选诊断日志。
 * @returns 只读的取证面。
 */
export declare function createEvidenceSource(query: SessionQueryLike | undefined, logger?: {
    warn: (m: string) => void;
}): EvidenceSource;
