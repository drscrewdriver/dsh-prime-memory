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

/** 布局服务（经 `ctx.get('layout')` 懒取，不进声明式 inject）。 */
export interface MemoryLayoutService {
  /** 选中某个 `main` keyed 面板；传 null 回到会话。宿主面板未注册该 id 时会抛。 */
  selectPanel(id: string | null): void;
}

/** apply(ctx) 收到的宿主上下文（对应 inject = ['slots']；其余服务懒解析）。 */
export interface MemoryClientCtx {
  slots: {
    /**
     * 向某个 slot 区域声明存在感；宿主挂载该区域时调用 factory 取注册句柄。
     *
     * 它同时是**座位探针**：factory 只在座位已被宿主声明时才跑（含晚声明与再次声明），
     * 所以上线探测“这个座位在不在”就靠它，不用另外的 spec API
     *（姊妹包 dsh-search-index 的双形态入口即此法）。
     * @param label 可选的 effect 标签，供宿主诊断树分组。
     * @returns 本探针/本次挂载的 disposer（与 register 同形，可直接交给卸载链）。
     */
    inject(slot: string, factory: () => unknown, label?: string): () => void;
    /**
     * 把组件连同选项（name/id/order/label/inject 等 slot 约定字段）登记进宿主。
     * @returns 幂等的 disposer；卸载顶栏行与主页面时按「先页后行」的序调用。
     */
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  /**
   * 按名取客户端世界服务（cordis 语义）。不把 connection 放进声明式 inject：
   * 它在部分宿主上缺席/晚到，声明式注入会让 apply 永久挂起（UI 全静默消失）。
   */
  get(name: string): unknown;
  /** 兼容旧形态：apply 时快照的 connection（可能 undefined）。 */
  connection?: {
    rpc: { call(channel: string, endpoint: string, payload?: unknown): Promise<unknown> };
  };
}
