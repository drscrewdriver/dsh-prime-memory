/** 一行一个"节点 —关系→ 节点"的可读摘要;孤立节点只写自身。 */
function summarize(driverId, snap, maxLines) {
    const labelOf = new Map(snap.nodes.map((n) => [n.externalId, n.label || n.externalId]));
    const lines = [];
    for (const e of snap.edges) {
        const from = labelOf.get(e.from) ?? e.from;
        const to = labelOf.get(e.to) ?? e.to;
        if (from === '' || to === '')
            continue;
        lines.push(`${from} —[${e.type}]→ ${to}`);
        if (lines.length >= maxLines)
            break;
    }
    if (lines.length < maxLines) {
        const linked = new Set(snap.edges.flatMap((e) => [e.from, e.to]));
        for (const n of snap.nodes) {
            if (linked.has(n.externalId))
                continue;
            lines.push(`${n.label || n.externalId}(${n.kind})`);
            if (lines.length >= maxLines)
                break;
        }
    }
    return lines.length === 0 ? [] : lines.map((l) => `[${driverId}] ${l}`);
}
export function makeExtGraphHints(deps) {
    const nowMs = deps.now ?? (() => Date.now());
    let cache;
    const hints = async () => {
        const cfg = deps.cfg();
        if (cfg.maxLinesPerDriver <= 0)
            return [];
        if (cache !== undefined && nowMs() - cache.at < cfg.cacheMs)
            return cache.lines;
        const lines = [];
        for (const driver of deps.registry.enabled()) {
            if (!driver.capabilities.graph || driver.graph === undefined)
                continue;
            const space = deps.spacesOf(driver.id)[0];
            if (space === undefined)
                continue;
            try {
                const snap = await driver.graph(space, AbortSignal.timeout(cfg.timeoutMs));
                lines.push(...summarize(driver.id, snap, cfg.maxLinesPerDriver));
            }
            catch (err) {
                deps.logger?.warn(`[memory] 外部图融合跳过 ${driver.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        cache = { at: nowMs(), lines };
        return lines;
    };
    const fn = hints;
    fn.invalidate = () => {
        cache = undefined;
    };
    return fn;
}
