/**
 * 记忆库跳转意图（模块单例，同 bundle 内共享）。
 *
 * 为什么需要：`dsh-brief-sidebar` 的「详细展示」只在 window 上发一个事件，而
 * 记忆库整页是宿主 `main` 座位按需挂载的——事件到达时页面可能还没挂载。意图
 * 先落在这里，`ExplorerPage` 挂载时 `take()`；页面已挂载时靠 `subscribe` 当场
 * 切模式。token 单调递增，连续两次跳转不会被 React 批处理吞掉。
 *
 * 三种模式与 ExplorerPage 的内部状态一一对应：
 * - `entry` → 查询模式 + 条目面板；
 * - `2d` / `3d` → 图模式 + 对应视图（可带 `recordId` 让既有 openRecord 聚焦实体）。
 */
export type ExplorerOpenMode = 'entry' | '2d' | '3d';

export interface ExplorerIntent {
  mode: ExplorerOpenMode;
  /** 可选：要聚焦的记忆 id（`mem_*`）；缺席 = 只切模式。 */
  recordId?: string;
}

export interface ExplorerIntentRequest {
  intent: ExplorerIntent;
  token: number;
}

type Listener = (request: ExplorerIntentRequest) => void;

let pending: ExplorerIntentRequest | undefined;
let token = 0;
const listeners = new Set<Listener>();

export const explorerIntent = {
  /** 记录最新意图并通知已挂载的整页；返回本次 token。 */
  request(intent: ExplorerIntent): number {
    token += 1;
    const request = { intent, token };
    pending = request;
    for (const listener of listeners) listener(request);
    return token;
  },

  /** 取走挂载前积压的意图（取走即清空，避免重复应用）。 */
  take(): ExplorerIntentRequest | undefined {
    const request = pending;
    pending = undefined;
    return request;
  },

  /** 订阅后续意图；退订函数与 set 语义一致。 */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
