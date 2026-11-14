/**
 * 入站拉取泵(计划 T3.1):list / sincePull → 四象限对账 → 只外变回灌。
 *
 * ## 四象限判定(以影子的两个指纹为基准)
 * - 本地未变 + 远端未变 → skip(只刷 lastSyncedAt);
 * - 本地变 + 远端未变   → 等推送侧覆盖(本地已在 outbox 有 add),skip;
 * - **本地未变 + 远端变** → 回灌:同 id 改写本地正文(reviseInPlace,事实源留版本行);
 * - 两边都变           → **挂账不动**(ext_conflicts both_dirty,面板人工裁决)。
 *
 * ## 循环防护三件套(缺一个就是永动机/记忆增殖)
 * 1. **ext_key 幂等**:回灌新建前 `findIdByExtKey` pre-check——同一
 *    (驱动:空间, externalId) 派生的 extKey 命中已有记录时不新建,只补影子映射;
 * 2. **externalId 映射判同条**:先建影子(带 externalId + dbDigest)再 appendNew,
 *    推送侧派发时 digest 相同已链 → skip,回灌不会被自己的钩子再推回远端;
 * 3. **外部永不进候选池**:回灌走 appendNew 写入内核,L1Store 的 extLane 哨兵
 *    (`assertNotDedupPath`)保证外部路不参与去重候选——本泵不调 search/候选。
 *
 * ## 墓碑硬闸(遗忘赛道不复活)
 * 命中本地墓碑内容指纹的远端条目**一律不回灌**,挂 `unforgettable` 冲突:
 * 远端还在、本地已遗忘 = 事实分歧,只有人能在面板上裁决;自动复活是"忘记
 * 被同步覆盖"的环路根源。
 */
import { randomBytes, createHash } from 'node:crypto';
import { isKnownType } from '../memory-types.js';
import { canSync } from './types.js';
import { isCapabilityMissing, normContentKey, recordDigest, sha256Hex } from './util.js';
import { shadowIdFor } from './pusher.js';
const emptyStats = () => ({ drivers: 0, pulled: 0, imported: 0, refreshed: 0, conflicts: 0, skipped: 0, failed: 0, skippedUnsupported: 0, truncation: 'none' });
/** 单次 list 请求的页大小（各家驱动再按服务端上限二次 clamp）。 */
const LIST_PAGE_LIMIT = 500;
let seq = 0;
/** 记录 id 与 pipeline 的 `newId('mem')` 同款形制(前缀_时刻_随机)。 */
function newExtId(now) {
    return `mem_${now}_${randomBytes(3).toString('hex')}${(seq++ % 16).toString(16)}`;
}
/** 与 tools 的 computeExtKey 同算法;sourceId 取 `ext:<driver>:<space>` 避免与 memory_add 源撞名。 */
function extKeyOf(driverId, spaceExternalId, externalId, content) {
    const identity = externalId !== '' ? externalId : normContentKey(content);
    return createHash('sha1').update(`ext:${driverId}:${spaceExternalId}\u0000${identity}`, 'utf8').digest('hex');
}
export function makeExtPuller(deps) {
    const nowMs = deps.now ?? (() => Date.now());
    const enabledNow = () => {
        const c = deps.cfg();
        // 拉取只在 two-way 下开:push-only 是"只出"语义,shadow-read 是只读融合(Phase 1 已定)
        return c.masterEnabled && c.enabled && c.syncMode === 'two-way';
    };
    const runBatch = async () => {
        const stats = emptyStats();
        if (!enabledNow())
            return stats;
        await deps.beforeBatch?.();
        const cfg = deps.cfg();
        const drivers = deps.registry.enabled().filter((d) => canSync(d.capabilities));
        stats.drivers = drivers.length;
        for (const driver of drivers) {
            for (const space of deps.spacesOf(driver.id)) {
                if (deps.cfg().masterEnabled !== true)
                    return stats; // 跑到一半被关:立即停
                try {
                    await pullSpace(driver, space, stats, cfg);
                }
                catch (err) {
                    stats.failed++;
                    deps.logger?.warn(`[memory] 外部拉取失败(${driver.id}/${space.spaceId}): ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        return stats;
    };
    /** 多个空间各自的完整性合并：任一未到底就不是 none，两种不同的未到底 = partial。 */
    const mergeTruncation = (a, b) => {
        if (a === 'none')
            return b;
        if (b === 'none')
            return a;
        return a === b ? a : 'partial';
    };
    /**
     * 翻页拉全：offset 递进，直到 `hasMore=false` / 达 maxItems / 时间预算耗尽。
     *
     * 旧写法只调一次 `list`——而各家驱动内部还会按服务端上限二次 clamp（100~1000），
     * 所以 `cfg.maxItems=2000` 实际最多拿到 100~1000 条，且每轮重复拿同一页头部。
     * capped/budget 必须如实上报：把“没取完”说成“取完了”，用户会直接拿它当全量导入结果。
     */
    const listAll = async (driver, space, cfg, signal, stats) => {
        const list = driver.list;
        if (list === undefined)
            return { hits: [], truncation: 'complete' };
        const hits = [];
        const max = Math.max(1, cfg.maxItems);
        const deadline = Date.now() + Math.max(1_000, cfg.timeBudgetMs);
        let capped = false;
        let budget = false;
        for (let offset = 0;;) {
            if (hits.length >= max) {
                capped = true;
                break;
            }
            if (Date.now() >= deadline) {
                budget = true;
                break;
            }
            const page = await list.call(driver, space, { limit: Math.min(LIST_PAGE_LIMIT, max - hits.length), offset }, signal);
            if (page.hits.length === 0)
                break;
            hits.push(...page.hits);
            offset += page.hits.length;
            if (!page.hasMore)
                break;
        }
        if (hits.length >= max)
            capped = true;
        const truncation = capped ? 'capped' : budget ? 'budget' : 'complete';
        stats.truncation = mergeTruncation(stats.truncation, capped && budget ? 'partial' : capped ? 'capped' : budget ? 'budget' : 'none');
        return { hits, truncation };
    };
    const pullSpace = async (driver, space, stats, cfg) => {
        const signal = AbortSignal.timeout(Math.max(5_000, Math.min(cfg.timeBudgetMs, 120_000)));
        let entries;
        // 入站取数分三条路，**不得把三者当成同一种失败**：
        //   ① 游标已实装 → 增量拉；② 游标未实装但能翻页 → 全量翻页；③ 两者都没 → 记 skippedUnsupported。
        // 旧写法用 `driver.sincePull !== undefined` 作判据，而必需方法表迫使各家都放了会抛错的桩
        // → 判据恒真，本来可用的 list 永远走不到，拉取方向 0 家能跑通。
        if (driver.capabilities.incremental && driver.sincePull !== undefined) {
            try {
                const cursor = deps.ext.getCursor(driver.id, space.spaceId);
                const r = await driver.sincePull(space, cursor, signal);
                entries = r.entries;
                // 游标只在整批对账成功后推进(中途抛错 → 下轮从旧断点重拉,幂等兜住)
                deps.ext.setCursor(driver.id, space.spaceId, r.next);
            }
            catch (err) {
                // 分流：能力没接才回落；远端真故障必须上抛计入 failed——
                // 无差别 catch 会把临时故障静默降级成“从头全量翻页”，在游标语义下可能重复导入或漏增量。
                if (!isCapabilityMissing(err, 'sincePull'))
                    throw err;
                const p = await listAll(driver, space, cfg, signal, stats);
                entries = p.hits;
            }
        }
        else if (driver.list !== undefined) {
            const p = await listAll(driver, space, cfg, signal, stats);
            entries = p.hits;
        }
        else {
            stats.skippedUnsupported++;
            return; // 无入站面（byterover：无 list 且无游标）：不是故障，不记 failed
        }
        stats.pulled += entries.length;
        for (const hit of entries) {
            try {
                await reconcileOne(driver, space, hit, stats, cfg);
            }
            catch (err) {
                stats.failed++;
                deps.logger?.warn(`[memory] 外部对账单条失败(${driver.id}): ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    };
    const conflict = (driver, space, recordId, externalId, kind, detail, digests) => {
        deps.ext.upsertConflict({
            conflictId: `cf_${nowMs().toString(36)}_${randomBytes(4).toString('hex')}`,
            driverId: driver.id,
            spaceId: space.spaceId,
            recordId,
            externalId,
            kind,
            dbDigest: digests?.db ?? '',
            extDigest: digests?.ext ?? '',
            detail,
        });
    };
    const touchShadow = (shadow, patch) => {
        deps.ext.upsertShadow({
            shadowId: shadow.shadowId,
            driverId: shadow.driverId,
            spaceId: shadow.spaceId,
            recordId: shadow.recordId,
            extKey: shadow.extKey,
            externalId: patch.externalId ?? shadow.externalId,
            aliasOf: shadow.aliasOf,
            extUri: shadow.extUri,
            dbDigest: patch.dbDigest ?? shadow.dbDigest,
            extDigest: patch.extDigest ?? shadow.extDigest,
            contentNorm: patch.contentNorm ?? shadow.contentNorm,
            syncState: patch.syncState ?? shadow.syncState,
            pendingOp: shadow.pendingOp,
            settleDeadline: shadow.settleDeadline,
            lastSyncedAt: nowMs(),
        });
    };
    const reconcileOne = async (driver, space, hit, stats, cfg, 
    /**
     * `reconcile` = 持续对账（四象限判定 + families 过滤）；
     * `import` = 首次全量导入（已有影子直接 skip，不看 families；但仍走幂等与墓碑闸）。
     *
     * 为何不直接复用 runBatch：它的 `syncMode==='two-way'`、families 白名单、“本地已变则 skip”
     * 三道过滤会把首次导入变成“被本地状态过滤过的残缺结果”，而面板上看起来像全量导入完了。
     */
    mode = 'reconcile') => {
        const remoteNorm = normContentKey(hit.content);
        if (remoteNorm === '' || hit.externalId === '') {
            stats.skipped++;
            return;
        }
        const remoteDigest = sha256Hex(remoteNorm);
        const shadow = deps.ext.getShadowByExternal(driver.id, space.spaceId, hit.externalId);
        if (shadow !== undefined) {
            // 导入模式不碰已有影子：它要的是“把没入库的条目搬进来”，而不是再跑一遍对账判定；
            // 已存即已导过，重跑只会把两边都变的条目挂成 both_dirty 噪声。
            if (mode === 'import') {
                stats.skipped++;
                return;
            }
            const rec = deps.l1.getByIds([shadow.recordId])[0];
            const localDigest = rec === undefined ? '' : recordDigest(rec);
            const localChanged = rec !== undefined && localDigest !== shadow.dbDigest;
            const remoteChanged = shadow.contentNorm !== remoteNorm;
            if (!remoteChanged) {
                stats.skipped++;
                return; // 远端未变:本地变不归入站管(outbox 会推)
            }
            if (localChanged) {
                // 两边都变:挂账不动——自动合并是"谁后写谁赢"的赌博,面板上让人看两版
                touchShadow(shadow, { syncState: 'both_dirty' });
                conflict(driver, space, shadow.recordId, hit.externalId, 'both_dirty', {
                    preview: hit.content.slice(0, 300),
                    localPreview: rec.content.slice(0, 300),
                }, { db: localDigest, ext: remoteDigest });
                stats.conflicts++;
                return;
            }
            if (rec === undefined) {
                // 本地记录已物理清理而远端还在:不自动新建(那是复活),挂账
                conflict(driver, space, shadow.recordId, hit.externalId, 'unforgettable', {
                    why: 'local record purged, remote still present',
                    preview: hit.content.slice(0, 300),
                }, { ext: remoteDigest });
                stats.conflicts++;
                return;
            }
            // 墓碑硬闸:本地遗忘过同内容 → 不复活
            if (deps.isTombstoned !== undefined && deps.isTombstoned(remoteNorm)) {
                conflict(driver, space, shadow.recordId, hit.externalId, 'unforgettable', {
                    why: 'tombstoned content reappeared remotely',
                    preview: hit.content.slice(0, 300),
                }, { db: localDigest, ext: remoteDigest });
                stats.conflicts++;
                return;
            }
            // 只外变 → 回灌同 id
            const revised = {
                ...rec,
                content: hit.content,
                updatedAt: nowMs(),
                timestamps: [...(rec.timestamps ?? []), nowMs()],
            };
            await deps.l1.reviseInPlace(revised);
            touchShadow(shadow, {
                dbDigest: recordDigest(revised),
                contentNorm: remoteNorm,
                extDigest: remoteDigest,
                syncState: 'clean',
            });
            stats.refreshed++;
            return;
        }
        // 影子不存在 = 新外部实体
        if (deps.isTombstoned !== undefined && deps.isTombstoned(remoteNorm)) {
            conflict(driver, space, '', hit.externalId, 'unforgettable', {
                why: 'tombstoned content reappeared remotely (no shadow)',
                preview: hit.content.slice(0, 300),
            }, { ext: remoteDigest });
            stats.conflicts++;
            return;
        }
        const family = 'work'; // 回灌族固定 work:ExternalHit 无族概念,个人 chat 不进外部往返
        // families 是“对账要同步哪些族”的策略闸，首次导入不受它限（否则“全量导入”会默默漏族）。
        if (mode === 'reconcile' && cfg.families.size > 0 && !cfg.families.has(family)) {
            stats.skipped++;
            return;
        }
        const extKey = extKeyOf(driver.id, space.externalId, hit.externalId, hit.content);
        const knownId = deps.l1.findIdByExtKey(extKey);
        if (knownId !== undefined) {
            // 幂等件套 1:同源同身份已入库(重建丢了影子/换过驱动)→ 只补映射,不新建
            const known = deps.l1.getByIds([knownId])[0];
            deps.ext.upsertShadow({
                shadowId: shadowIdFor(driver.id, space.spaceId, knownId),
                driverId: driver.id,
                spaceId: space.spaceId,
                recordId: knownId,
                extKey,
                externalId: hit.externalId,
                extUri: hit.uri ?? '',
                dbDigest: known === undefined ? '' : recordDigest(known),
                extDigest: remoteDigest,
                contentNorm: remoteNorm,
                syncState: 'clean',
                lastSyncedAt: nowMs(),
            });
            stats.skipped++;
            return;
        }
        const now = nowMs();
        const rec = {
            id: newExtId(now),
            content: hit.content,
            // type 必须落词表内值：远端 category 是任意串（hindsight 给 temporal/semantic/causal/entity，
            // openviking 给文件类别），直接写进去会让面板筛不到、md 目录落到 unclassified。
            // 原值不丢，另存 metadata.extCategory；external_fact 已在词表但不在 prompt 枚举（NON_EXTRACT_TYPES）。
            type: hit.category !== undefined && isKnownType(hit.category) ? hit.category : 'external_fact',
            priority: 50,
            scene_name: 'ext-import',
            timestamps: [now],
            createdAt: now,
            updatedAt: now,
            family: 'work', // 回灌族固定 work:ExternalHit 无族概念,个人 chat 不进外部往返
            extKey,
            metadata: {
                origin: `external:${driver.id}`,
                externalId: hit.externalId,
                // 远端原始 category 保留在此（type 已归一为词表内值）：详情页要能回答“它在对方库里算哪类”。
                ...(hit.category === undefined ? {} : { extCategory: hit.category }),
            },
        };
        // 幂等件套 2:先建影子再写库——appendNew 触发的 push 钩子入队后,
        // 派发时影子已带 externalId 且 digest 相同 → 写放大闸直接 skip,不回推。
        deps.ext.upsertShadow({
            shadowId: shadowIdFor(driver.id, space.spaceId, rec.id),
            driverId: driver.id,
            spaceId: space.spaceId,
            recordId: rec.id,
            extKey,
            externalId: hit.externalId,
            extUri: hit.uri ?? '',
            dbDigest: recordDigest(rec),
            extDigest: remoteDigest,
            contentNorm: remoteNorm,
            syncState: 'clean',
            lastSyncedAt: now,
        });
        await deps.l1.appendNew([rec]);
        stats.imported++;
    };
    /**
     * 首次全量导入（计划 ext-to-l1-import）：与 `runBatch` 共用入库内核，但**不受入站闸门约束**。
     *
     * 不走 `enabledNow()`（它要求 `syncMode==='two-way'` 与 `pull.enabled`）：导入是面板上
     * 显式人驱动作，与持续同步档位解耦；否则用户处于 shadow-read 档时导入会“看起来被拒绝”。
     * 但两道与语义无关的安全闸保留：`ext_key` 幂等（不重复入库）与墓碑硬闸（遗忘不复活）。
     */
    const importSpace = async (opts) => {
        const summary = {
            pulled: 0, imported: 0, skipped: 0, conflicts: 0, failed: 0, offset: 0, truncation: 'complete',
        };
        const entry = deps.registry.list().find((e) => e.driver.id === opts.driverId);
        if (entry === undefined)
            throw new Error(`外部驱动「${opts.driverId}」未装配（总闸未开、已停用，或需重载）`);
        if (!entry.enabled)
            throw new Error(`外部驱动「${opts.driverId}」已停用，先启用再导入`);
        const driver = entry.driver;
        if (driver.list === undefined) {
            summary.truncation = 'unsupported';
            return summary; // 该家无遍历面（byterover）：不是故障，也不能谎称导入完了
        }
        await deps.beforeBatch?.();
        const cfg = deps.cfg();
        const stats = emptyStats();
        const deadline = Date.now() + Math.max(1_000, opts.timeBudgetMs);
        let remaining = Math.max(1, opts.maxItems);
        const spaces = deps.spacesOf(driver.id).filter((s) => opts.spaceId === undefined || s.spaceId === opts.spaceId);
        if (spaces.length === 0)
            throw new Error(`驱动「${opts.driverId}」没有可导入的空间`);
        for (const space of spaces) {
            let offset = space.spaceId === (opts.spaceId ?? spaces[0]?.spaceId) ? Math.max(0, opts.startOffset ?? 0) : 0;
            for (;;) {
                if (remaining <= 0) {
                    summary.truncation = 'capped';
                    break;
                }
                if (Date.now() >= deadline) {
                    summary.truncation = 'budget';
                    break;
                }
                const signal = AbortSignal.timeout(Math.max(5_000, Math.min(60_000, deadline - Date.now())));
                const page = await driver.list(space, { limit: Math.min(LIST_PAGE_LIMIT, remaining), offset }, signal);
                stats.pulled += page.hits.length;
                for (const hit of page.hits) {
                    try {
                        await reconcileOne(driver, space, hit, stats, cfg, 'import');
                    }
                    catch (err) {
                        stats.failed++;
                        deps.logger?.warn(`[memory] 外部导入单条失败(${driver.id}): ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
                remaining -= page.hits.length;
                summary.offset = offset + page.hits.length;
                // 每页提交后落断点：崩了不重复嵌入已完成条目（嵌入是本次最贵的一项）。
                const stop = opts.onPage?.({
                    spaceId: space.spaceId, offset: summary.offset, imported: stats.imported, skipped: stats.skipped, hasMore: page.hasMore,
                });
                offset = summary.offset;
                if (page.hits.length === 0 || !page.hasMore)
                    break;
                if (stop === true) {
                    summary.truncation = 'cancelled';
                    break;
                }
            }
            if (summary.truncation === 'capped' || summary.truncation === 'budget' || summary.truncation === 'cancelled')
                break;
        }
        summary.pulled = stats.pulled;
        summary.imported = stats.imported;
        summary.skipped = stats.skipped;
        summary.conflicts = stats.conflicts;
        summary.failed = stats.failed;
        return summary;
    };
    return { runBatch, importSpace };
}
