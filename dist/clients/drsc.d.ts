import type { ConversationMessage } from '../types.js';
/** collector API 路径(与其 DRS_API_PATH 字面一致;不跨包 import)。 */
export declare const DRSC_API_PATH = "/api/dsh-reference-session-collector";
/** 客户端缺省超时:loopback 正常 <10ms,5s 是给冷启动 GC/断点的天花板。 */
export declare const DRSC_DEFAULT_TIMEOUT_MS = 5000;
/** collector 缺席/超时/契约破损。显式报错,不回退本地。 */
export declare class DrscClientError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** 基址与其来源。 */
export interface ResolvedDrscBase {
    url: string;
    /** 基址是否取自显式配置或 trustedHosts 条目(即解析序的前两档)。 */
    fromConfigured: boolean;
}
/** 供 Host 回显的条目:须与 {@link resolveDrscBaseUrl} 的选取口径逐字一致。 */
export declare function firstDrscTrustedHost(trustedHosts?: readonly string[]): string | undefined;
/**
 * 基址解析:显式配置 > 首个 trustedHosts 条目(补 http:// 前缀)> 宿主实际监听
 * origin(issue #20 新增的兜底)> `http://127.0.0.1:8080`(宿主默认口;trustedHosts
 * 缺席的老线 collector 门本就放行)。
 *
 * origin 刻意排在 trustedHosts **之下**:它只替换那句写死的 8080。放上去会把
 * 已经能工作的配置(靠 `--trusted-host` 指过地址)改到另一个 authority 上,那是回归。
 */
export declare function resolveDrscBaseUrl(explicit: string | undefined, trustedHosts?: readonly string[], fallbackOrigin?: string): string;
/** {@link resolveDrscBaseUrl} 的带来源形态,供客户端决定 Host 回显。 */
export declare function resolveDrscBaseUrlDetail(explicit: string | undefined, trustedHosts?: readonly string[], fallbackOrigin?: string): ResolvedDrscBase;
/** `op=session` 的一个 segment 行(redact=1 时 text 为脱敏正文;wire 蛇形直取)。 */
export interface DrscSessionRow {
    seq: number;
    turn: number;
    step: number;
    kind: string;
    role: string;
    time: number;
    text: string;
}
/** `op=search` 的一个命中(redact=1 时 snippet 为脱敏锚定文本)。 */
export interface DrscSearchHit {
    session_id: string;
    seq: number;
    kind: string;
    rank: number;
    snippet: string;
    time: number;
    on_surface: number;
    turn: number;
}
/** `op=sessions` 的一个会话摘要行（分页枚举用；wire 蛇形直取）。 */
export interface DrscSessionSummary {
    session_id: string;
    title: string;
    cwd: string;
    event_count: number;
    turn_count: number;
    /** 末条消息时间（ms）—— collector 按它降序排，客户端用时注意反转。 */
    last_time_ms: number;
}
/** kind → L0 角色词表(memory 只收 user/assistant 两类,其余(tool/* 等)不映射)。 */
export declare function drscRoleOf(kind: string): 'user' | 'assistant' | undefined;
/**
 * session 行 → ConversationMessage 形状映射(蒸馏背景窗用)。
 * - id:确定性合成 `drsc:<session>:<seq>`(跨次调用稳定,anchor 追溯可解释);
 * - anchor:turn>0 才成立(与 ConversationAnchor 红线一致:没坐标不伪造);
 * - 非 user/assistant 段(tool/call 等)返回 undefined,调用方跳过。
 */
export declare function drscRowToConversationMessage(row: DrscSessionRow, sessionId: string): ConversationMessage | undefined;
export interface DrscClientOptions {
    /** 显式基址(缺省走 trustedHosts → 宿主 origin → 127.0.0.1:8080,见 resolveDrscBaseUrl)。 */
    baseUrl?: string;
    /** trustedHosts 惰性读取(webStartup 服务可能晚于装配;每次请求现取)。 */
    trustedHosts?: () => readonly string[] | undefined;
    /**
     * 宿主实际监听 origin 惰性读取(issue #20)。webServer 服务可能晚就绪/换实例/
     * 下线,故与 trustedHosts 同款每次现取;取不到即返回 undefined → 落回 8080 老行为。
     */
    origin?: () => string | undefined;
    /**
     * 注入面（单测）；缺省全局 fetch。**显式传入即表示要走 HTTP**（见 getJson 分流）。
     */
    fetchImpl?: typeof fetch;
    /**
     * 进程内读面（issue #20 追加修复，缺省 {@link callCollectorRead}）：直调
     * collector 导出的只读查询函数。宿主对所有注册路由有 pre-dispatch 鉴权
     * （插件服务端无 cookie 可用，真机实测 401），HTTP 路在桌面宿主上走不通；
     * 只有显式给了 `baseUrl`（跨机/外部 collector）时才保留 HTTP 退路。
     */
    read?: (query: string) => Promise<Record<string, unknown>>;
    /** 单请求超时 ms;缺省 {@link DRSC_DEFAULT_TIMEOUT_MS}。 */
    timeoutMs?: number;
}
export declare class DrscClient {
    private readonly options;
    private readonly fetchImpl;
    private readonly timeoutMs;
    constructor(options?: DrscClientOptions);
    /** 每次请求现算基址与 Host 回显(trustedHosts/origin 惰性;无缓存陈旧面)。 */
    private base;
    /** origin 探针失败(服务未就绪/属性读抛)不得影响请求:视作取不到,落老行为。 */
    private safeOrigin;
    /**
     * 一次读：优先进程内直调，失败/缺席一律包成 DrscClientError（与 HTTP 路同口径，
     * 调用方的「显式报错 vs 空窗降级」分面处理不变）。
     */
    private readInproc;
    /** 一个 GET 的 JSON 包络(非 2xx / ok!==true / 超时 / 断网一律抛 DrscClientError)。 */
    private getJson;
    /**
     * 会话尾窗:`op=session&session=<id>&tail=N&redact=1` → 脱敏消息行(升序)。
     * collector 无此会话(session:null)返回空数组(新会话首轮的常态,非错误)。
     */
    sessionTail(sessionId: string, tail: number): Promise<DrscSessionRow[]>;
    /**
     * **整会话**正文（issue #14-B 重建事实源）：`op=session&session=<id>&redact=1`，
     * **不带 `tail`** —— collector 侧 `tail` 未给时走 `ORDER BY s.seq ASC` 无 LIMIT，即全量。
     *
     * `redact=1` 是**硬要求**，不是可选项：collector 的 `session` 缺省是原文臂，
     * 而 memory 捕获侧是写前单点脱敏；重建若走原文臂，产出的 L1 会比正常蒸馏「更脏」，
     * 而且会经 md 投射落盘。
     */
    sessionAll(sessionId: string): Promise<DrscSessionRow[]>;
    /**
     * 会话枚举：`op=sessions&offset&limit`（collector 侧 limit 钳到 1..500）。
     *
     * 重建的事实源没有“全量导出”单口（也不应该有：一个响应装不下几万条正文），
     * 所以走「枚举会话 → 逐会话拉全量」的 N+1 组合。采集端分页是 0-SQL 的内存切片，
     * 代价仅在于请求数。
     */
    listSessions(offset: number, limit: number): Promise<{
        total: number;
        rows: DrscSessionSummary[];
    }>;
    /** 原史检索:`op=search&q=<query>&limit=N&redact=1` → 脱敏 snippet 命中。 */
    search(query: string, limit: number): Promise<DrscSearchHit[]>;
}
