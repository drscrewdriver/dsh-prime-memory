/**
 * 核对运行的成本闸门与断点续跑(task_9)。
 *
 * ## 两阶段是**结构强制**的,不是靠自觉
 * `planReconcile()` 出预估,`executeReconcile()` 才跑,且后者**只接受前者产出的
 * `ReconcilePlan`**。"先给人看预估再开始跑"因此不是一条纪律,而是类型上的唯一通路。
 *
 * ## 为什么必须有闸门
 * 核对是 **LLM 花费**。1,254 条 `user/message` 只占全部事件 0.6%,但真正贵的是
 * **证据长度**:单次取证上限默认 12,000 字符,按 695 条记忆 × 每条 1 次调用算,
 * 上界就是 ~200 万输入字符。不设闸门跑一次,用户看到账单才知道。
 *
 * ## 断点续跑:键是 `(memoryId, 内容哈希)`,不是 `memoryId`
 * 只记 id 会有一个隐蔽错误:**记忆内容改过之后,续跑会跳过它**,于是报告里留着
 * 一条对**旧正文**的判定,而那条判定看起来完全正常。带上内容哈希,正文一变
 * 就必须重核。
 *
 * 状态在**每条完成后**原子落盘:中断(包括进程被杀)后重启能续跑,已完成的不重复
 * 计费。
 */
import { createHash } from 'node:crypto';
import { CHARS_PER_TOKEN } from '../util/context-occupancy.js';
import { atomicWriteJson, readJsonIfExists } from '../util/io.js';
import { renderReport, runReconcile, } from './reconcile.js';
export const DEFAULT_RECONCILE_BUDGET = {
    maxRecords: 50,
    maxAnchorsPerMemory: 8,
    maxEvidenceChars: 12_000,
    maxCalls: 50,
};
/** 内容哈希前 8 位:**正文一变就必须重核**(见模块头注释)。 */
export function contentHash(text) {
    return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 8);
}
/** 续跑键:`(memoryId, 内容哈希)`。 */
export function resumeKey(memory) {
    return `${memory.id}:${contentHash(memory.text)}`;
}
/** 状态文件路径(与 `pendingPathFor` / `state.json` 同目录)。 */
export function reconcileStatePathFor(dataDir) {
    return `${dataDir.replace(/[\\/]+$/, '')}/reconcile-state.json`;
}
/** 读状态;**文件损坏/版本不符一律当作空状态**,不抛(续跑状态坏了不该阻止运行)。 */
export async function loadRunState(file) {
    const raw = await readJsonIfExists(file);
    if (!raw || raw.version !== 1 || !Array.isArray(raw.done))
        return undefined;
    return {
        version: 1,
        runId: typeof raw.runId === 'string' ? raw.runId : '',
        startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
        done: raw.done.filter((k) => typeof k === 'string'),
    };
}
/**
 * 预估并裁剪。
 *
 * @param memories - 全部候选记忆。
 * @param budget - 三重上限。
 * @param doneKeys - 上次已完成、本次要跳过的键。
 * @returns 预估 + 计划。**这是唯一能产出 `ReconcilePlan` 的入口。**
 */
export function planReconcile(memories, budget = DEFAULT_RECONCILE_BUDGET, doneKeys = []) {
    const done = new Set(doneKeys);
    let skippedNoAnchor = 0;
    let alreadyDone = 0;
    const billableInputs = [];
    for (const memory of memories) {
        const anchors = memory.sourceAnchors ?? [];
        if (anchors.length === 0) {
            // 无锚点不产生调用,但**仍要在计划里**,否则报告会漏掉这批条目
            skippedNoAnchor += 1;
            billableInputs.push(memory);
            continue;
        }
        if (done.has(resumeKey(memory))) {
            alreadyDone += 1;
            continue;
        }
        billableInputs.push(memory);
    }
    const trimmedByRecords = Math.max(0, billableInputs.length - budget.maxRecords);
    const byRecords = billableInputs.slice(0, budget.maxRecords);
    // 锚点裁剪:每条只留前 N 个(顺序即重要性,调用方保证)
    const clipped = byRecords.map((memory) => {
        const anchors = memory.sourceAnchors ?? [];
        if (anchors.length <= budget.maxAnchorsPerMemory)
            return memory;
        return { ...memory, sourceAnchors: anchors.slice(0, budget.maxAnchorsPerMemory) };
    });
    // 调用数闸门:无锚点条目不花钱,不吃调用预算
    let calls = 0;
    const kept = [];
    let trimmedByCalls = 0;
    for (const memory of clipped) {
        if ((memory.sourceAnchors ?? []).length === 0) {
            kept.push(memory);
            continue;
        }
        if (calls >= budget.maxCalls) {
            trimmedByCalls += 1;
            continue;
        }
        calls += 1;
        kept.push(memory);
    }
    const planChars = kept.reduce((sum, memory) => sum + memory.text.length + ((memory.sourceAnchors ?? []).length > 0 ? budget.maxEvidenceChars : 0), 0);
    const anchors = kept.reduce((sum, memory) => sum + (memory.sourceAnchors ?? []).length, 0);
    const estimate = {
        total: memories.length,
        billable: calls,
        skippedNoAnchor,
        trimmedByRecords,
        trimmedByCalls,
        anchors,
        alreadyDone,
        estInputChars: planChars,
        estInputTokens: Math.ceil(planChars / CHARS_PER_TOKEN),
        estCalls: calls,
    };
    return { budget, estimate, memories: kept, summary: renderEstimate(estimate, budget) };
}
/** 预估说明(先给人看)。**必须写清裁掉了什么**——只报"要跑多少"会让人以为跑全了。 */
export function renderEstimate(estimate, budget) {
    const lines = [];
    lines.push('核对预估(上界):');
    lines.push(`- 候选记忆 ${estimate.total} 条`);
    lines.push(`- 其中无锚点、直接跳过(不计费)${estimate.skippedNoAnchor} 条`);
    lines.push(`- 上次已完成、本次跳过 ${estimate.alreadyDone} 条`);
    lines.push(`- **本次将发起模型调用 ${estimate.estCalls} 次**(上限 ${budget.maxCalls})`);
    lines.push(`- 锚点合计 ${estimate.anchors} 个(单条上限 ${budget.maxAnchorsPerMemory})`);
    lines.push(`- 输入上界 ≈ ${estimate.estInputChars} 字符 / ≈ ${estimate.estInputTokens} token(证据单条上限 ${budget.maxEvidenceChars} 字符)`);
    if (estimate.trimmedByRecords > 0) {
        lines.push(`- ⚠️ 因条数上限 ${budget.maxRecords} 裁掉 **${estimate.trimmedByRecords}** 条`);
    }
    if (estimate.trimmedByCalls > 0) {
        lines.push(`- ⚠️ 因调用数上限 ${budget.maxCalls} 裁掉 **${estimate.trimmedByCalls}** 条`);
    }
    if (estimate.trimmedByRecords > 0 || estimate.trimmedByCalls > 0) {
        lines.push('  被裁掉的条目**本次不会核对**,也不会出现在报告里——要全跑请调高上限再执行。');
    }
    return lines.join('\n');
}
/**
 * 执行计划(只读;唯一的副作用是写**续跑状态文件**,不是记忆库)。
 *
 * 逐条执行、**每条完成后原子落盘**:进程被杀也能续跑,已完成的不重复计费。
 */
export async function executeReconcile(deps, plan, opts = {}) {
    const stateFile = opts.stateFile;
    const previous = stateFile === undefined ? undefined : await loadRunState(stateFile);
    const done = new Set(previous?.done ?? []);
    const state = previous ?? {
        version: 1,
        runId: createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 12),
        startedAt: Date.now(),
        updatedAt: Date.now(),
        done: [],
    };
    const verdicts = [];
    let interrupted = false;
    for (const memory of plan.memories) {
        if (opts.signal?.aborted === true) {
            interrupted = true;
            break;
        }
        const key = resumeKey(memory);
        if (done.has(key))
            continue; // 已完成:不重复计费
        const single = await runReconcile(deps, [memory], {
            maxRecords: 1,
            maxEvidenceChars: plan.budget.maxEvidenceChars,
        });
        const verdict = single.verdicts[0];
        if (verdict === undefined)
            continue;
        verdicts.push(verdict);
        // 逐条落盘:中断粒度 = 1 条
        done.add(key);
        state.done.push(key);
        state.updatedAt = Date.now();
        if (stateFile !== undefined)
            await atomicWriteJson(stateFile, state);
        opts.onProgress?.(verdicts.length, plan.memories.length, verdict);
    }
    const counts = { contradicted: 0, supported: 0, unverifiable: 0 };
    for (const verdict of verdicts)
        counts[verdict.state] += 1;
    return {
        verdicts,
        // 报告前缀预估说明:只报"判了几条"会让人以为跑全了
        report: [plan.summary, '', '---', '', renderReport(verdicts, counts, plan.estimate.total, plan.memories.length)].join('\n'),
        counts,
        interrupted,
        ...(stateFile === undefined ? {} : { state }),
    };
}
/** 清空续跑状态(显式动作:下次运行会重核所有条目,**会重复计费**)。 */
export async function resetRunState(file) {
    await atomicWriteJson(file, { version: 1, runId: '', startedAt: 0, updatedAt: 0, done: [] });
}
/** 供装配层使用:把证据面与 judge 组装成 deps。 */
export function makeReconcileDeps(evidence, judge, logger) {
    return { evidence, judge, ...(logger === undefined ? {} : { logger }) };
}
