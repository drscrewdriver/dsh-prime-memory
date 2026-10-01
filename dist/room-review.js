import { isTag } from './metadata-validators.js';
import { callLLM, parseJsonLogged } from './llm.js';
export const ROOM_CANDIDATES_KEY = 'roomCandidates';
export const ROOM_REVIEW_KEY = 'roomReview';
/** 解析标注器输出的逐条候选(容错:id 配对失败丢弃;isTag 校验;目录内优先,≤3)。 */
export function parseRoomCandidateItems(parsed, ids, roomCatalog) {
    const idSet = new Set(ids);
    const catalogSet = new Set(roomCatalog.map((r) => r.room));
    const byId = new Map();
    for (const item of parsed) {
        if (!idSet.has(item.id))
            continue;
        const cleaned = [];
        for (const r of item.rooms) {
            const slug = typeof r === 'string' ? r.trim().toLowerCase() : '';
            if (!slug || !isTag(slug))
                continue;
            if (!cleaned.includes(slug))
                cleaned.push(slug);
        }
        // 目录内优先排前,其余兜底;截断到 3
        cleaned.sort((a, b) => Number(catalogSet.has(b)) - Number(catalogSet.has(a)));
        byId.set(item.id, cleaned.slice(0, 3));
    }
    return [...byId.entries()].map(([id, rooms]) => ({ id, rooms }));
}
/** 候选标注系统 prompt:喂现有 Room 词表(带计数),优先挂靠、少量新建兜底。 */
export function roomCandidateSystemPrompt(roomCatalog) {
    const catalog = roomCatalog.length > 0
        ? roomCatalog
            .slice(0, 40)
            .map((r) => `- ${r.room}(现有 ${r.count} 条)`)
            .join('\n')
        : '(暂无现有 Room)';
    return ('你是记忆库的 Room 归类器。给你若干条记忆(带 id)与现有 Room 词表(带计数),' +
        '为每条记忆选出它最可能归属的 1-3 个 Room slug。规则:\n' +
        '1. **优先从现有 Room 词表里选**(保持分类收敛,避免碎片化);\n' +
        '2. 词表确实没有合适主题时,才提议最多 2 个新 slug(小写字母/数字/连字符);\n' +
        '3. 完全无法判断时返回空数组(宁缺毋滥,不硬猜)。\n' +
        `现有 Room 词表:\n${catalog}\n\n` +
        '输出 JSON 数组:[{"id":"<原id>","rooms":["slug1","slug2"]}]。只输出 JSON,不要多余文字。');
}
/** 候选标注器:一批孤儿记录 → 候选 Room(优先现有词表;失败返回空,调用方零改动)。 */
export async function roomCandidateChunk(ctx, cfg, logger, chunk, roomCatalog) {
    const list = chunk.map((r, i) => `${i + 1}. id=${r.id}\n${r.content.slice(0, 300)}`).join('\n\n');
    try {
        const raw = await callLLM(ctx, cfg, {
            system: roomCandidateSystemPrompt(roomCatalog),
            user: `记忆列表:\n${list}`,
            maxTokens: 4096,
            layer: 'l1-extract',
            logger,
        });
        const parsed = parseJsonLogged(raw, 'Room 候选标注', logger);
        if (!Array.isArray(parsed))
            return [];
        const shape = parsed
            .map((item) => ({
            id: typeof item?.id === 'string' ? item.id : '',
            rooms: Array.isArray(item?.rooms) ? item.rooms : [],
        }))
            .filter((x) => x.id !== '');
        return parseRoomCandidateItems(shape, chunk.map((r) => r.id), roomCatalog);
    }
    catch (err) {
        logger.warn(`[memory] Room 候选标注块失败(跳过 ${chunk.length} 条,原记录未改): ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}
/** 活跃孤儿的选择器:untagged + 未退场,跳过已 skipped 的。 */
function selectPendingOrphans(l1, limit) {
    const out = [];
    const seen = new Set();
    for (let offset = 0; offset < 2000; offset += 200) {
        const page = l1.list({ untagged: true, retired: false, limit: 200, offset });
        for (const r of page.items) {
            if (seen.has(r.id))
                continue;
            seen.add(r.id);
            if (r.metadata?.[ROOM_REVIEW_KEY] === 'skipped')
                continue;
            out.push(r);
            if (out.length >= limit)
                return out;
        }
        if (page.items.length < 200)
            break;
    }
    return out;
}
export async function annotateOrphanCandidates(ctx, cfg, io, limit = 40, overrides = {}) {
    const selected = selectPendingOrphans(io.l1, limit);
    if (selected.length === 0)
        return { selected: 0, candidates: 0, written: 0 };
    // 全库 Room 词表(计数降序)。整批共享一张词表(一次 LLM 调用),
    // 同仓优先的精化在逐条候选写入后由 repo-change 重算消费,此处保持简单。
    const rooms = io.l1.listRooms();
    const rows = overrides.chunkAnnotator !== undefined
        ? await overrides.chunkAnnotator(selected)
        : await roomCandidateChunk(ctx, cfg, io.logger, selected, rooms);
    let written = 0;
    for (const { id, rooms: candidates } of rows) {
        if (candidates.length === 0)
            continue;
        const fresh = io.l1.getByIds([id])[0];
        if (!fresh)
            continue;
        const meta = { ...(fresh.metadata ?? {}) };
        meta[ROOM_CANDIDATES_KEY] = candidates;
        meta[ROOM_REVIEW_KEY] = 'pending';
        if (io.l1.patchMetadata(id, meta))
            written++;
    }
    io.logger.info(`[memory] 孤儿候选预标记:选中 ${selected.length},产候选 ${rows.length},写 pending ${written} 条(待 agent 复查)`);
    return { selected: selected.length, candidates: rows.length, written };
}
/** 待复查队列:pending 且有候选的活跃孤儿,按更新时间升序(最旧的先复查)。 */
function pendingQueue(l1) {
    const out = [];
    const seen = new Set();
    for (let offset = 0; offset < 2000; offset += 200) {
        const page = l1.list({ untagged: true, retired: false, limit: 200, offset });
        for (const r of page.items) {
            if (seen.has(r.id))
                continue;
            seen.add(r.id);
            const meta = (r.metadata ?? {});
            if (meta[ROOM_REVIEW_KEY] === 'pending' && Array.isArray(meta[ROOM_CANDIDATES_KEY]))
                out.push(r);
        }
        if (page.items.length < 200)
            break;
    }
    return out.sort((a, b) => a.updatedAt - b.updatedAt);
}
/** 下一条待复查(供 agent 逐个过):记录摘要 + 候选 + 现有 Room 词表 + 剩余数。 */
export function nextReview(l1) {
    const queue = pendingQueue(l1);
    if (queue.length === 0)
        return null;
    const r = queue[0];
    const meta = (r.metadata ?? {});
    return {
        id: r.id,
        content: r.content.slice(0, 600),
        type: r.type,
        sceneName: r.scene_name,
        candidates: meta[ROOM_CANDIDATES_KEY] ?? [],
        roomCatalog: l1.listRooms().slice(0, 40),
        remaining: queue.length,
    };
}
/** 待复查剩余数(面板/工具兜底信息)。 */
export function pendingReviewCount(l1) {
    return pendingQueue(l1).length;
}
/**
 * 确认复查结果:候选(或 agent 改写的)写入 metadata.tags(**进 Room**),
 * 清候选、标 confirmed。**高权限门控由调用方执行**(与 memory_delete 同款)。
 * 返回写入的 tags;id 不存在/状态非法返回 null。
 */
export function confirmReview(l1, id, rooms) {
    const found = l1.getByIds([id])[0];
    if (!found)
        return null;
    const meta = { ...(found.metadata ?? {}) };
    // 已确认/已跳过的不允许重复确认(防止 agent 循环空转)
    if (meta[ROOM_REVIEW_KEY] === 'confirmed')
        return null;
    const cleaned = [];
    for (const r of rooms) {
        if (typeof r !== 'string')
            continue;
        const slug = r.trim().toLowerCase();
        if (!slug || !isTag(slug) || cleaned.includes(slug))
            continue;
        cleaned.push(slug);
    }
    if (cleaned.length === 0)
        return null;
    meta.tags = cleaned;
    delete meta[ROOM_CANDIDATES_KEY];
    meta[ROOM_REVIEW_KEY] = 'confirmed';
    if (!l1.patchMetadata(id, meta))
        return null;
    l1.invalidateRooms();
    return { tags: cleaned };
}
/** 跳过:标 skipped(不再进 pending 队列)。已 confirmed 的记录不受 skip 影响(挂了 Room 的不算长尾)。 */
export function skipReview(l1, id) {
    const found = l1.getByIds([id])[0];
    if (!found)
        return false;
    const meta = { ...(found.metadata ?? {}) };
    if (meta[ROOM_REVIEW_KEY] === 'confirmed')
        return false;
    meta[ROOM_REVIEW_KEY] = 'skipped';
    return l1.patchMetadata(id, meta);
}
