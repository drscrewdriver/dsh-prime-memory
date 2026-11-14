/**
 * awaiting-settle 回捞(计划 T2.3):异步抽取家(Mem0/Hindsight/OpenViking/
 * Supermemory/ByteRover)的 remember 只回 operationId/task_id,不回 externalId——
 * 影子的终态不是 `linked` 而是 `awaiting_settle`,由本模块按**内容指纹**去远端
 * 把 externalId 捞回来。
 *
 * 为什么用内容匹配而不是 task 状态轮询(参考实现 openviking.settleTask 的形态):
 * 单次调用内轮询只服务"这一条且进程还活着";跨进程重启后 pendingOp 可能早已
 * 过期不可查,而**内容恒在**——`list()` 按归一化内容对上 externalId,是唯一
 * 重启后仍然成立的回捞路径(对齐 md 账本"digest 相认"的同款判据)。
 *
 * 诚实边界:远端二次蒸馏会改写正文(async-extracting 的语义),改写后的产物
 * 与本地正文指纹不同 → 回捞不中 → 到期转 orphan 挂账,**不猜**。
 * 宁可 orphan 让人看一眼,不可把"语义相近的另一条"错链成本地这条的远端身。
 */
import type { ExtSyncStore, ExtShadowRow } from './schema.js';
import type { ExternalMemoryDriver, ExtSpace } from './types.js';
import type { MemoryLogger } from '../types.js';
import { normContentKey } from './util.js';

/** settle 三态:linked=externalId 已回捞并落账;pending=未命中未超时;orphan=超时未命中。 */
export type SettleOutcome = 'linked' | 'pending' | 'orphan';

/**
 * 回捞翻页上限。不翻页则条目多于 `scanLimit` 时靠后的永远匹配不到（shadow 无限 pending）；
 * 无上限则每次回捞都全库扫。两者都不是同量级的错，5 页是“能追到靠后条目”与
 * “不把 settle 跟成全库扫描”的折中；超出仍未命中则保持 pending，下个到期窗再试。
 */
const MAX_SCAN_PAGES = 5;

export interface SettleCtx {
  ext: ExtSyncStore;
  scanLimit: number;
  now: number;
  logger?: MemoryLogger;
}

/** 命中即补链:shadow 的 external_id/db 指纹翻 clean;影子行原地 upsert 更新。 */
export async function settleShadow(
  driver: ExternalMemoryDriver,
  space: ExtSpace,
  shadow: ExtShadowRow,
  ctx: SettleCtx,
  signal?: AbortSignal,
): Promise<SettleOutcome> {
  let externalId: string | undefined;
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
        if (remote.hits.length === 0 || !remote.hasMore) break;
      }
    } catch (err) {
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
