/**
 * `l1_records.metadata_json` 里承载锚点集合的**保留键**。
 *
 * 加前缀 `dsh_` 是为了与 LLM 产出的 metadata 键(`hall` / `activity_start_time` 等)
 * 在命名空间上隔开——写库时两者会被合并进同一个 JSON 对象(见 `withSourceAnchors`)。
 */
export const ANCHOR_METADATA_KEY = 'dsh_source_anchors';
/** 锚点的规范性比较键:`turn` 升序,`step` 缺失排在同 turn 的最前。 */
function anchorOrderKey(a) {
    const step = typeof a.step === 'number' ? String(a.step).padStart(6, '0') : '000000';
    return `${a.sessionId}\u0000${String(a.turn).padStart(10, '0')}\u0000${step}`;
}
/**
 * 建立 `L0 消息 id → 锚点` 映射。
 *
 * 只收录**带锚点**的消息:没有内核坐标的消息(老数据、无 turn 的事件)不进映射,
 * 于是它在 `resolveSourceAnchors` 里自然落进"未命中"分支,而不是被伪造一个坐标。
 */
export function buildAnchorMap(messages) {
    const map = new Map();
    for (const m of messages) {
        if (m.anchor !== undefined && Number.isFinite(m.anchor.turn)) {
            map.set(m.id, m.anchor);
        }
    }
    return map;
}
/**
 * 把一条记忆的 `source_message_ids` 解析成去重、有序的锚点集合。
 *
 * - 命中映射 → 收下该锚点
 * - 未命中(LLM 引用了背景消息、或该消息本就没有坐标) → **丢弃**
 * - 结果为空 → 返回 `undefined`,由调用方按"无锚点"处理(不是空数组)
 */
export function resolveSourceAnchors(sourceMessageIds, anchors) {
    if (sourceMessageIds === undefined || sourceMessageIds.length === 0)
        return undefined;
    const byKey = new Map();
    for (const id of sourceMessageIds) {
        const a = anchors.get(id);
        if (a === undefined)
            continue;
        const key = anchorOrderKey(a);
        if (!byKey.has(key))
            byKey.set(key, a);
    }
    if (byKey.size === 0)
        return undefined;
    return [...byKey.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, a]) => a);
}
/**
 * 把锚点集合写进 metadata(返回**新对象**,不改入参——不可变更新)。
 *
 * 无锚点时不写键:老记录与"解析不到坐标"的记录保持与改动前**逐字一致的**
 * metadata,这样既有导出/比对/测试不会被一个空数组搅动。
 */
export function withSourceAnchors(metadata, anchors) {
    const base = metadata ?? {};
    if (anchors === undefined || anchors.length === 0)
        return base;
    return { ...base, [ANCHOR_METADATA_KEY]: anchors };
}
/**
 * 从 metadata 读回锚点集合(读侧唯一入口)。
 *
 * 形状校验从严:任何一项缺 `turn` 或类型不对 → 该项丢弃;全丢 → `undefined`。
 * 宁可报告"无锚点",也不把半截坐标喂给下游的证据读取器。
 */
export function readSourceAnchors(metadata) {
    if (metadata === null || typeof metadata !== 'object')
        return undefined;
    const raw = metadata[ANCHOR_METADATA_KEY];
    if (!Array.isArray(raw))
        return undefined;
    const out = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const o = item;
        const sessionId = o.sessionId;
        const turn = o.turn;
        if (typeof sessionId !== 'string' || typeof turn !== 'number' || !Number.isFinite(turn))
            continue;
        const anchor = { sessionId, turn };
        if (typeof o.step === 'number' && Number.isFinite(o.step))
            anchor.step = o.step;
        out.push(anchor);
    }
    return out.length > 0 ? out : undefined;
}
