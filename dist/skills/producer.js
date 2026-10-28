import { ANCHOR_METADATA_KEY } from '../pipeline/anchors.js';
import { fnv1a, groupKey } from './crystallize.js';
/** L1 词表里的「工作方法」类型字面量（技能只从这一类派生，不新增类型）。 */
const WORK_METHOD_TYPE = 'work_method';
/** 证据行的来源标记：区分蒸馏轮次投的与人工补的。 */
const EVIDENCE_KIND = 'distill';
/** backfill 分页大小与扫描上限：大库必须可截断，不许无界扫。 */
const BACKFILL_PAGE = 500;
const BACKFILL_MAX_RECORDS = 20_000;
/** 单候选最多收录的步骤数与证据 id 数（与 crystallize 的默认口径一致）。 */
const MAX_STEPS = 20;
const EVIDENCE_IDS_CAP = 200;
/** 候选 body 的首段截取长度（steps[0] 的摘要，人可后续编辑）。 */
const BODY_LEAD_CHARS = 200;
/**
 * 把 L1 记录归一成检测用的视图：`hall` 住在 `metadata.hall`（Wings 关时缺省 ⇒
 * groupKey 回落 'general'），`scene_name` 是 snake_case 列，`sessionId` 由调用方注入
 * （**记录本身不存 sessionId**，这是本文件存在的关键约束之一）。
 */
function toViews(records, sessionId) {
    const out = [];
    for (const r of records) {
        if (!r || r.type !== WORK_METHOD_TYPE)
            continue;
        if (typeof r.content !== 'string' || r.content.trim() === '')
            continue;
        const hall = typeof r.metadata?.['hall'] === 'string' ? r.metadata['hall'] : undefined;
        out.push({ id: r.id, content: r.content, sessionId, hall, sceneName: r.scene_name });
    }
    return out;
}
/**
 * 从锚点展开一条历史记录到「每会话一条视图」。
 *
 * 无锚点或锚点里 sessionId 全空 ⇒ 返回空数组（调用方计入 `skippedNoAnchor`）。
 * **绝不回落成 `'default'`**：伪造的会话归属会虚增 distinct-session，直接骗过晋升门。
 */
function viewsFromAnchors(r) {
    if (!r || r.type !== WORK_METHOD_TYPE)
        return { views: [], sessions: 0 };
    if (typeof r.content !== 'string' || r.content.trim() === '')
        return { views: [], sessions: 0 };
    const raw = r.metadata?.[ANCHOR_METADATA_KEY];
    if (!Array.isArray(raw))
        return { views: [], sessions: 0 };
    const hall = typeof r.metadata?.['hall'] === 'string' ? r.metadata['hall'] : undefined;
    const seen = new Set();
    const views = [];
    for (const a of raw) {
        const sid = typeof a?.sessionId === 'string' ? a.sessionId.trim() : '';
        if (sid === '' || seen.has(sid))
            continue;
        seen.add(sid);
        views.push({ id: r.id, content: r.content, sessionId: sid, hall, sceneName: r.scene_name });
    }
    return { views, sessions: seen.size };
}
function buildGroups(views) {
    const m = new Map();
    for (const v of views) {
        const key = groupKey(v);
        const g = m.get(key);
        if (g)
            g.views.push(v);
        else
            m.set(key, { key, id: 'skx-' + fnv1a(key), hall: v.hall, sceneName: v.sceneName, views: [v] });
    }
    // 按 key 排序：与 detectCandidates 同口径，让日志与快照可复现。
    return [...m.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
/** 归一化去重步骤（空白折叠 + 小写比较，保留首次出现顺序）。 */
function dedupe(views) {
    const seen = new Set();
    const steps = [];
    const recordIds = [];
    for (const v of views) {
        const norm = v.content.replace(/\s+/g, ' ').trim();
        if (norm === '')
            continue;
        const probe = norm.toLowerCase();
        if (seen.has(probe))
            continue;
        seen.add(probe);
        if (steps.length < MAX_STEPS)
            steps.push(norm);
        if (recordIds.length < EVIDENCE_IDS_CAP && !recordIds.includes(v.id))
            recordIds.push(v.id);
    }
    return { steps, recordIds };
}
/** 候选标题：与 detectCandidates 的 label 公式逐字一致（两处漂移会让同一组显示两个名字）。 */
function titleOf(g) {
    const label = g.hall && g.hall !== 'general' ? `${g.hall} 流程` : g.sceneName ? `${g.sceneName} 流程` : '通用流程';
    return `技能：${label}`;
}
/**
 * 建一个技能生产者。
 *
 * 所有失败都在内部消化成 `summary.errors` + warn 日志，**不抛穿调用方**——
 * 蒸馏轮次不该因为技能结晶失败而丢记忆。
 */
export function createSkillProducer(deps) {
    const { skills, l1, logger } = deps;
    let lastRoundAt;
    let backfilledAt;
    /** 空账目（开关关时直接返回，全程零动作）。 */
    const emptySummary = () => ({
        scanned: 0,
        methods: 0,
        candidatesTouched: 0,
        created: 0,
        appended: 0,
        promoted: 0,
        skippedNoAnchor: 0,
        stoppedAtCap: false,
        errors: [],
    });
    /**
     * 把一组视图落成「一个候选 + 若干证据」，并按需尝试晋升。
     * 返回 false 表示应当中止外层循环（达 SKILLS_CAP）。
     */
    const absorbGroup = async (g, runId, cfg, s) => {
        const { steps, recordIds } = dedupe(g.views);
        if (steps.length === 0)
            return true;
        let exists = skills.get(g.id) !== undefined;
        if (!exists) {
            try {
                await skills.create({
                    id: g.id,
                    title: titleOf(g),
                    body: (steps[0] ?? '').slice(0, BODY_LEAD_CHARS),
                    steps,
                    trigger: { hall: g.hall, sceneName: g.sceneName },
                    status: 'candidate',
                    family: 'work',
                    evidenceRecordIds: recordIds,
                });
                s.created += 1;
                exists = true;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('上限')) {
                    s.stoppedAtCap = true;
                    s.errors.push('技能数已达上限，本轮停止结晶（可在面板归档部分技能）');
                    logger?.warn('[memory] 技能结晶停止：技能数已达上限');
                    return false;
                }
                if (!msg.includes('已存在')) {
                    s.errors.push(`建候选失败: ${msg}`);
                    logger?.warn(`[memory] 技能候选创建失败(${g.id}): ${msg}`);
                    return true;
                }
                // 并发下另一轮刚建好：当作已存在，继续走证据路径
                exists = true;
            }
        }
        else {
            // 机器侧只重写 steps；body 是人编辑区，传进去就破坏了分列不变量。
            try {
                await skills.update(g.id, { steps });
            }
            catch (err) {
                s.errors.push(`更新步骤失败: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        s.candidatesTouched += 1;
        // 证据：sessionCount 的唯一来源。三元组去重，重复轮次不重复投。
        const at = new Date().toISOString();
        for (const v of g.views) {
            if (v.sessionId === '')
                continue;
            if (skills.hasEvidence(g.id, v.sessionId, v.id))
                continue;
            try {
                await skills.appendEvidence({ skillId: g.id, runId, recordId: v.id, sessionId: v.sessionId, at, kind: EVIDENCE_KIND });
                s.appended += 1;
            }
            catch (err) {
                s.errors.push(`投证据失败: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        // 自动晋升：双阈同时满足才动（minEvidence 此前无人消费，这里让它真实生效）。
        // 人工晋升走 skills-action，只卡 sessionCount——人审是人的判断，不重复机械门。
        if (cfg.allowPromote && exists) {
            if (skills.sessionCount(g.id) >= cfg.minSessions && skills.evidenceCount(g.id) >= cfg.minEvidence) {
                if (await skills.tryPromote(g.id, cfg.minSessions, { allowPromote: true }))
                    s.promoted += 1;
            }
        }
        return true;
    };
    const drainGroups = async (groups, runId, cfg, s) => {
        for (const g of groups) {
            if (!(await absorbGroup(g, runId, cfg, s)))
                return;
        }
    };
    return {
        async ingestRound(records, sessionId, runId) {
            const s = emptySummary();
            const cfg = deps.cfg();
            s.scanned = records.length;
            if (!cfg.enabled || records.length === 0)
                return s;
            const views = toViews(records, sessionId);
            s.methods = views.length;
            if (views.length === 0)
                return s;
            try {
                await drainGroups(buildGroups(views), runId, cfg, s);
                lastRoundAt = new Date().toISOString();
            }
            catch (err) {
                s.errors.push(err instanceof Error ? err.message : String(err));
            }
            if (s.candidatesTouched > 0 || s.created > 0) {
                logger?.info(`[memory] 技能结晶：触及 ${s.candidatesTouched} 候选（新建 ${s.created}、证据 +${s.appended}${s.promoted > 0 ? `、晋升 ${s.promoted}` : ''}）`);
            }
            return s;
        },
        async backfill(opts) {
            const s = { ...emptySummary(), pages: 0, truncated: false };
            const cfg = deps.cfg();
            if (!cfg.enabled)
                return s;
            const page = opts?.page !== undefined && opts.page > 0 ? opts.page : BACKFILL_PAGE;
            const maxRecords = opts?.maxRecords !== undefined && opts.maxRecords > 0 ? opts.maxRecords : BACKFILL_MAX_RECORDS;
            // 累积全部会话的视图后一次性分组：跨页分裂的同组记录必须合成一个候选，
            // 所以不能在页内直接落库。上限由 maxRecords 兜住，内存里只放视图引用。
            const views = [];
            try {
                for (let offset = 0;; offset += page) {
                    const lite = l1.allLite(page, offset);
                    s.pages += 1;
                    if (lite.length === 0)
                        break;
                    s.scanned += lite.length;
                    const ids = lite.filter((r) => r.type === WORK_METHOD_TYPE).map((r) => r.id);
                    if (ids.length > 0) {
                        for (const r of l1.getByIds(ids)) {
                            const { views: vs } = viewsFromAnchors(r);
                            if (vs.length === 0) {
                                if (r.content.trim() !== '' && r.type === WORK_METHOD_TYPE)
                                    s.skippedNoAnchor += 1;
                                continue;
                            }
                            views.push(...vs);
                        }
                    }
                    if (s.scanned >= maxRecords) {
                        s.truncated = true;
                        break;
                    }
                    // 让出事件循环：大库回灌期间面板 RPC 不能被独占（对齐 allLite 的存在理由）。
                    await new Promise((resolve) => setImmediate(resolve));
                }
                s.methods = new Set(views.map((v) => v.id)).size;
                await drainGroups(buildGroups(views), `backfill-${Date.now().toString(36)}`, cfg, s);
                backfilledAt = new Date().toISOString();
            }
            catch (err) {
                s.errors.push(err instanceof Error ? err.message : String(err));
                logger?.warn(`[memory] 技能历史回灌失败: ${err instanceof Error ? err.message : String(err)}`);
            }
            logger?.info(`[memory] 技能历史回灌：扫 ${s.scanned} 条记录（${s.pages} 页${s.truncated ? '，达上限截断' : ''}）→ 触及 ${s.candidatesTouched} 候选（新建 ${s.created}、证据 +${s.appended}${s.skippedNoAnchor > 0 ? `、${s.skippedNoAnchor} 条缺锚点跳过` : ''}）`);
            return s;
        },
        status() {
            return { wired: true, ...(lastRoundAt === undefined ? {} : { lastRoundAt }), ...(backfilledAt === undefined ? {} : { backfilledAt }) };
        },
    };
}
