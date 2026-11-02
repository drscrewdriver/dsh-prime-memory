/**
 * L1 **批内自去重**（同轮/同会话）——纯函数，零 IO、零 import 副作用。
 *
 * 为什么需要它（#现场取证，见 .agents/plans/pm-dedupe-scale-drsc-hint/findings.md §4）：
 * 既有 L1 去重只把**新记忆**和**库里的候选**对比（`store.searchCandidates`），同一批
 * `extracted[]` 之间**从不互相比较**。于是同一段对话被抽成多条碎片时，它们会一起进同一条
 * ≤20 条的 LLM 去重 prompt，只能由模型产出 `merged_content` 把内容"摞在一起"——
 * 既费一次 LLM 判定，又让落库正文变肿。
 *
 * 做法：在进 LLM 之前先做两级收拢，**只减条数、不改语义**：
 *   ① 精确层：归一化（trim / NFKC 全半角 / 空白折叠 / 去零宽）后同内容即合并；
 *   ② 向量层：**仅同 family + 同 type** 内、余弦 ≥ tau 贪心聚类。
 * 代表项规则：正文最长者（等长取 priority 高者，再等取先出现者）；其 record_id 与 content
 * **原样保留**，因此调用方可以把它自己的向量直接复用（正文没被改写，向量不会错配）。
 *
 * 明确不做：不产生合并正文（那是 LLM merge 的职责，见 ADR-0006 receipt 一致性）；
 * 不跨族/跨类合并；不替调用方决定 store/skip。
 */
/**
 * 用于比较的归一化文本。
 * NFKC 会把全角标点/字母折到半角；零宽字符（U+200B–200F / U+FEFF）直接剔除——
 * 它们肉眼不可见，却足以让两条"同一句话"取不同 hash。
 */
export function normalizeForDedupe(s) {
    return s
        .normalize('NFKC')
        .replace(/[\u200b-\u200f\ufeff]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}
/** 余弦相似度；任一向量缺失/长度不等/零向量时返回 undefined（不可比，绝不猜）。 */
export function cosineMaybe(a, b) {
    if (!a || !b || a.length === 0 || a.length !== b.length)
        return undefined;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0)
        return undefined;
    return dot / Math.sqrt(na * nb);
}
/** 代表项判定：正文最长 → priority 高 → 先出现。返回簇内下标。 */
function pickRepresentative(items, idx) {
    let best = idx[0];
    for (const i of idx) {
        const a = items[i];
        const b = items[best];
        const la = a.content.length;
        const lb = b.content.length;
        if (la > lb)
            best = i;
        else if (la === lb) {
            const pa = a.priority ?? 0;
            const pb = b.priority ?? 0;
            if (pa > pb)
                best = i;
            // 等长等优先级：保留先出现者（不覆盖 best）
        }
    }
    return best;
}
function unionNums(parts) {
    const all = parts.filter((p) => Array.isArray(p));
    if (all.length === 0)
        return undefined;
    return Array.from(new Set(all.flat())).sort((x, y) => x - y);
}
function unionStrs(parts) {
    const all = parts.filter((p) => Array.isArray(p));
    if (all.length === 0)
        return undefined;
    return Array.from(new Set(all.flat()));
}
/** 把一簇下标压成「代表项 + 吸收清单」。代表项字段保持原样，只并入可并集字段。 */
function collapse(items, idx) {
    const repIdx = pickRepresentative(items, idx);
    const rep = items[repIdx];
    const absorbed = idx.filter((i) => i !== repIdx).map((i) => items[i].record_id);
    const ts = unionNums(idx.map((i) => items[i].timestamps));
    const src = unionStrs(idx.map((i) => items[i].source_message_ids));
    const maxPriority = idx.reduce((m, i) => Math.max(m, items[i].priority ?? 0), rep.priority ?? 0);
    const merged = {
        ...rep,
        ...(maxPriority > 0 ? { priority: maxPriority } : {}),
        ...(ts === undefined ? {} : { timestamps: ts }),
        ...(src === undefined ? {} : { source_message_ids: src }),
    };
    return { rep: merged, absorbed };
}
function finish(items, clusters) {
    const effective = [];
    const absorbed = [];
    const absorbedBy = {};
    for (const idx of clusters) {
        const { rep, absorbed: absorbedIds } = collapse(items, idx);
        effective.push(rep);
        if (absorbedIds.length > 0) {
            absorbed.push({ representative: rep.record_id, absorbed: absorbedIds });
            for (const id of absorbedIds)
                absorbedBy[id] = rep.record_id;
        }
    }
    return { effective, absorbed, absorbedBy };
}
/**
 * 精确层：归一化后同内容合并（含全半角/空白/零宽差异）。
 * 空内容条目**不参与**合并（各自成簇）——正文为空是上游缺陷，静默吞掉会更难查。
 */
export function clusterExact(items) {
    if (items.length === 0)
        return { effective: [], absorbed: [], absorbedBy: {} };
    const byKey = new Map();
    const order = [];
    items.forEach((it, i) => {
        const key = normalizeForDedupe(it.content);
        if (key.length === 0) {
            // 空内容单独成簇：用 record_id 做键，保证永不与别人合并
            byKey.set(`\u0000${it.record_id}#${i}`, [i]);
            order.push(`\u0000${it.record_id}#${i}`);
            return;
        }
        const prev = byKey.get(key);
        if (prev)
            prev.push(i);
        else {
            byKey.set(key, [i]);
            order.push(key);
        }
    });
    return finish(items, order.map((k) => byKey.get(k)));
}
/**
 * 向量层：**仅同 family + 同 type** 组内，余弦 ≥ tau 即并入先出现的代表簇。
 * 缺向量 / 长度不等 / 零向量 → 不可比，直接自成代表（不猜相似）。
 * 先精确层、后本层是刻意顺序：精确重复不必再花一次比较，且能让代表项更稳定。
 */
export function clusterByVector(items, vectors, tau) {
    if (items.length === 0)
        return { effective: [], absorbed: [], absorbedBy: {} };
    const threshold = Number.isFinite(tau) ? Math.min(0.9999, Math.max(0.5, tau)) : 0.92;
    const clusters = [];
    /** groupKey → 该组已建立的代表簇下标（簇在 clusters 里的位置）。 */
    const repsByGroup = new Map();
    items.forEach((it, i) => {
        const group = `${it.family ?? ''}\u0000${it.type ?? ''}`;
        const repIdx = repsByGroup.get(group);
        if (repIdx) {
            const vec = vectors[i];
            let hit;
            let bestScore = -Infinity;
            for (const ci of repIdx) {
                const cand = clusters[ci][0];
                const score = cosineMaybe(vec, vectors[cand]);
                if (score !== undefined && score >= threshold && score > bestScore) {
                    bestScore = score;
                    hit = ci;
                }
            }
            if (hit !== undefined) {
                clusters[hit].push(i);
                return;
            }
        }
        const ci = clusters.length;
        clusters.push([i]);
        const list = repsByGroup.get(group);
        if (list)
            list.push(ci);
        else
            repsByGroup.set(group, [ci]);
    });
    return finish(items, clusters);
}
/**
 * 把「被吸收 → 代表」关系映射成 receipt 输入项。
 *
 * 为什么用既有 `kind='merge'` + `candidateIds=[代表 id]` 而不新增表列/词表即可：
 * 吸收本质上就是「本条被并入另一条」，`merge` 正是这个词；`candidateIds` 载代表项 id，
 * 于是「本条被批内哪条吸收」只需一次 `(runId, recordId)` 回溯（inputDigest 含代表 id）。
 * 关闭特性时 `absorbedBy` 为空 ⇒ 不产生任何额外行（凭证与改动前逐字节一致）。
 */
export function receiptItemsForAbsorbed(absorbedBy) {
    return Object.entries(absorbedBy).map(([absorbedId, repId]) => ({
        recordId: absorbedId,
        candidateIds: [repId],
        action: 'merge',
    }));
}
/**
 * 一次完成：精确层 → （可选）向量层，并把“代表项→向量”与“被吸收→代表”两表一并交回。
 *
 * 嵌入不可用时**降级只做精确层**（catch 后留一条 warn），绝不因向量故障阻断蒸馏——
 * 它只是省 LLM 判定与写侧重嵌的优化，不是正确性前置。
 */
export async function preDedupeBatch(items, embedMany, opts = {}) {
    if (opts.enabled === false || items.length === 0) {
        return { effective: [...items], vectors: new Map(), absorbedBy: {}, raw: items.length, exact: items.length, vector: items.length };
    }
    const tauRaw = opts.tau ?? 0.92;
    const tau = Math.min(0.99, Math.max(0.85, Number.isFinite(tauRaw) ? tauRaw : 0.92));
    if (tau !== tauRaw)
        opts.onWarn?.(`[memory] extract.intraBatchCosine=${tauRaw} 超出有效区间 0.85–0.99，已按 ${tau} 处理`);
    const exact = clusterExact(items);
    let vecs = exact.effective.map(() => undefined);
    const exactVecById = new Map();
    try {
        vecs = await embedMany(exact.effective.map((m) => m.content));
        exact.effective.forEach((m, i) => {
            const v = vecs[i];
            if (v)
                exactVecById.set(m.record_id, v);
        });
    }
    catch (err) {
        opts.onWarn?.(`[memory] L1 批内向量不可用，仅做精确层: ${err instanceof Error ? err.message : String(err)}`);
    }
    const byVec = clusterByVector(exact.effective, vecs, tau);
    // 只回最终代表项的向量：被向量层吸收的条目（如 r3）虽然自己算过向量，但它不会入库，
    // 留在表里只会误导写侧（按 record_id 查得到，却根本没有这条记录）。
    const vectors = new Map();
    for (const m of byVec.effective) {
        const v = exactVecById.get(m.record_id);
        if (v)
            vectors.set(m.record_id, v);
    }
    return {
        effective: byVec.effective,
        vectors,
        absorbedBy: { ...exact.absorbedBy, ...byVec.absorbedBy },
        raw: items.length,
        exact: exact.effective.length,
        vector: byVec.effective.length,
    };
}
