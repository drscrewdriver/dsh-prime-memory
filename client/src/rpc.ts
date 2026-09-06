/**
 * 类型化 RPC 通道。端点全集 26 个（dsh-memory/*，含面板高权限删除
 * records-delete 与图谱 graph-search/graph-node-get），请求/响应形状一律查
 * src/contract.ts 的两张映射表（DshMemoryRequestMap / DshMemoryResponseMap——
 * 契约单一事实源）；import type 在 esbuild 构建期被整段擦除，bundle 零运行时依赖。
 */
import type { DshMemoryEndpoint, DshMemoryRequestMap, DshMemoryResponseMap } from '../../src/contract.js';
import type { MemoryClientCtx } from './env.js';

/**
 * RPC 结果信封：镜像宿主 dsh-host-apiproxy 的 RpcResult。宿主侧类型不随包发布，
 * 这里按信封事实形状声明；ok:false 走 resolve 不走 reject（瞬时错误也抵达调用方）。
 */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** 类型化调用函数：端点字面量 → 请求/响应类型自动查表。 */
export type RpcFn = <K extends DshMemoryEndpoint>(
  endpoint: K,
  payload?: DshMemoryRequestMap[K],
) => Promise<RpcResult<DshMemoryResponseMap[K]>>;

export function makeRpc(ctx: MemoryClientCtx): RpcFn {
  return (endpoint, payload) => {
    // connection 是可选服务，可能晚于本插件就绪；缺席直接失败（fail loud）
    if (!ctx.connection || !ctx.connection.rpc) return Promise.reject(new Error('connection 服务不可用'));
    // 信封由宿主 rpc 层保证；RpcResult<never> 协变可赋给任意 RpcResult<K>
    return ctx.connection.rpc.call('/rpc', endpoint, payload ?? {}) as unknown as Promise<RpcResult<never>>;
  };
}

/** 宽类型转发（运行时才决定端点名的动态分发处用，如 EmbeddingSection 的 call()）。 */
export type RpcLoose = (endpoint: DshMemoryEndpoint, payload?: unknown) => Promise<RpcResult<unknown>>;

export function asLoose(rpc: RpcFn): RpcLoose {
  return rpc as unknown as RpcLoose;
}
