export class ExtHttpError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = 'ExtHttpError';
        this.status = status;
    }
}
/** 端点尾斜杠剥除 + 必填校验;空端点 = 配置错误,装配后首次调用即报。 */
export function baseUrlOf(label, conn) {
    const base = String(conn.endpoint ?? '').replace(/\/+$/u, '');
    if (base === '')
        throw new Error(`${label} endpoint is not configured`);
    return base;
}
/** 一次 JSON 请求:返回解析后的 payload(非 JSON 200 → 原始字符串)。抛 ExtHttpError。 */
export async function httpJson(h, url, options = {}) {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const relay = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', relay, { once: true });
    const timeoutMs = options.timeoutMs ?? h.timeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(`${h.label} request timed out`)), timeoutMs);
    const headers = new Headers(options.headers);
    if (options.json !== undefined && !headers.has('Content-Type'))
        headers.set('Content-Type', 'application/json');
    try {
        const response = await h.fetch(url, {
            method: options.method ?? (options.json === undefined ? 'GET' : 'POST'),
            headers,
            ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
            signal: controller.signal,
        });
        const raw = await response.text();
        let payload = {};
        if (raw !== '') {
            try {
                payload = JSON.parse(raw);
            }
            catch {
                payload = raw;
            }
        }
        if (!response.ok)
            throw new ExtHttpError(`${h.label} HTTP ${response.status}: ${errorDetail(payload) ?? String(raw).slice(0, 200)}`, response.status);
        return payload;
    }
    catch (error) {
        // 只把"自产超时"(外部未 abort 而 controller 已 aborted)换文案;其余原样上抛
        if (controller.signal.aborted && options.signal?.aborted !== true) {
            throw new ExtHttpError(`${h.label} request timed out after ${timeoutMs}ms`);
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', relay);
    }
}
/** 错误包裹体取详情(message/error/detail 及嵌套 error.message)。 */
function errorDetail(payload) {
    if (typeof payload === 'string')
        return payload.trim() || undefined;
    if (typeof payload !== 'object' || payload === null)
        return undefined;
    const root = payload;
    const direct = (v) => (typeof v === 'string' && v !== '' ? v : undefined);
    const found = direct(root.message) ?? direct(root.error) ?? direct(root.detail);
    if (found !== undefined)
        return found;
    const nested = root.error;
    if (typeof nested === 'object' && nested !== null) {
        const n = nested;
        return direct(n.message) ?? direct(n.detail);
    }
    return undefined;
}
