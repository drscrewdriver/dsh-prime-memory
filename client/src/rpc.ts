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

/** 每次调用现取 connection(懒解析):apply 时它可能尚未就绪,快照会永久踩空。 */
function connectionOf(ctx: MemoryClientCtx): MemoryClientCtx['connection'] {
  const lazy = typeof ctx.get === 'function' ? (ctx.get('connection') as MemoryClientCtx['connection']) : undefined;
  return lazy ?? ctx.connection;
}

/**
 * RPC 通道优先级:0.1.5 起宿主把插件 RPC 收编到共享通道 /api(rpc.intercept),
 * 自定义前缀通道(旧 handle 注册的 /rpc)在 webServer 分发层静默 405。因此
 * 先试 /api,传输层失败(HTTP 4xx/5xx throw,信封 ok:false 不会 throw)自动
 * 回退 /rpc 兜旧宿主,成功后记忆通道避免每次双发。
 */
const RPC_CHANNELS: readonly string[] = ['/api', '/rpc'];
let rpcChannel: string | undefined;

export function makeRpc(ctx: MemoryClientCtx): RpcFn {
  return (endpoint, payload) => {
    // connection 是可选服务，可能晚于本插件就绪；缺席直接失败（fail loud）
    const conn = connectionOf(ctx);
    if (!conn || !conn.rpc) return Promise.reject(new Error('connection 服务不可用'));
    const call = (channel: string) =>
      conn.rpc.call(channel, endpoint, payload ?? {}) as unknown as Promise<RpcResult<never>>;
    const attempt = async (i: number): Promise<RpcResult<never>> => {
      const channel: string = rpcChannel ?? RPC_CHANNELS[i] ?? RPC_CHANNELS[RPC_CHANNELS.length - 1]!;
      try {
        const result = await call(channel);
        if (rpcChannel === undefined) rpcChannel = channel;
        return result;
      } catch (err) {
        // 信封内业务错误正常返回;走到这里 = 传输层失败(通道不存在/405/404)
        if (i + 1 < RPC_CHANNELS.length) return attempt(i + 1);
        throw err;
      }
    };
    return attempt(0) as unknown as Promise<RpcResult<never>>;
  };
}

/** 宽类型转发（运行时才决定端点名的动态分发处用，如 EmbeddingSection 的 call()）。 */
export type RpcLoose = (endpoint: DshMemoryEndpoint, payload?: unknown) => Promise<RpcResult<unknown>>;

export function asLoose(rpc: RpcFn): RpcLoose {
  return rpc as unknown as RpcLoose;
}
