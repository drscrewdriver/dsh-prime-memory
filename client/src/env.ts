/**
 * 浏览器半边的运行环境类型面（刻意保持最小）：宿主注入给 apply(ctx) 的能力，
 * 以及 handoff 工厂参数 require 的形状。官方 dsh-client-modules 未随包发布
 * 浏览器侧类型，这里只按本 bundle 实际触达的能力建模，多的一概不写。
 */

/**
 * handoff 工厂的 require 参数：bundle 以 CJS 形态在 factory(require) 内运行
 * （wrapper 由 scripts/build-client.mjs 生成），源码中对 external 模块的裸
 * require 调用在运行时解析到这个参数——浏览器全局并不存在 require。
 */
declare const require: (id: string) => unknown;

/** 对宿主 require 的受控出口（guarded require 官方原语模块时使用）。 */
export function hostRequire(id: string): unknown {
  return require(id);
}

/** apply(ctx) 收到的宿主上下文（对应 inject = ['slots', 'connection']）。 */
export interface MemoryClientCtx {
  slots: {
    /** 向某个 slot 区域声明存在感；宿主挂载该区域时调用 factory 取注册句柄。 */
    inject(slot: string, factory: () => unknown): unknown;
    /** 把组件连同选项（name/id/order/label/inject 等 slot 约定字段）登记进宿主。 */
    register(options: Record<string, unknown>, component: unknown): unknown;
  };
  /** 连接是可选服务：插件先于宿主就绪时可能缺席（rpc.ts 负责守卫）。 */
  connection?: {
    rpc: { call(channel: string, endpoint: string, payload?: unknown): Promise<unknown> };
  };
}
