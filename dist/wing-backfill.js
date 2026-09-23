import { callLLM } from './llm.js';
import { normWingEnabled } from './config.js';
import { WING_FALLBACK } from './types.js';
import { parseJsonLogged } from './llm.js';
/** 单次任务处理上限(524 条存量一次跑完约为 LLM 成本大头;分批触发,可重复执行)。 */
const MAX_RECORDS = 300;
/** 每块条数(一次 LLM 调用判定的记录数)。 */
const CHUNK = 20;
const state = { running: false, updated: 0, failed: 0 };
export function wingBackfillState() {
    return { ...state };
}
const SYSTEM_PROMPT = '你是记忆库的域标注器。给你若干条记忆(带 id),为每条判断其内容属于哪个 Hall 域,输出 JSON 数组:' +
    '[{"id":"<原id>","wing":"<域id>"}]。wing 只能从给定候选列表中选;横跨多域或确实无法归入任何角时选 general。' +
    '只输出 JSON,不要多余文字。';
/** 启动后台回填;已在运行返回 false(单飞)。 */
export function startWingBackfill(deps) {
    if (state.running)
        return { started: false, running: true };
    state.running = true;
    state.updated = 0;
    state.failed = 0;
    void run(deps).finally(() => {
        state.running = false;
        deps.logger.info(`[memory] wing 回填结束:成功 ${state.updated} 条,失败 ${state.failed} 条`);
    });
    return { started: true, running: true };
}
async function run(deps) {
    const { ctx, cfg, l1, logger } = deps;
    const halls = normWingEnabled(cfg.hall?.enabled);
    if (halls.length === 0) {
        logger.warn('[memory] wing 回填跳过:wing.enabled 为空(打标功能已关闭)');
        return;
    }
    const candidates = [...halls, WING_FALLBACK].join(' / ');
    // 未打标集:主表全量里的 null wing(含 retired 行——restore 后标签已补,不重扫)
    const all = l1.all();
    const pending = all.filter((r) => !(r.metadata && typeof r.metadata.hall === 'string' && r.metadata.hall !== ''));
    let budget = Math.min(pending.length, MAX_RECORDS);
    logger.info(`[memory] wing 回填启动:未打标 ${pending.length} 条,本次上限 ${budget} 条(候选 ${candidates})`);
    for (let offset = 0; offset < pending.length && budget > 0; offset += CHUNK) {
        const chunk = pending.slice(offset, offset + CHUNK).filter(pickChunk);
        if (chunk.length === 0)
            continue;
        budget -= chunk.length;
        const labeled = await labelChunk(ctx, cfg, logger, chunk, candidates);
        for (const { record, hall } of labeled) {
            // 原记录最小改动:metadata.hall 单键写入,其余字段原样 upsert(同 id 版本不变语义)
            const next = { ...record, metadata: { ...(record.metadata ?? {}), hall } };
            try {
                await l1.upsert(next);
                state.updated++;
            }
            catch {
                state.failed++;
            }
        }
    }
}
/** 回填只处理活跃记录可安全加速,但 retired 行的 metadata_json 同样保留且 restore 后可见——
 *  upsert 对 retired 行的行为由存储层保证(同 id 覆盖不复活),这里不做活性过滤,口径与迁移一致(全量)。 */
function pickChunk(_r) {
    return true;
}
async function labelChunk(ctx, cfg, logger, chunk, candidates) {
    const list = chunk.map((r, i) => `${i + 1}. id=${r.id}\n${r.content.slice(0, 300)}`).join('\n\n');
    const user = `候选 Hall:${candidates}\n\n记忆列表:\n${list}`;
    try {
        const raw = await callLLM(ctx, cfg, {
            system: SYSTEM_PROMPT,
            user,
            maxTokens: 4096,
            layer: 'l1-extract',
            logger,
        });
        const parsed = parseJsonLogged(raw, 'wing 回填', logger);
        if (!Array.isArray(parsed))
            return [];
        const byId = new Map(chunk.map((r) => [r.id, r]));
        const out = [];
        for (const item of parsed) {
            const record = typeof item?.id === 'string' ? byId.get(item.id) : undefined;
            const hall = typeof item?.hall === 'string' ? item.hall.trim() : '';
            if (record && hall)
                out.push({ record, hall });
        }
        return out;
    }
    catch (err) {
        logger.warn(`[memory] wing 回填块失败(跳过 ${chunk.length} 条,原记录未改): ${err instanceof Error ? err.message : String(err)}`);
        state.failed += chunk.length;
        return [];
    }
}
