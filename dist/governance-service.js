import { normTier } from './types.js';
import { normApplicability } from './repo-scope.js';
/** 单页游标大小(与 memport 每批 ≤200 的纪律对齐)。 */
export const GOVERNANCE_PAGE_SIZE = 200;
/** 单次裁决回传条数上限;超限**显式回报** truncated,绝不静默截断(P1-6)。 */
export const VERDICTS_MAX_ROWS = 200;
/** verdict 词表(单一来源;新增值必须同步端点文档与词表一致性测试,I-17)。 */
export const VERDICT_VALUES = [
    'retire',
    'restore',
    'demote-to-wiki',
    'promote-to-active',
    'move-scope',
    'mark-adopted',
    'keep',
];
export function normalizeVerdict(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (VERDICT_VALUES.includes(s))
        return s;
    if (s.startsWith('move-scope:'))
        return 'move-scope';
    return undefined;
}
/** CSV 转义(双引号包裹 + 内部引号翻倍;值内换行合法)。 */
function csvEscape(v) {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
/**
 * 导出记忆 CSV(T3.1/T3.13):**游标分页 + 副本非移动**。
 * updatedAt 快照列供回传乐观并发(T3.7)。repo/applicability 列名不用裸词
 * `scope`(P1-4 四义术语表,ADR-0015)。
 */
export function exportRecordsCsv(store, opts = {}) {
    const pageSize = GOVERNANCE_PAGE_SIZE;
    const maxRows = Math.max(1, Math.min(Math.floor(Number(opts.limit)) || 10_000, 50_000));
    const header = [
        'id', 'type', 'priority', 'scene_name', 'tier', 'repo_key_name', 'repo_key_owner',
        'applicability', 'family', 'updated_at', 'content',
    ];
    const lines = [header.join(',')];
    let total = 0;
    // 游标分页:每页 PAGE 条,page 前进直到取满/取尽;不做全表载入
    for (let offset = 0; offset < maxRows; offset += pageSize) {
        const { items } = store.list({ retired: opts.retired ?? false, limit: pageSize, offset });
        if (items.length === 0)
            break;
        for (const r of items) {
            if (total >= maxRows)
                break;
            lines.push([
                csvEscape(r.id), csvEscape(r.type), csvEscape(r.priority), csvEscape(r.scene_name),
                csvEscape(normTier(r.tier)), csvEscape(r.repoKeyName ?? ''), csvEscape(r.repoKeyOwner ?? ''),
                csvEscape(normApplicability(r.applicability)), csvEscape(r.family ?? ''), csvEscape(r.updatedAt),
                csvEscape(r.content),
            ].join(','));
            total++;
        }
        if (items.length < pageSize)
            break;
    }
    return { csv: lines.join('\n'), total };
}
function isHighImpact(r) {
    return r.type === 'instruction' || (r.type === 'persona' && r.priority >= 80);
}
/**
 * 裁决预演(T3.2):与 apply 同一套逐行校验,零写。
 * 返回与 apply 同形的行级结论,供面板/CSV 编辑者先看后拍。
 */
export function previewVerdicts(deps, rowsIn) {
    return applyVerdicts(deps, rowsIn, { dryRun: true, confirmHighImpact: true });
}
/**
 * 裁决应用(T3.2/T3.4/T3.7)。
 *
 * - **干跑默认**(省略 dryRun = true)——省略即安全是破坏性动作的唯一合法默认;
 * - **执行前落快照**(requireSnapshot 常量 true,不给关):快照失败即拒绝执行;
 * - **逐行乐观并发**:回传 updatedAt ≠ 库内值 → 该行 skippedStale(不整批作废);
 * - **高影响二次确认**:instruction / persona≥80 需 confirmHighImpact,否则该行跳过;
 * - **上限显式回报**:超 VERDICTS_MAX_ROWS 的尾部计入 truncated,绝不静默丢弃;
 * - verdict 路由(词表见 VERDICT_VALUES):retire→retire();restore→restore()(清
 *   validTo 回召回面);demote-to-wiki→setTier('wiki')+入队 L2 重聚类;
 *   promote-to-active→**仅对未退场记录** setTier('active')(已退场 noop+提示改用
 *   restore,Issue 5);move-scope→patchRepoKey;mark-adopted→bumpActivation;
 *   keep→noop(留痕在返回行)。
 */
export async function applyVerdicts(deps, rowsIn, opts = {}) {
    const dryRun = opts.dryRun !== false; // 省略即干跑(I-14)
    const confirmHighImpact = opts.confirmHighImpact === true;
    const truncated = Math.max(0, rowsIn.length - VERDICTS_MAX_ROWS);
    const rows = rowsIn.slice(0, VERDICTS_MAX_ROWS);
    const result = {
        requested: rowsIn.length,
        applied: 0, truncated,
        skippedStale: 0, skippedHighImpact: 0, skippedInvalid: 0, notFound: 0, noop: 0,
        dryRun,
        rows: [],
    };
    if (rows.length === 0)
        return result;
    const byId = new Map();
    const ids = rows.map((r) => r.id).filter((x) => typeof x === 'string' && x !== '');
    for (const r of deps.store.getByIds([...new Set(ids)]))
        byId.set(r.id, r);
    // 快照前置(I-14):干跑不落;执行必须先有可信快照,失败即整体拒绝
    if (!dryRun) {
        try {
            result.snapshot = await deps.createSnapshot('pre-verdicts');
            if (!result.snapshot)
                throw new Error('快照目录为空');
        }
        catch (err) {
            // requireSnapshot=true(常量,不给关):无快照拒绝执行
            throw new Error(`批量裁决中止:执行前快照失败(requireSnapshot=true,不给关): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const demotedScenes = new Map(); // family → scenes
    for (const row of rows) {
        const id = typeof row.id === 'string' ? row.id : '';
        const verdict = normalizeVerdict(row.verdict);
        const rec = byId.get(id);
        const rowOut = { id, verdict: String(row.verdict ?? ''), status: 'noop' };
        if (!verdict) {
            rowOut.status = 'skippedInvalid';
            rowOut.notice = `verdict 必须是 ${VERDICT_VALUES.join('/')}(move-scope:<repo>)`;
            result.skippedInvalid++;
            result.rows.push(rowOut);
            continue;
        }
        if (!rec) {
            rowOut.status = 'notFound';
            result.notFound++;
            result.rows.push(rowOut);
            continue;
        }
        // 乐观并发(T3.7):回传快照与库内不符 → 行级拒绝(不整批作废)
        if (row.updatedAt !== undefined && row.updatedAt !== null && row.updatedAt !== '') {
            const snap = Number(row.updatedAt);
            if (Number.isFinite(snap) && snap !== rec.updatedAt) {
                rowOut.status = 'skippedStale';
                rowOut.notice = `updatedAt 快照过期(回传 ${snap} ≠ 库内 ${rec.updatedAt})——库已被改写,请重新导出`;
                result.skippedStale++;
                result.rows.push(rowOut);
                continue;
            }
        }
        // 高影响二次确认(T3.4):instruction / persona≥80
        if (verdict !== 'keep' && isHighImpact(rec) && !confirmHighImpact) {
            rowOut.status = 'skippedHighImpact';
            rowOut.notice = '高影响记录(instruction / persona≥80)需 confirmHighImpact 二次确认';
            result.skippedHighImpact++;
            result.rows.push(rowOut);
            continue;
        }
        if (dryRun) {
            rowOut.status = 'applied';
            rowOut.notice = 'dryRun 预演:未写库';
            result.applied++;
            result.rows.push(rowOut);
            continue;
        }
        // ── 路由执行 ──
        switch (verdict) {
            case 'retire': {
                const n = deps.store.retire([id], { at: new Date().toISOString(), reason: 'manual', verdict: 'retire' });
                rowOut.status = n > 0 ? 'applied' : 'noop';
                break;
            }
            case 'restore': {
                // restore 是 async(要补嵌向量):await 后按实际恢复数定性
                const r = await deps.store.restore([id]);
                rowOut.status = r.restored > 0 ? 'applied' : 'noop';
                if (r.restored === 0)
                    rowOut.notice = '记录不在退场态或恢复失败';
                break;
            }
            case 'demote-to-wiki': {
                const n = deps.store.setTier(id, 'wiki', 'active');
                if (n > 0) {
                    const scenes = demotedScenes.get(rec.family ?? 'chat') ?? new Set();
                    if (rec.scene_name)
                        scenes.add(rec.scene_name);
                    demotedScenes.set(rec.family ?? 'chat', scenes);
                }
                rowOut.status = n > 0 ? 'applied' : 'noop';
                if (n === 0)
                    rowOut.notice = 'CAS 不符(可能已为 wiki)';
                break;
            }
            case 'promote-to-active': {
                // Issue 5:promote 仅对未退场记录;已退场 no-op + 提示改用 restore
                if (rec.validTo !== undefined) {
                    rowOut.status = 'noop';
                    rowOut.notice = '记录已退场(validTo 闭合)——请改用 restore 恢复后再管理 tier';
                }
                else {
                    const n = deps.store.setTier(id, 'active', 'wiki');
                    rowOut.status = n > 0 ? 'applied' : 'noop';
                    if (n === 0)
                        rowOut.notice = 'CAS 不符(可能已为 active)';
                }
                break;
            }
            case 'move-scope': {
                const raw = typeof row.repo === 'string' && row.repo ? row.repo : String(row.verdict).slice('move-scope:'.length);
                const repo = raw.trim();
                if (!repo) {
                    rowOut.status = 'skippedInvalid';
                    rowOut.notice = 'move-scope 需要目标 repo(move-scope:<repo> 或 repo 列)';
                    result.skippedInvalid++;
                    break;
                }
                const n = deps.store.patchRepoKey(id, { repoKeyName: repo }, undefined);
                rowOut.status = n > 0 ? 'applied' : 'noop';
                break;
            }
            case 'mark-adopted': {
                deps.store.bumpActivationDirect(id, { adopted: 1, anchorAt: new Date().toISOString() });
                rowOut.status = 'applied';
                break;
            }
            case 'keep': {
                rowOut.status = 'noop';
                rowOut.notice = 'keep:明确保留,无操作(留痕于此)';
                result.noop++;
                break;
            }
        }
        if (rowOut.status === 'applied')
            result.applied++;
        result.rows.push(rowOut);
    }
    // demote-to-wiki 挂钩 L2 重聚类(T3.10):按族入队受影响场景
    if (!dryRun && demotedScenes.size > 0) {
        for (const [family, scenes] of demotedScenes) {
            if (scenes.size > 0)
                deps.store.enqueueSceneRecluster(family, [...scenes], result.snapshot ?? 'verdicts');
        }
    }
    return result;
}
