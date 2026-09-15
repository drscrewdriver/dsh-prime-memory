/**
 * 面板数据通道(0.1.5 契约):浏览器原生 fetch 直连宿主半注册的
 * `POST /dsh-memory/rpc/<method>` 路由,信封即 RpcResult——不再经过
 * connection.rpc(handle 前缀通道在 0.1.5 静默 405;/api interceptor 单槽
 * 会被他插件抢占)。
 *
 * 端点字面量 → 请求/响应类型自动查表(src/contract.ts 两张映射表,
 * 契约单一事实源);import type 在 esbuild 构建期被整段擦除。
 */
import type { DshMemoryEndpoint, DshMemoryRequestMap, DshMemoryResponseMap } from '../../src/contract.js';
import type { MemoryClientCtx } from './env.js';

/**
 * RPC 结果信封：镜像宿主写入的 RpcResult。ok:false 走 resolve 不走 reject
 * （业务错误也抵达调用方）；网络/HTTP 层失败走 reject（fail loud，与旧
 * connection.rpc 的 transport failure 行为一致）。
 */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** 类型化调用函数：端点字面量 → 请求/响应类型自动查表。 */
export type RpcFn = <K extends DshMemoryEndpoint>(
  endpoint: K,
  payload?: DshMemoryRequestMap[K],
) => Promise<RpcResult<DshMemoryResponseMap[K]>>;

/** 'dsh-memory/stats' → 'stats'（URL 短方法名,宿主半按前缀拼回）。 */
function shortMethod(endpoint: string): string {
  return endpoint.startsWith('dsh-memory/') ? endpoint.slice('dsh-memory/'.length) : endpoint;
}

export function makeRpc(_ctx: MemoryClientCtx): RpcFn {
  return (async (endpoint: DshMemoryEndpoint, payload?: unknown) => {
    let response: Response;
    try {
      response = await fetch(`/dsh-memory/rpc/${shortMethod(endpoint)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
    } catch (err) {
      throw new Error(`transport failure for ${endpoint}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) throw new Error(`transport failure for ${endpoint}: HTTP ${response.status}`);
    return (await response.json()) as RpcResult<never>;
  }) as RpcFn;
}

/** 宽类型转发（运行时才决定端点名的动态分发处用，如 EmbeddingSection 的 call()）。 */
export type RpcLoose = (endpoint: DshMemoryEndpoint, payload?: unknown) => Promise<RpcResult<unknown>>;

export function asLoose(rpc: RpcFn): RpcLoose {
  return rpc as unknown as RpcLoose;
}
