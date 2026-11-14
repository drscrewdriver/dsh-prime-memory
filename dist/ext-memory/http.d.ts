/**
 * HTTP 驱动共用请求基座(计划 T1.x)——语义照抄参考实现 `HttpMemoryProvider`
 * (它的超时/取消/错误形状已被真机打磨过),剥掉 Memory Spaces 的 authority 耦合:
 * 本项目的连接参数就是 `ExtConnection`(config 直给),没有二级注册表。
 *
 * 三条不可让的语义(逐条有出处):
 * - **超时与外部取消分开报**:外部 abort(召回总预算到期)原样传播;自产超时
 *   换成带时限的确定性文案——lane 侧熔断按文案区分不了,但日志归因能一眼分开;
 * - **响应先 text 后 parse**:非 JSON 的 200(网关 HTML 页/纯文本错误)不炸
 *   SyntaxError,落成原始字符串进错误详情;
 * - **signal 前置 throwIfAborted**:已取消的请求根本不发出去,省一次连接占用。
 */
import type { ExtConnection } from './types.js';
export interface HttpDriverOptions {
    /** 注入 fetch(契约测试的 mock 位;缺省 globalThis.fetch)。 */
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
}
export interface HttpRequestInit {
    method?: string;
    headers?: Record<string, string>;
    /** JSON body(给出即默认 POST)。 */
    json?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export declare class ExtHttpError extends Error {
    readonly status: number | undefined;
    constructor(message: string, status?: number);
}
/** 端点尾斜杠剥除 + 必填校验;空端点 = 配置错误,装配后首次调用即报。 */
export declare function baseUrlOf(label: string, conn: ExtConnection): string;
export interface HttpJson {
    readonly label: string;
    readonly fetch: typeof fetch;
    readonly timeoutMs: number;
}
/** 一次 JSON 请求:返回解析后的 payload(非 JSON 200 → 原始字符串)。抛 ExtHttpError。 */
export declare function httpJson(h: HttpJson, url: string, options?: HttpRequestInit): Promise<unknown>;
