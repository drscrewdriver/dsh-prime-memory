/**
 * 保留式重建:清空 L1 前判定**哪些记忆不可能被 L0 重蒸馏出来**,并把这些保住。
 *
 * ## 为什么需要这个模块
 *
 * `RebuildController.prepare()` 的语义是"清空 L1 检索库 → 从 L0 全量重蒸馏"。
 * 这个语义对**由 L0 蒸馏而来**的记忆是自洽的(清掉也能再造一遍),但对
 * **不由 L0 派生**的记忆是破坏性的:`memory_add` / `memory_import` 写进来的
 * 外部记忆(其他 AI 工具导出的记忆包)在任何会话日志里都没有对应位置,
 * 重建不会再造出它们。实测(`_analysis_output` 探针,2026-09-17)这类记录
 * 当时有 19 条存活,涉及 `__manual__` 与若干外部导入场景名。
 *
 * ## 判据为什么是 `source_message_ids`,而不是"有没有锚点"
 *
 * 计划书原稿写的是"无来源记忆(**导入类 / 无锚点类**)",但实测推翻了后半句:
 *
 * - 检索库 `l1_records` **没有 `source_message_ids` 列**(见 `types.ts:224` 的
 *   既有注释"JSONL 事实源保留;检索库不存该列"),所以判据只能来自**事实源**;
 * - 检索库里 `dsh_source_anchors` 的命中数是 **0/740** —— task_31 落地的锚点
 *   写入**尚未产出任何一行**(没有新的蒸馏发生过)。把"无锚点"当判据会把
 *   **全部 740 条**都判成"要保留",重建直接退化成空操作。
 *
 * 所以判据取事实源里的 `source_message_ids`:非空 ⇒ 该记忆的位置在 L0 日志里
 * 有据可查、重建能再造;空/缺失 ⇒ 造不出来,**必须保留**。
 *
 * ## 为什么必须取"事实源 ∩ 检索库"
 *
 * 事实源是**只增不改**的历史(合并/更新产出新 id 后,旧行仍留在 JSONL)。
 * 实测:事实源 1,694 个唯一 id,检索库 740 个,`事实源 ∩ 检索库 == 检索库`
 * (即检索库是事实源的真子集,反向差集为 0)。其中**已从检索库退场、但没有
 * `source_message_ids` 的有 25 条** —— 按事实源无脑恢复会**复活这 25 条已删记录**。
 * 故保留集 = 事实源无来源 **且** 检索库仍存在,两个条件缺一不可。
 *
 * ## 静默缺席的处理
 *
 * 事实源读不出来时,"没有记录需要保留"与"不知道哪些记录需要保留"长得一模一样。
 * 后者若按前者处理,重建就**静默退化**成原来的破坏性行为。故 `gateClear()` 在
 * 事实源不可读(或可读但零记录)**且检索库非空**时**拒绝放行**,而不是放行。
 */
import { readdir } from 'node:fs/promises';
import { readJsonl } from '../util/io.js';
/** 判定单条记录是否可由 L0 重蒸馏出来(事实源侧判据)。 */
export function isRederivable(record) {
    const src = record.source_message_ids;
    return Array.isArray(src) && src.length > 0;
}
/**
 * 读取事实源目录(`<dataDir>/records/*.jsonl`)。
 *
 * 只读 `*.jsonl` 顶层文件:`archiveDerived()` 把旧目录整体改名为
 * `records.bak.<ts>`,它是**兄弟目录**不是文件,不会被 glob 命中。
 * **必须在 `archiveDerived()` 之前调用** —— 归档之后事实源就搬走了。
 */
export async function readFactSource(recordsDir) {
    let names;
    try {
        names = (await readdir(recordsDir)).filter((n) => n.endsWith('.jsonl'));
    }
    catch (err) {
        const code = err?.code;
        return {
            ok: false,
            records: [],
            files: 0,
            reason: code === 'ENOENT' ? 'dir-missing' : 'read-error',
            detail: err instanceof Error ? err.message : String(err),
        };
    }
    // 同名 id 后者胜:JSONL 是追加日志,同日文件里后写的是更新形态。
    const byId = new Map();
    for (const name of names) {
        try {
            const rows = await readJsonl(`${recordsDir.replace(/[\\/]+$/, '')}/${name}`);
            for (const r of rows) {
                if (!r || typeof r.id !== 'string' || !r.id)
                    continue;
                byId.set(r.id, r);
            }
        }
        catch (err) {
            return {
                ok: false,
                records: [],
                files: names.length,
                reason: 'read-error',
                detail: `${name}: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
    return { ok: true, records: [...byId.values()], files: names.length };
}
/**
 * 出保留计划。纯函数:输入事实源记录 + 检索库现存记录,输出要保留什么。
 *
 * 两个方向都保守:事实源说"这条没来源"要留,**检索库里查不到出处**也要留
 * (`unprovenanced`)—— 判据缺失时留,而不是丢。
 *
 * `liveDbRecords` 由调用方从**检索库**取(它没有 `source_message_ids` 列,
 * 只用来回答"这条还在不在"),恢复时以检索库副本为准 —— 那是当前检索态。
 */
export function planPreserve(factRecords, liveDbRecords) {
    const live = new Map();
    for (const r of liveDbRecords)
        if (r && typeof r.id === 'string')
            live.set(r.id, r);
    const preserved = [];
    let rederivable = 0;
    let retiredNoSource = 0;
    const seen = new Set();
    for (const f of factRecords) {
        if (typeof f?.id !== 'string' || !f.id)
            continue;
        seen.add(f.id);
        if (isRederivable(f)) {
            // 有来源但已退场(合并掉了)的不必计数——重建会按 L0 再造。
            if (live.has(f.id))
                rederivable++;
            continue;
        }
        const current = live.get(f.id);
        if (!current) {
            retiredNoSource++;
            continue;
        }
        preserved.push({
            record: current,
            reason: String(current.content ?? '').trim() ? 'no-source' : 'empty-content',
        });
    }
    // 检索库里有、事实源里没有 ⇒ 来源无从证明,一律保留(见 PreserveReason 注释)。
    for (const [id, r] of live) {
        if (seen.has(id))
            continue;
        preserved.push({ record: r, reason: 'unprovenanced' });
    }
    preserved.sort((a, b) => a.record.id.localeCompare(b.record.id));
    return {
        preserved,
        rederivable,
        retiredNoSource,
        factCount: factRecords.length,
        dbCount: live.size,
    };
}
/**
 * 清空前的守门判定。
 *
 * 拒绝而不是放行,是因为"没有需要保留的"与"不知道有没有需要保留的"在数据上
 * 无法区分(见文件头「静默缺席的处理」)。检索库为空时不存在可失去的记忆,
 * 故那一路照常放行 —— 不把功能卡死在干净环境上。
 */
export function gateClear(read, plan) {
    if (plan.dbCount === 0) {
        return { allowed: true, code: 'empty-db', note: '检索库为空,无可保留项' };
    }
    if (!read.ok) {
        const why = read.reason === 'dir-missing' ? '事实源目录不存在' : `事实源读取失败(${read.detail ?? '未知原因'})`;
        return {
            allowed: false,
            code: 'source-missing',
            note: `${why},而检索库有 ${plan.dbCount} 条记忆 —— 无法判定其中哪些不是从 L0 蒸馏来的,` +
                '已中止重建且**未清空任何数据**。请先恢复 records/ 事实源(或从 snapshots/ 的快照找回)后重试。',
        };
    }
    if (read.records.length === 0) {
        return {
            allowed: false,
            code: 'source-empty',
            note: `事实源可读但一条记录都没有,而检索库有 ${plan.dbCount} 条记忆 —— 事实源与检索库不一致,` +
                '已中止重建且**未清空任何数据**。请检查 records/ 是否被清空或迁移过。',
        };
    }
    const keep = plan.preserved.length;
    return {
        allowed: true,
        code: 'ok',
        note: keep > 0
            ? `保留 ${keep} 条无 L0 来源的记忆(导入/手工写入),重建只重造 ${plan.rederivable} 条有来源的记忆`
            : `无无来源记忆需要保留,重建重造 ${plan.rederivable} 条有来源的记忆`,
    };
}
/**
 * 把保留集放回检索库 + 事实源。
 *
 * 走 `L1Store.appendNew` 而不是 `db.upsertL1`:前者**双写**(JSONL 事实源 + 检索库),
 * 而此刻 `records/` 刚被 `archiveDerived()` 改名走,只写检索库会让这些记忆
 * 再次成为"没有事实源副本"的孤儿 —— 下一次重建就再也判不出它们了。
 */
export async function restorePreserved(l1, plan) {
    const ids = plan.preserved.map((p) => p.record.id);
    if (ids.length === 0)
        return { attempted: 0, restored: 0, missing: [] };
    await l1.appendNew(plan.preserved.map((p) => p.record));
    const back = new Set(l1.getByIds(ids).map((r) => r.id));
    const missing = ids.filter((id) => !back.has(id));
    return { attempted: ids.length, restored: ids.length - missing.length, missing };
}
/** 面向日志/状态栏的一行摘要。 */
export function describePlan(plan) {
    const byReason = new Map();
    for (const p of plan.preserved)
        byReason.set(p.reason, (byReason.get(p.reason) ?? 0) + 1);
    const parts = [...byReason].map(([r, n]) => `${r} ${n}`);
    return (`保留 ${plan.preserved.length} 条无来源记忆${parts.length ? `(${parts.join(' / ')})` : ''};` +
        `可重蒸馏 ${plan.rederivable} 条;事实源 ${plan.factCount} 条(其中无来源但已退场 ${plan.retiredNoSource} 条,不恢复)`);
}
