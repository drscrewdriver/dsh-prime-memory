import { cognitiveHallOf, COG_HALL_METADATA_KEY } from '../cognitive-hall.js';
import { normWingEnabled } from '../config.js';
import { WING_FALLBACK, WING_CATALOG } from '../types.js';
import { labelWingChunk, tagChunk } from '../wing-backfill.js';
/** 机械写回上限(首次全量巡检可能上千条待补 cogHall;分次反刍消化,防单次跑飞)。 */
const MECH_CAP = 800;
/** LLM 重标定批上限(每块 20 条由标注器内部控制)。 */
const LLM_CAP = 60;
/** slug 标签校验:小写字母数字连字符,1-32 字符。 */
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
function slugTags(v) {
    if (!Array.isArray(v))
        return [];
    const out = v
        .filter((t) => typeof t === 'string')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => TAG_RE.test(t));
    return [...new Set(out)].slice(0, 3);
}
export async function relabelPass(deps, overrides = {}) {
    const { ctx, cfg, l1, logger } = deps;
    const stats = { checked: 0, cogHallFixed: 0, wingInvalidFixed: 0, wingLabeled: 0, tagged: 0, llmSkipped: 0 };
    const wingIds = new Set([...WING_CATALOG.map((w) => w.id), WING_FALLBACK]);
    const all = l1.all();
    stats.checked = all.length;
    // ── 机械校验 + 修正(有界写回) ──
    const needWingLLM = [];
    let mechWrites = 0;
    for (const r of all) {
        const meta = { ...(r.metadata ?? {}) };
        let changed = false;
        // Wing 合法性:非法值剥离,转入 LLM 重标队列
        const wing = meta.hall;
        if (typeof wing === 'string' && wing !== '' && !wingIds.has(wing)) {
            delete meta.hall;
            changed = true;
            stats.wingInvalidFixed++;
            needWingLLM.push({ ...r, metadata: meta });
        }
        // 认知 hall:type 可派生而未写/不一致 → 修正
        const expected = cognitiveHallOf(r.type);
        if (expected && meta[COG_HALL_METADATA_KEY] !== expected) {
            meta[COG_HALL_METADATA_KEY] = expected;
            changed = true;
            stats.cogHallFixed++;
        }
        if (changed && mechWrites < MECH_CAP) {
            mechWrites++;
            try {
                await l1.upsert({ ...r, metadata: meta });
            }
            catch (err) {
                logger.warn(`[memory] 反刍重标定机械写回失败(id=${r.id},跳过): ${err instanceof Error ? err.message : String(err)}`);
                mechWrites--;
            }
        }
        // 未打标 wing(含刚剥离非法值的)进 LLM 队列
        const after = meta.hall;
        if (typeof after !== 'string' || after === '') {
            if (!needWingLLM.some((x) => x.id === r.id))
                needWingLLM.push({ ...r, metadata: meta });
        }
    }
    // ── LLM 重标定(有界;wing.enabled 关闭则跳过) ──
    const wingEnabled = normWingEnabled(cfg.hall?.enabled);
    if (wingEnabled.length === 0 || needWingLLM.length === 0)
        return stats;
    const batch = needWingLLM.slice(0, LLM_CAP);
    if (batch.length === 0)
        return stats;
    logger.info(`[memory] 反刍重标定:未打标/待重标 ${needWingLLM.length} 条,本次 LLM 处理 ${batch.length} 条(候选 ${[...wingEnabled, WING_FALLBACK].join(' / ')})`);
    const wingLabeler = overrides.wingLabeler ??
        ((chunk) => labelWingChunk(ctx, cfg, logger, chunk, [...wingEnabled, WING_FALLBACK].join(' / ')).then((rows) => rows.map(({ record, hall }) => ({ record, wing: hall }))));
    let labeled;
    try {
        labeled = await wingLabeler(batch);
    }
    catch {
        stats.llmSkipped += batch.length;
        return stats;
    }
    stats.llmSkipped += batch.length - labeled.length;
    stats.wingLabeled = labeled.length;
    // 写前重读:机械阶段可能已写过 cogHall,LLM 标注器持有的是旧副本——
    // 以库内最新记录为基线合并,避免标签写回互相覆盖(真踩过:tags 回写丢 wing)。
    const freshById = new Map(l1.getByIds(labeled.map(({ record }) => record.id)).map((r) => [r.id, r]));
    for (const { record, wing } of labeled) {
        const current = freshById.get(record.id) ?? record;
        const meta = { ...(current.metadata ?? {}) };
        meta.hall = wing;
        try {
            await l1.upsert({ ...current, metadata: meta });
        }
        catch {
            stats.wingLabeled--;
            stats.llmSkipped++;
        }
    }
    // ── 涌现标签(tags,Room 前身):同一批记录,有界 40 条 ──
    const tagBatch = batch.slice(0, 40);
    const tagger = overrides.tagger ?? ((chunk) => tagChunk(ctx, cfg, logger, chunk));
    let tagRows;
    try {
        tagRows = await tagger(tagBatch);
    }
    catch {
        return stats;
    }
    const freshForTags = new Map(l1.getByIds(tagRows.map(({ record }) => record.id)).map((r) => [r.id, r]));
    for (const { record, tags: rawTags } of tagRows) {
        const tags = slugTags(rawTags); // 归一+校验在写回点强制:无论标签来自真实 LLM 还是注入桩
        if (tags.length === 0)
            continue;
        const current = freshForTags.get(record.id) ?? record;
        const meta = { ...(current.metadata ?? {}) };
        meta.tags = tags;
        try {
            await l1.upsert({ ...current, metadata: meta });
            stats.tagged++;
        }
        catch {
            /* 标签写失败不影响主流程 */
        }
    }
    return stats;
}
