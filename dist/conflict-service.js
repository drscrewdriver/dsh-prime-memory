const OUTCOMES = ['winner', 'loser', 'both'];
function view(partial) {
    return { pair_id: '', outcome: '', resolved_at: '', removed_record_id: '', ...partial };
}
/**
 * 裁决一条待裁决对。
 *
 * 顺序刻意如此:
 * ① **先打 `resolved_at` 再退场 loser**。反过来的话,退场成功但打标失败会留下
 *    "记录已退场、队列里那条仍在待裁决"的状态——人再点一次才发现无据可依。
 *    打标用 `WHERE resolved_at = ''`,天然防重复裁决:第二次调用拿到 0 行即中止。
 * ② 退场后才**重算**图谱 `disputed`(派生字段必须由当前事实重算,见 `syncDisputed`)。
 * ③ 退场是**软删**(`retire`,可恢复),不是物理删除:主表行留着,`valid_to` 闭合 +
 *    写取代标记,FTS/向量行撤掉。故"判错了"可以再恢复——裁决不可覆盖,但可以反悔。
 */
export async function resolveConflictPair(deps, pairId, outcome) {
    const clean = outcome.trim();
    if (!OUTCOMES.includes(clean)) {
        return view({
            pair_id: pairId,
            outcome: clean,
            notice: `outcome 必须是 ${OUTCOMES.join(' / ')} 之一:winner(LLM 建议的胜方为真)、loser(败方为真)、both(两者其实是各自独立的事实,都保留)。`,
        });
    }
    if (!deps.conflictFreezeEnabled) {
        return view({
            pair_id: pairId,
            outcome: clean,
            notice: '矛盾冻结未开启(conflictFreeze.enabled=false):没有待裁决对,无从裁决。',
        });
    }
    const pair = deps.l1.listConflictPending().find((p) => p.pairId === pairId);
    if (!pair) {
        return view({
            pair_id: pairId,
            outcome: clean,
            notice: '找不到该待裁决对:pair_id 有误,或它已被裁决(resolved_at 非空的不再接受二次裁决)。',
        });
    }
    const resolvedAt = new Date().toISOString();
    const removedId = clean === 'winner' ? pair.loserId : clean === 'loser' ? pair.winnerId : '';
    if (deps.l1.resolveConflictPending(pairId, clean, resolvedAt) === 0) {
        // 并发/重复调用:这一对在本次读取与本次写入之间被裁决了
        return view({ pair_id: pairId, outcome: clean, notice: '该对已被裁决,本次未生效(裁决不可覆盖)。' });
    }
    if (removedId) {
        // **软删**(退场),不是物理删除:主表行保留 + `valid_to` 闭合 + 写取代标记,
        // FTS/向量行撤掉使其退出检索面。于是"判错了"可以再恢复,而不必去
        // `records/*.jsonl` 事实源里手工捞——那是本功能上线前唯一的后悔药。
        deps.l1.retire([removedId], {
            at: resolvedAt,
            reason: 'conflict',
            verdict: clean,
            pairId,
        });
    }
    // 图谱 disputed 重算:此刻仍未裁决的对才是争议集,已了结的节点自动复原 active
    const ids = new Set();
    for (const p of deps.l1.listConflictPending()) {
        ids.add(p.winnerId);
        ids.add(p.loserId);
    }
    deps.l1.syncGraphDisputed([...ids]);
    return view({ pair_id: pairId, outcome: clean, resolved_at: resolvedAt, removed_record_id: removedId });
}
/** 裁决结果的人类可读渲染(工具路径用)。schema 产出的是可选字段,故按部分取值渲染。 */
export function renderConflictResolution(v) {
    if (v.notice)
        return v.notice;
    const outcome = v.outcome ?? '';
    const label = outcome === 'winner' ? '判定 LLM 建议的胜方为真' : outcome === 'loser' ? '判定败方为真' : '两者都保留(判为各自独立的事实)';
    const removed = v.removed_record_id
        ? `\n退场记录:${v.removed_record_id}(已移出检索面,**可恢复**——记忆列表里能找回)`
        : '\n未移除任何记录。';
    return `已裁决待裁决对 ${v.pair_id ?? ''}\n结论:${outcome}(${label})\n裁决时刻:${v.resolved_at ?? ''}${removed}`;
}
// ─────────────────────────────────────────────────────────────────────────────
// 读方向:列出待裁决对
//
// 与 `resolveConflictPair` 同理由共用本模块:工具(`memory_conflicts`)与
// RPC 端点(`dsh-memory/conflicts`)必须是**同一份形状** —— 面板与模型看同一队列,
// 否则"人看到的那条"和"模型能裁决的那条"会对不上。
// ─────────────────────────────────────────────────────────────────────────────
/** 一条待裁决对的对外形状见 `contract.ts` 的 `ConflictPairView`(此处只引用)。 */
/** 队列读取的上限(与 `records-delete` 同量级:够人看,不把页面拖死)。 */
export const CONFLICT_LIST_LIMIT_MAX = 200;
/** 默认取多少条。 */
export const CONFLICT_LIST_LIMIT_DEFAULT = 50;
/**
 * 列出待裁决对。
 *
 * **正文必须带上**:人工裁决的对象就是"这两条到底说了什么",只给 id 等于让人盲判。
 * 取不到正文时留空串 —— 面板据此区分"记录已不在检索库"与"内容为空",
 * 而不是拿一句"（无内容）"把两种情形糊在一起。
 *
 * 未开启冻结时返回 `enabled:false` + 空列表 + `notice`,**不抛错**:开关没开是
 * 部署状态,不是调用错误(与 `resolveConflictPair` 对同一情形的处理一致)。
 */
export function listConflictPairs(deps, opts = {}) {
    const raw = Math.floor(Number(opts.limit));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, CONFLICT_LIST_LIMIT_MAX) : CONFLICT_LIST_LIMIT_DEFAULT;
    if (!deps.conflictFreezeEnabled) {
        return {
            enabled: false,
            total: 0,
            items: [],
            notice: '矛盾冻结未开启(conflictFreeze.enabled=false):队列恒空,没有待裁决对。',
        };
    }
    const pending = deps.l1.listConflictPending({ limit });
    const ids = new Set();
    for (const p of pending) {
        ids.add(p.winnerId);
        ids.add(p.loserId);
    }
    const contentById = new Map();
    for (const r of deps.l1.getByIds([...ids]))
        contentById.set(r.id, r.content);
    const items = pending.map((p) => ({
        pair_id: p.pairId,
        run_id: p.runId,
        winner_id: p.winnerId,
        winner_content: contentById.get(p.winnerId) ?? '',
        loser_id: p.loserId,
        loser_content: contentById.get(p.loserId) ?? '',
        created_at: p.createdAt,
    }));
    return { enabled: true, total: deps.l1.countConflictPendingUnresolved(), items };
}
/** 列表结果的人类可读渲染(工具路径用)。 */
export function renderConflicts(v) {
    if (!v.enabled)
        return v.notice ?? '矛盾冻结未开启:没有待裁决对。';
    if (v.items.length === 0)
        return '没有待裁决的冲突对(队列为空)。';
    const more = v.total > v.items.length ? `\n(共 ${v.total} 对,此处显示前 ${v.items.length} 对)` : '';
    const rows = v.items.map((p, i) => {
        const w = p.winner_content || '(该记录已不在检索库)';
        const l = p.loser_content || '(该记录已不在检索库)';
        return (`${i + 1}. pair_id ${p.pair_id}  (${p.created_at})\n` +
            `   LLM 建议胜方 ${p.winner_id}:${w}\n` +
            `   LLM 建议败方 ${p.loser_id}:${l}`);
    });
    return `待裁决冲突对 ${v.items.length} 条${more}\n\n${rows.join('\n\n')}\n\n` +
        '用 memory_resolve_conflict 给出结论:winner / loser / both。';
}
