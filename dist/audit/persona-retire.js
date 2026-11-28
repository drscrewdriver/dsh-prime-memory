/**
 * 存量去人格化（persona-leak-guardrails task_6.1）。
 *
 * 与「审计」分工明确：审计**只报告**（默认不改库），本模块**显式改库**且必须人工点名触发。
 *
 * 写面纪律（踩过的坑都在这里）：
 *  1. **摘特征后保留**（裁决①）——「本鱼已核实 X」→「已核实 X」，不是删条目；
 *  2. **摘完为空才退场**，且走 `L1Store.retire()` 这个汇流口——退场判据是全仓唯一的
 *     `dsh_superseded` 标记，不是某个 `retired` 列（库里根本没有那列）；
 *  3. **改正文走 `reviseInPlace`**：它会同时更新检索库 + `l1_fts` + **JSONL 追加版本行**。
 *     只改 DB 而事实源留旧文，下次「重建记忆」会把旧人格词静默回滚。
 */
import { scrubPersonaArtifacts } from './persona-scrub.js';
import { loadPersonaTerms } from './persona-terms.js';
/**
 * 分页取出全部活跃 L1 记录。
 *
 * 为什么不用一次大 limit：真机 2436 条还能一把捞，但这个数是会长大的，
 * 而一次性把几千条正文塞进数组的代价是峰值内存——分页是免费的保险。
 */
export function collectActiveRecords(store, pageSize = 500) {
    const out = [];
    for (let offset = 0;; offset += pageSize) {
        const page = store.list({ retired: false, limit: pageSize, offset });
        out.push(...page.items);
        if (page.items.length < pageSize || out.length >= page.total)
            break;
    }
    return out;
}
/**
 * 纯计划：只算「改哪些、退哪些」，**不写库**。
 *
 * 抽成纯函数是为了让「摘完为空才退」这条判据可以被单测钉住——藏在写路径里就只剩真机可验。
 */
export function planPersonaRetire(records, terms) {
    const plan = { scanned: records.length, rewritten: [], emptied: [] };
    for (const record of records) {
        const content = typeof record.content === 'string' ? record.content : '';
        if (content === '')
            continue;
        const scrubbed = scrubPersonaArtifacts(content, terms);
        if (scrubbed === content)
            continue;
        if (scrubbed === '')
            plan.emptied.push(record);
        else
            plan.rewritten.push({ record, content: scrubbed, before: content.length, after: scrubbed.length });
    }
    return plan;
}
/**
 * 执行（或预览）存量去人格化。
 *
 * @returns 逐条结果；`applied=false` 时库一字未动
 */
export async function retirePersonaArtifacts(store, opts) {
    const terms = opts.terms ?? loadPersonaTerms();
    const pool = opts.recordIds === undefined
        ? (opts.records ?? collectActiveRecords(store))
        : store.getByIds([...opts.recordIds]);
    const plan = planPersonaRetire(pool, terms);
    const outcome = {
        scanned: plan.scanned,
        rewritten: plan.rewritten.map((r) => ({
            recordId: r.record.id,
            name: r.record.name ?? '',
            before: r.before,
            after: r.after,
        })),
        emptied: plan.emptied.map((r) => ({ recordId: r.id, name: r.name ?? '' })),
        applied: false,
    };
    if (opts.dryRun)
        return outcome;
    const at = new Date().toISOString();
    for (const item of plan.rewritten) {
        await store.reviseInPlace({ ...item.record, content: item.content, updatedAt: Date.now() });
        opts.logger?.info(`[memory] 存量去人格化: ${item.record.id}（${item.before} → ${item.after} 字）`);
    }
    if (plan.emptied.length > 0) {
        const n = store.retire(plan.emptied.map((r) => r.id), { at, reason: 'manual' });
        opts.logger?.warn(`[memory] 存量去人格化: ${n} 条整条皆人格化，已退场（可恢复）`);
    }
    outcome.applied = true;
    return outcome;
}
