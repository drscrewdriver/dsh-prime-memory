/**
 * 驱动编辑待生效层(计划 ext-driver-config-ui):配置写入落 profile,但本仓库
 * **没有插件热重载通道**——`config.extMemory.drivers` 在内存里保持启动时的值。
 *
 * 不做这层的后果很具体:用户连续编辑两个驱动,第二次仍基于旧内存值合并 →
 * 第一次的改动被静默覆盖;面板列表也看不到刚加的行,只能靠"重载后刷新"猜。
 *
 * 语义:overlay = 本进程内已写入 profile、但尚未被装配采纳的驱动列表。
 * 它不是影子配置——读侧只用于面板回显与后续合并基线,装配路径(assembly/pusher/
 * puller)一律不看它,所以**行为仍按启动配置**运行,与 needsReload 提示一致。
 */
import type { ExtDriverCfg } from './driver-config.js';

let overlay: ExtDriverCfg[] | undefined;
/** 总闸的待生效值（undefined = 本进程没写过）。与 drivers 列表同理：写了 profile 但装配仍按启动值。 */
let pendingEnabled: boolean | undefined;

/** 当前应作为基线使用的列表:有 overlay 用它,否则用装配期快照。 */
export function currentDrivers(base: readonly ExtDriverCfg[]): ExtDriverCfg[] {
  return overlay === undefined ? base.slice() : overlay.slice();
}

/**
 * 在最新列表上算一次变更,**不**改 overlay。
 * 拆成 preview/commit 两步的原因:profile 写入(`updateConfig`)会失败——
 * 先落 overlay 再写失败,面板就会显示"已改"而盘上仍是旧值,比拒绝更坑。
 */
export function previewDrivers<T extends { list: ExtDriverCfg[] }>(
  base: readonly ExtDriverCfg[],
  fn: (list: ExtDriverCfg[]) => T,
): T {
  return fn(currentDrivers(base));
}

/** 写入成功后才记入 overlay。 */
export function commitDrivers(list: readonly ExtDriverCfg[]): void {
  overlay = list.slice();
}

/**
 * 总闸的待生效记录（计划后续：面板开总闸）。
 *
 * 注意它与 `enabled` 回显的关系：面板与装配的“生效态”**仍读部署配置**，overlay 只用来
 * 说“已写入、重载后生效”。把待生效值当成生效值回显，会造出一个更难坑的状态：
 * 总闸“看起来开了”但驱动实例、第 5 路、pusher 闸门全都没动——正是“开关拨了行为不变”。
 */
export function commitEnabled(value: boolean): void {
  pendingEnabled = value;
}

/** 待生效总闸（undefined = 无待生效写入）；调用方据此给 notice，不改生效态回显。 */
export function pendingEnabledValue(): boolean | undefined {
  return pendingEnabled;
}

/** 待生效值与当前生效值不一致（= 需要重载）。 */
export function hasPendingEnabled(base: boolean): boolean {
  return pendingEnabled !== undefined && pendingEnabled !== base;
}

/** 是否存在"已写入但未生效"的改动(面板 banner 依据)。 */
export function hasPendingReload(base: readonly ExtDriverCfg[]): boolean {
  if (overlay === undefined) return false;
  if (overlay.length !== base.length) return true;
  return overlay.some((d, i) => {
    const b = base[i];
    return b === undefined || b.id !== d.id || b.endpoint !== d.endpoint || b.enabled !== d.enabled || b.type !== d.type;
  });
}

export function resetForTest(): void {
  overlay = undefined;
  pendingEnabled = undefined;
}
