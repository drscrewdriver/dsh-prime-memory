import { clip, extHitId, normContentKey } from './util.js';
/** 跨驱动 rank 交错:每家第 i 名依次入列(按 driverId 定序,确定性可复现)。 */
export function interleaveByRank(groups) {
    const sorted = [...groups].sort((a, b) => (a.driverId < b.driverId ? -1 : a.driverId > b.driverId ? 1 : 0));
    const maxDepth = sorted.reduce((m, g) => Math.max(m, g.hits.length), 0);
    const out = [];
    for (let rank = 0; rank < maxDepth; rank++) {
        for (const g of sorted) {
            const hit = g.hits[rank];
            if (hit !== undefined)
                out.push({ driverId: g.driverId, hit });
        }
    }
    return out;
}
export function makeExtLane(deps) {
    const breakers = new Map();
    const nowMs = deps.now ?? (() => Date.now());
    const breakerOf = (driverId) => {
        let b = breakers.get(driverId);
        if (b === undefined) {
            b = { failStreak: 0, openedUntil: 0, lastError: '' };
            breakers.set(driverId, b);
        }
        return b;
    };
    const isOpen = (driverId) => breakerOf(driverId).openedUntil > nowMs();
    const statusOf = () => deps.registry.list().map(({ driver, enabled }) => {
        const b = breakers.get(driver.id) ?? { failStreak: 0, openedUntil: 0, lastError: '' };
        return {
            driverId: driver.id,
            enabled,
            circuit: b.openedUntil > nowMs() ? 'open' : 'closed',
            failStreak: b.failStreak,
            openedUntil: b.openedUntil,
            lastError: b.lastError,
        };
    });
    const noteSuccess = (driverId) => {
        const b = breakerOf(driverId);
        if (b.failStreak !== 0 || b.openedUntil !== 0 || b.lastError !== '') {
            deps.logger?.info(`[memory] 外部驱动 ${driverId} 恢复(熔断闭合)`);
        }
        b.failStreak = 0;
        b.openedUntil = 0;
        b.lastError = '';
    };
    const noteFailure = (driverId, message) => {
        const b = breakerOf(driverId);
        b.failStreak++;
        b.lastError = message.slice(0, 300);
        const cfg = deps.cfg();
        if (b.failStreak >= cfg.failureThreshold && b.openedUntil <= nowMs()) {
            b.openedUntil = nowMs() + cfg.openMs;
            deps.logger?.warn(`[memory] 外部驱动 ${driverId} 连续失败 ${b.failStreak} 次,熔断 ${Math.round(cfg.openMs / 1000)}s:${b.lastError}`);
        }
    };
    const provider = async (query, limit, opts) => {
        // 族隔离:单族档会话整路缺席(auto 档 family=undefined 才进)
        if (opts?.family !== undefined)
            return [];
        const drivers = deps.registry.enabled().filter((d) => !isOpen(d.id));
        if (drivers.length === 0)
            return [];
        const cfg = deps.cfg();
        const perDriver = Math.min(cfg.maxItemsPerDriver, Math.max(1, limit));
        const settled = await Promise.allSettled(drivers.flatMap((driver) => deps.spacesOf(driver.id).map(async (space) => {
            const signal = AbortSignal.timeout(cfg.requestTimeoutMs);
            const result = await driver.search(space, { query, limit: perDriver }, signal);
            return { driverId: driver.id, hits: result.results ?? [] };
        })));
        const groups = [];
        for (const r of settled) {
            if (r.status === 'fulfilled') {
                groups.push([r.value.driverId, r.value.hits]);
                noteSuccess(r.value.driverId);
            }
        }
        const rejected = settled.filter((r) => r.status === 'rejected');
        if (rejected.length > 0) {
            // 粗粒度归因:未能对上号的失败也给"参与但零贡献"的驱动记一次(保守:
            // 只多记失败不多记成功;成功的驱动已在上面 noteSuccess 过)。
            const okDrivers = new Set(groups.map(([d]) => d));
            for (const d of drivers) {
                if (!okDrivers.has(d.id)) {
                    noteFailure(d.id, rejected[0]?.reason instanceof Error ? rejected[0].reason.message : String(rejected[0]?.reason ?? 'unknown'));
                }
            }
        }
        // 驱动内保持返回序(即该家的 rank 序);跨家 rank 交错 + 内容去重 + 总量封顶
        const seenContent = new Set();
        const keptGroups = [];
        for (const [driverId, hits] of groups) {
            const deduped = [];
            for (const h of hits) {
                const key = normContentKey(h.content);
                if (key === '' || seenContent.has(key))
                    continue;
                seenContent.add(key);
                deduped.push(h);
            }
            if (deduped.length > 0)
                keptGroups.push({ driverId, hits: deduped });
        }
        const out = [];
        for (const { driverId, hit } of interleaveByRank(keptGroups)) {
            if (out.length >= limit)
                break;
            // spaceId 从驱动首空间推(Phase 1 一驱动一空间;多空间时 externalId 已含空间位不冲突)
            const space = deps.spacesOf(driverId)[0];
            out.push({
                id: extHitId(driverId, space?.spaceId ?? 'main', hit.externalId),
                content: clip(hit.content, cfg.maxContentChars),
                type: hit.category === undefined ? 'external' : `external:${hit.category}`,
                scene_name: '',
                score: 0, // RRF 融合层的占位分,融合后被归一分覆盖(与 graphLane 同款)
            });
        }
        return out;
    };
    return { provider, statusOf, noteSuccess, noteFailure };
}
