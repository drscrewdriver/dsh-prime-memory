import { normContentKey } from './util.js';
/**
 * 回捞翻页上限。不翻页则条目多于 `scanLimit` 时靠后的永远匹配不到（shadow 无限 pending）；
 * 无上限则每次回捞都全库扫。两者都不是同量级的错，5 页是“能追到靠后条目”与
 * “不把 settle 跟成全库扫描”的折中；超出仍未命中则保持 pending，下个到期窗再试。
 */
const MAX_SCAN_PAGES = 5;
/** 命中即补链:shadow 的 external_id/db 指纹翻 clean;影子行原地 upsert 更新。 */
export async function settleShadow(driver, space, shadow, ctx, signal) {
    let externalId;
    const want = shadow.contentNorm;
    // 无指纹可配时根本不必扫远端（旧写法会白跑一次 list）。
    if (driver.list !== undefined && want !== '') {
        try {
            // 指纹匹配:归一化内容全等(参考实现 rememberMany 的 byte-identical 短路同一判据)
            // 翻页扫：旧写法只看第一页，条目多于 scanLimit 时靠后的永远匹配不到。
            const list = driver.list;
            for (let offset = 0, page = 0; page < MAX_SCAN_PAGES; page++) {
                const remote = await list.call(driver, space, { limit: ctx.scanLimit, offset }, signal);
                const hit = remote.hits.find((h) => normContentKey(h.content) === want);
                if (hit !== undefined) {
                    externalId = hit.externalId;
                    break;
                }
                offset += remote.hits.length;
                if (remote.hits.length === 0 || !remote.hasMore)
                    break;
            }
        }
        catch (err) {
            // list 不可用/抖动:本轮不算失败也不算命中,按 pending 处理(下个到期窗再试)
            ctx.logger?.warn(`[memory] 外部回捞 list 失败(${driver.id}): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (externalId !== undefined) {
        ctx.ext.upsertShadow({
            shadowId: shadow.shadowId,
            driverId: shadow.driverId,
            spaceId: shadow.spaceId,
            recordId: shadow.recordId,
            extKey: shadow.extKey,
            externalId,
            aliasOf: shadow.aliasOf,
            extUri: shadow.extUri,
            dbDigest: shadow.dbDigest,
            extDigest: shadow.extDigest,
            contentNorm: shadow.contentNorm,
            syncState: 'clean',
            lastSyncedAt: ctx.now,
        });
        return 'linked';
    }
    if (ctx.now > shadow.settleDeadline) {
        ctx.ext.upsertShadow({
            shadowId: shadow.shadowId,
            driverId: shadow.driverId,
            spaceId: shadow.spaceId,
            recordId: shadow.recordId,
            extKey: shadow.extKey,
            aliasOf: shadow.aliasOf,
            extUri: shadow.extUri,
            dbDigest: shadow.dbDigest,
            extDigest: shadow.extDigest,
            contentNorm: shadow.contentNorm,
            syncState: 'orphan',
            pendingOp: shadow.pendingOp,
            settleDeadline: shadow.settleDeadline,
        });
        return 'orphan';
    }
    return 'pending';
}
