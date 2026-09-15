/**
 * L1 蒸馏:抽取(情境切分 + 记忆提取)→ 去重(冲突检测 + 合并)→ 写入。
 *
 * 流程(官方管线语义):抽取 prompt 分块跑(按 llm.maxInputChars 预算,情境链式
 * 衔接)→ 去重候选按族召回 → 批量冲突检测 prompt → 决策应用:新记录追加进事实源,
 * 被替换目标只从检索库删除。 族隔离贯穿始终:去重候选只在同族内,合并产物保持
 * 新记忆的族标签。
 */
import { randomBytes } from 'node:crypto';
import { callLLM, parseJsonLogged, resolveLayerTokens } from '../llm.js';
import { buildReceipts, newRunId, persistReceiptsSafely } from '../store/receipts.js';
import { buildConflictPair, validateConflictPair } from '../store/conflicts.js';
import { formatExtractionPrompt, getExtractMemoriesSystemPrompt } from '../prompts/l1-extraction.js';
import { formatBatchConflictPrompt, getConflictDetectionSystemPrompt } from '../prompts/l1-dedup.js';
import { familyForType, normPersistence, resolveRecordFamily } from '../types.js';
/** 解析 ISO/epoch 时间证据,非法或非正值一律 undefined——不猜测。 */
function parseTimeEvidence(raw) {
    const t = typeof raw === 'string' ? Date.parse(raw) : typeof raw === 'number' ? raw : Number.NaN;
    return Number.isFinite(t) && t > 0 ? t : undefined;
}
/**
 * 抽取产出的 metadata → 记录的时间轴。
 *
 * `activity_start_time`/`activity_end_time` 是这两列的前身(prompt 已在产出),
 * 这里把它们提升为结构化字段;`persistence` 由 prompt 产出,缺省即未判定。
 */
function temporalOf(meta) {
    return {
        validFrom: parseTimeEvidence(meta?.activity_start_time),
        validTo: parseTimeEvidence(meta?.activity_end_time),
        persistence: normPersistence(meta?.persistence),
    };
}
/**
 * 合并(merge/update)时的有效期并集:
 * 起 = 两侧最早;止 = 任一侧未闭合则仍未闭合(undefined),否则取最晚。
 * 持续性以新记忆为准(合并产物描述的是当前认知),新记忆未判定时继承旧记录。
 */
function mergeTemporal(self, targets) {
    const froms = [self.validFrom, ...targets.map((r) => r.validFrom)].filter((t) => t !== undefined);
    const tos = [self.validTo, ...targets.map((r) => r.validTo)];
    const anyOpen = tos.some((t) => t === undefined);
    const closed = tos.filter((t) => t !== undefined);
    return {
        validFrom: froms.length > 0 ? Math.min(...froms) : undefined,
        validTo: anyOpen || closed.length === 0 ? undefined : Math.max(...closed),
        persistence: self.persistence ?? targets.find((r) => r.persistence)?.persistence,
    };
}
/**
 * 构造一条**全新**L1 记录(store 语义)。§C 冻结复用同一构造:
 * "新记忆照常入 L1"必须与既有 store 路径**逐字段一致**,否则冻结会引入
 * 一种只在开启开关时才出现的新记录形状。
 */
function toStoreRecord(m, now, ts) {
    return {
        id: m.record_id,
        content: m.content,
        type: m.type,
        priority: Number(m.priority) || 60,
        scene_name: m.scene_name,
        timestamps: [Number.isNaN(ts) ? now : ts],
        createdAt: now,
        updatedAt: now,
        version: 0,
        source_message_ids: m.source_message_ids ?? [],
        metadata: m.metadata ?? {},
        family: m.family,
        ...temporalOf(m.metadata),
    };
}
function newId(prefix) {
    return `${prefix}_${Date.now()}_${randomBytes(3).toString('hex')}`;
}
/**
 * 按字符预算把消息切成多块(保持顺序,单条超预算独占一块,由 callLLM 兜底截断)。
 * 每条消息按 content 长度 + 64 字符脚手架开销(id/时间戳行)计。
 */
export function chunkByCharBudget(messages, budgetChars) {
    if (messages.length === 0)
        return [];
    const chunks = [];
    let cur = [];
    let curChars = 0;
    for (const m of messages) {
        const len = m.content.length + 64;
        if (cur.length > 0 && curChars + len > budgetChars) {
            chunks.push(cur);
            cur = [];
            curChars = 0;
        }
        cur.push(m);
        curChars += len;
    }
    if (cur.length > 0)
        chunks.push(cur);
    return chunks;
}
export async function runExtraction(ctx, cfg, store, states, pending, background, logger, mode) {
    if (!cfg.extract.enabled)
        return { stored: 0, skipped: true, sceneName: chainHead(states, mode), newRecords: [] };
    // 触发阈值(渐进爬坡 + 按会话切片计数)由 runner 判定(trigger.ts);
    // 此处不再重复 gate——重建轮 force 与 warmup 早期轮次都会传入小于稳态值的切片。
    // 纯档强制族 = 档位族;auto 档抽取后的记录族按 type 前缀判定
    const forcedFamily = mode === 'auto' ? undefined : mode;
    // 情境链锚点桶:纯档用本族;auto 用最近活跃的族(chainHead 同源)
    const chainState = mode === 'auto' ? activeState(states) : states[mode];
    // ── Step 1: 抽取(输入按 llm.maxInputChars 预算分块,情境链式衔接,不丢消息) ──
    const backgroundMsgs = background.slice(-cfg.extract.backgroundMessages);
    // 预留:背景消息(≤10 条 ×4000 字)+ prompt 脚手架
    const perChunk = Math.max(20_000, cfg.llm.maxInputChars - 42_000);
    const chunks = chunkByCharBudget(pending, perChunk);
    if (chunks.length > 1) {
        logger.info(`[memory] L1 输入超预算(${pending.length} 条消息),分 ${chunks.length} 块抽取(每块 ≤${perChunk} 字符)`);
    }
    const extracted = [];
    let lastScene = chainState.lastSceneName;
    let sceneCount = 0;
    for (const chunk of chunks) {
        const userPrompt = formatExtractionPrompt({
            newMessages: chunk,
            backgroundMessages: backgroundMsgs,
            previousSceneName: lastScene || '无',
            halls: cfg.hall?.enabled,
        });
        const raw = await callLLM(ctx, cfg, {
            system: getExtractMemoriesSystemPrompt(mode),
            user: userPrompt,
            maxTokens: resolveLayerTokens(cfg, 'extract'),
            layer: 'l1-extract',
            logger,
        });
        const scenes = parseJsonLogged(raw, 'L1 抽取', logger);
        if (!Array.isArray(scenes))
            throw new Error('L1 抽取输出不是 JSON 数组');
        for (const scene of scenes) {
            if (!scene || typeof scene.scene_name !== 'string')
                continue;
            lastScene = scene.scene_name;
            sceneCount++;
            for (const m of scene.memories ?? []) {
                if (!m || typeof m.content !== 'string' || !m.content.trim())
                    continue;
                extracted.push({
                    ...m,
                    record_id: newId('mem'),
                    scene_name: scene.scene_name,
                    family: resolveRecordFamily(forcedFamily, m.family, m.type ?? ''),
                });
            }
        }
    }
    if (extracted.length === 0) {
        logger.info(`[memory] L1 抽取完成:无可提取记忆(mode=${mode},${pending.length} 条消息,${sceneCount} 个情境)`);
        // 成功但零产出:同样推进时间戳/场景,与失败(lastExtractAt 保持 0)区分开
        markExtracted(states, mode, lastScene);
        return { stored: 0, skipped: false, sceneName: lastScene, newRecords: [] };
    }
    // ── Step 2: 去重(batch 冲突检测;候选只在本族内召回,去重永不跨族) ──
    const matches = await Promise.all(extracted.map(async (m) => ({
        newMemory: m,
        candidates: await store.searchCandidates(m.content, cfg.extract.candidatePool, m.family),
    })));
    const dedupPrompt = formatBatchConflictPrompt(matches);
    const dedupRaw = await callLLM(ctx, cfg, {
        system: getConflictDetectionSystemPrompt(mode, { conflictFreeze: cfg.conflictFreeze.enabled }),
        user: dedupPrompt,
        maxTokens: resolveLayerTokens(cfg, 'dedup'),
        layer: 'l1-dedup',
        logger,
    });
    const decisions = parseJsonLogged(dedupRaw, 'L1 去重判定', logger);
    const byRecord = new Map();
    for (const d of Array.isArray(decisions) ? decisions : []) {
        if (d && typeof d.record_id === 'string')
            byRecord.set(d.record_id, d);
    }
    // 去重决策统计:无决策的记录按 skip 处理,聚合成单行日志便于排查
    const actionCount = {};
    for (const m of extracted) {
        const action = byRecord.get(m.record_id)?.action ?? 'skip(未返回)';
        actionCount[action] = (actionCount[action] ?? 0) + 1;
    }
    const candidateTotal = matches.reduce((n, m) => n + m.candidates.length, 0);
    logger.info(`[memory] L1 去重判定:${extracted.length} 条候选记忆召回 ${candidateTotal} 条已有记录,决策 ${Object.entries(actionCount)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`);
    // ── §B 决策凭证:在应用决策前留痕(旁路设施,写失败绝不中断蒸馏) ──
    // 覆盖**全部** extracted:包括 skip 与"模型没返回决策"——回溯"这条为什么没进记忆"
    // 与"为什么进了"同等重要,而 skip 恰好是现有代码里唯一完全不留痕的分支
    // (下方应用循环 `if (!decision || action === 'skip') continue` 直接跳过)。
    // matches 与 extracted 同长同序(Promise.all 按数组序),故按下标取候选池。
    // 注:本轮不开配置开关——新增开关要连带改 config schema / contract / 设置页,
    // 属范围蔓延;凭证本身是纯旁路且幂等,先落地,需要时再加 kill-switch。
    // runId 提到块外:§C 冻结对要沿用同一批次 id,使「这一轮判了什么」与
    // 「这一轮冻结了哪一对」在记忆库侧可交叉审计(findings.md §3 / §9)。
    const runId = newRunId();
    {
        const items = extracted.map((m, i) => ({
            recordId: m.record_id,
            candidateIds: (matches[i]?.candidates ?? []).map((c) => c.id),
            action: byRecord.get(m.record_id)?.action,
        }));
        persistReceiptsSafely((rows) => store.recordReceipts(rows), buildReceipts(runId, new Date().toISOString(), items), logger);
    }
    // ── Step 3: 应用决策(官方语义:新记录追加进事实源,被替换目标只从检索库删除) ──
    // 只按需取决策涉及的记录(候选 + 目标 id 并集),避免每轮全表扫描
    const relatedIds = new Set();
    for (const d of byRecord.values()) {
        for (const id of d.target_ids ?? [])
            relatedIds.add(id);
    }
    for (const m of matches) {
        for (const c of m.candidates)
            relatedIds.add(c.id);
    }
    const byId = new Map(store.getByIds([...relatedIds]).map((r) => [r.id, r]));
    const deletedIds = new Set();
    const added = [];
    /** §C 本轮新冻结的冲突对(应用完新增记录后统一落盘)。 */
    const frozen = [];
    const now = Date.now();
    for (const m of extracted) {
        const decision = byRecord.get(m.record_id);
        if (!decision || decision.action === 'skip')
            continue;
        const action = decision.action;
        const ts = m.metadata?.activity_start_time ? Date.parse(String(m.metadata.activity_start_time)) : now;
        if (action === 'store') {
            added.push(toStoreRecord(m, now, ts));
            continue;
        }
        // ── §C 矛盾冻结:不自动裁决 ──
        // 走这里意味着**不覆盖、不合并、不删除**——新记忆按 store 语义照常入 L1,
        // 旧记忆原样留下,两者作为**一对**停放待人工裁决。
        // 开关关闭时 prompt 里根本没有 conflict 动作(零漂移见 task_23),但模型仍可能
        // 凭惯性输出它。此时**回落 store 而非落到下面的 update/merge 分支**:
        // 一个显式声明了"拿不准"的决策,绝不能被静默当成"新记忆更优"去覆盖旧记忆。
        if (action === 'conflict') {
            const pair = cfg.conflictFreeze?.enabled === true
                ? validateConflictPair(m.record_id, decision.winner, decision.loser, new Set(byId.keys()))
                : null;
            if (pair) {
                added.push(toStoreRecord(m, now, ts));
                frozen.push(buildConflictPair({
                    runId,
                    winnerId: pair.winnerId,
                    loserId: pair.loserId,
                    createdAt: new Date(now).toISOString(),
                }));
            }
            else {
                logger.warn(`[memory] 矛盾冻结:第 ${m.record_id} 条的 conflict 决策无法构成冻结对` +
                    `(winner=${String(decision.winner)} loser=${String(decision.loser)}),已回落 store`);
                added.push(toStoreRecord(m, now, ts));
            }
            continue;
        }
        // update / merge:目标记录从检索库删除,合并结果作为新记录追加(版本 +1)
        // 候选召回按族隔离,合并产物保持新记忆的族标签
        const targets = (decision.target_ids ?? []).filter((id) => byId.has(id));
        for (const id of targets)
            deletedIds.add(id);
        const targetVersion = targets.reduce((max, id) => Math.max(max, byId.get(id)?.version ?? 0), 0);
        const mergedTs = (decision.merged_timestamps ?? [])
            .map((t) => Date.parse(t))
            .filter((t) => !Number.isNaN(t))
            .concat([now]);
        added.push({
            id: m.record_id,
            content: decision.merged_content && decision.merged_content.trim()
                ? decision.merged_content
                : m.content,
            type: decision.merged_type || m.type,
            priority: Number(decision.merged_priority) || Number(m.priority) || 60,
            scene_name: m.scene_name,
            timestamps: Array.from(new Set(mergedTs)).sort((a, b) => a - b),
            createdAt: now,
            updatedAt: now,
            version: targetVersion + 1,
            source_message_ids: m.source_message_ids ?? [],
            metadata: m.metadata ?? {},
            family: m.family,
            // 合并的有效期取并集:起 = 两侧最早;止 = 任一侧未闭合则仍未闭合(undefined)。
            ...mergeTemporal(temporalOf(m.metadata), targets.map((id) => byId.get(id)).filter((r) => r !== undefined)),
        });
    }
    await store.appendNew(added);
    if (deletedIds.size > 0)
        await store.deleteBatch([...deletedIds]);
    // ── §C 冻结对落盘(排在 appendNew 之后) ──
    // 顺序有讲究:先让新记忆真正进 L1,再登记"它和谁构成待裁决对"。反过来的话,
    // 落盘失败会留下一条指向**不存在记录**的裁决请求,人工打开队列只会看到悬空 id。
    // 写失败与 §B 凭证同策略:记 warn、不中断蒸馏——冻结是旁路设施,
    // 让它有权打断一轮蒸馏是本末倒置。
    if (frozen.length > 0) {
        try {
            store.recordConflictPending(frozen);
        }
        catch (err) {
            logger.warn(`[memory] 矛盾冻结:${frozen.length} 对落盘失败(忽略): ${err instanceof Error ? err.message : String(err)}`);
        }
        // 图谱侧:`disputed` 是"照常召回、但状态可见"的中间态(graph/search.ts 仍在候选内)。
        // 图谱是可选派生投影,未启用时 markGraphDisputed 内部即 no-op。
        try {
            const ids = new Set();
            for (const p of frozen) {
                ids.add(p.winnerId);
                ids.add(p.loserId);
            }
            store.markGraphDisputed([...ids]);
        }
        catch (err) {
            logger.warn(`[memory] 矛盾冻结:图谱 disputed 标记失败(忽略): ${err instanceof Error ? err.message : String(err)}`);
        }
        logger.info(`[memory] 矛盾冻结:本轮停放 ${frozen.length} 对待人工裁决(run_id=${runId})`);
    }
    // 状态按记录族分桶推进(阈值计数各自独立)
    const addedByFamily = { chat: 0, work: 0 };
    for (const r of added)
        addedByFamily[r.family ?? familyForType(r.type)]++;
    for (const f of ['chat', 'work']) {
        if (addedByFamily[f] === 0)
            continue;
        states[f].totalExtracted += addedByFamily[f];
        states[f].newMemoriesSinceL2 += addedByFamily[f];
        states[f].memoriesSinceL3 += addedByFamily[f];
    }
    markExtracted(states, mode, lastScene);
    logger.info(`[memory] L1 抽取完成(mode=${mode}):消息 ${pending.length} 条,抽取 ${extracted.length} 条,去重后新增 ${added.length} 条(替换 ${deletedIds.size} 条,chat=${addedByFamily.chat}/work=${addedByFamily.work}),累计 chat=${states.chat.totalExtracted}/work=${states.work.totalExtracted}`);
    return { stored: added.length, skipped: false, sceneName: lastScene, newRecords: added };
}
/** auto 档取最近活跃的族 checkpoint(情境链/计数锚点)。 */
function activeState(states) {
    return states.chat.lastExtractAt >= states.work.lastExtractAt ? states.chat : states.work;
}
/** 情境链读取:auto → 最近活跃族;纯档 → 本族。 */
function chainHead(states, mode) {
    return (mode === 'auto' ? activeState(states) : states[mode]).lastSceneName;
}
/** 抽取成功后推进时间戳/情境链:auto → 两族都推进(链只写锚点桶);纯档 → 本族。 */
function markExtracted(states, mode, lastScene) {
    const now = Date.now();
    if (mode === 'auto') {
        // 两族的 lastExtractAt 都推进(去重候选各自族内判断"新消息");情境链只维护锚点桶
        states.chat.lastExtractAt = now;
        states.work.lastExtractAt = now;
        activeState(states).lastSceneName = lastScene;
    }
    else {
        states[mode].lastExtractAt = now;
        states[mode].lastSceneName = lastScene;
    }
}
