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
/** 当前应作为基线使用的列表:有 overlay 用它,否则用装配期快照。 */
export declare function currentDrivers(base: readonly ExtDriverCfg[]): ExtDriverCfg[];
/**
 * 在最新列表上算一次变更,**不**改 overlay。
 * 拆成 preview/commit 两步的原因:profile 写入(`updateConfig`)会失败——
 * 先落 overlay 再写失败,面板就会显示"已改"而盘上仍是旧值,比拒绝更坑。
 */
export declare function previewDrivers<T extends {
    list: ExtDriverCfg[];
}>(base: readonly ExtDriverCfg[], fn: (list: ExtDriverCfg[]) => T): T;
/** 写入成功后才记入 overlay。 */
export declare function commitDrivers(list: readonly ExtDriverCfg[]): void;
/**
 * 总闸的待生效记录（计划后续：面板开总闸）。
 *
 * 注意它与 `enabled` 回显的关系：面板与装配的“生效态”**仍读部署配置**，overlay 只用来
 * 说“已写入、重载后生效”。把待生效值当成生效值回显，会造出一个更难坑的状态：
 * 总闸“看起来开了”但驱动实例、第 5 路、pusher 闸门全都没动——正是“开关拨了行为不变”。
 */
export declare function commitEnabled(value: boolean): void;
/** 待生效总闸（undefined = 无待生效写入）；调用方据此给 notice，不改生效态回显。 */
export declare function pendingEnabledValue(): boolean | undefined;
/** 待生效值与当前生效值不一致（= 需要重载）。 */
export declare function hasPendingEnabled(base: boolean): boolean;
/** 是否存在"已写入但未生效"的改动(面板 banner 依据)。 */
export declare function hasPendingReload(base: readonly ExtDriverCfg[]): boolean;
export declare function resetForTest(): void;
