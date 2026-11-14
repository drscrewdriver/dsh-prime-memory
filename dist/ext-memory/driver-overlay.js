let overlay;
/** 总闸的待生效值（undefined = 本进程没写过）。与 drivers 列表同理：写了 profile 但装配仍按启动值。 */
let pendingEnabled;
/** 当前应作为基线使用的列表:有 overlay 用它,否则用装配期快照。 */
export function currentDrivers(base) {
    return overlay === undefined ? base.slice() : overlay.slice();
}
/**
 * 在最新列表上算一次变更,**不**改 overlay。
 * 拆成 preview/commit 两步的原因:profile 写入(`updateConfig`)会失败——
 * 先落 overlay 再写失败,面板就会显示"已改"而盘上仍是旧值,比拒绝更坑。
 */
export function previewDrivers(base, fn) {
    return fn(currentDrivers(base));
}
/** 写入成功后才记入 overlay。 */
export function commitDrivers(list) {
    overlay = list.slice();
}
/**
 * 总闸的待生效记录（计划后续：面板开总闸）。
 *
 * 注意它与 `enabled` 回显的关系：面板与装配的“生效态”**仍读部署配置**，overlay 只用来
 * 说“已写入、重载后生效”。把待生效值当成生效值回显，会造出一个更难坑的状态：
 * 总闸“看起来开了”但驱动实例、第 5 路、pusher 闸门全都没动——正是“开关拨了行为不变”。
 */
export function commitEnabled(value) {
    pendingEnabled = value;
}
/** 待生效总闸（undefined = 无待生效写入）；调用方据此给 notice，不改生效态回显。 */
export function pendingEnabledValue() {
    return pendingEnabled;
}
/** 待生效值与当前生效值不一致（= 需要重载）。 */
export function hasPendingEnabled(base) {
    return pendingEnabled !== undefined && pendingEnabled !== base;
}
/** 是否存在"已写入但未生效"的改动(面板 banner 依据)。 */
export function hasPendingReload(base) {
    if (overlay === undefined)
        return false;
    if (overlay.length !== base.length)
        return true;
    return overlay.some((d, i) => {
        const b = base[i];
        return b === undefined || b.id !== d.id || b.endpoint !== d.endpoint || b.enabled !== d.enabled || b.type !== d.type;
    });
}
export function resetForTest() {
    overlay = undefined;
    pendingEnabled = undefined;
}
