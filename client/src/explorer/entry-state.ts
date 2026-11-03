/**
 * 记忆库入口的模块级状态单例（照 dshmarket 的 sidebar-entry + section-gate 思路）。
 *
 * 为什么存在：座位注册是 client `apply()` 期的一次性动作，若入口只在那时读一次
 * explorerEnabled，面板上拨开关就必须重启应用才见效——dshmarket 实证了更好的做法：
 * register/dispose 状态机 + 同 bundle 模块单例。本 client 与设置页在**同一个
 * JS 上下文**，OverviewTab 写成功后直接 notify，entry.tsx 订阅方当场重算挂载——
 * 即时显隐，零重启。
 *
 * 两条独立事实（与 market 同构）：
 *   - confirmed：首读 settings-get 是否完成——确认前不挂载，避免"先闪出再拆掉"；
 *   - wanted：用户当前的选择（首读结果或面板即时写入，后者更权威——epoch 式
 *     直接覆盖，慢到达的首读不得回头盖掉刚做的选择）。
 */
type Listener = (wanted: boolean) => void;

let wanted = true;
let confirmed = false;
/** 用户/面板已直接给过答案：慢到达的首读不得覆盖它（market 的 epoch 同义简化）。 */
let chosen = false;
const listeners = new Set<Listener>();

const notify = (): void => {
  for (const fn of listeners) fn(wanted);
};

export const explorerEntryState = {
  /** 当前选择（仅在 confirmed 后有意义）。 */
  isWanted: (): boolean => wanted,
  /** 首读是否已完成（entry.tsx 决定何时开放挂载）。 */
  isConfirmed: (): boolean => confirmed,
  /** settings-get 首读落定：面板还没被拨过时采纳该值。 */
  confirm(value: boolean): void {
    confirmed = true;
    if (chosen) return; // 用户已拨过，慢到达的首读作废
    wanted = value;
    notify();
  },
  /** 面板即时写入成功后调用：选择立刻生效（也是 confirmed）。 */
  set(value: boolean): void {
    wanted = value;
    chosen = true;
    confirmed = true;
    notify();
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
