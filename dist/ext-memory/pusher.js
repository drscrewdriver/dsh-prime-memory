/**
 * 出站推送泵(计划 T2.1/T2.2):ext_outbox → 驱动 remember/forget,经 runner
 * 的 `ext-sync` 档串行执行(优先级 live > graph > ext-sync > rebuild——
 * 推送永远让位用户轮次与蒸馏,单飞由 wake 侧的占位标志保证)。
 *
 * 四条硬闸(全部有测试钉住,缺一条都不算 Phase 2 完成):
 * ① **双闸**:装配 enabled && push.enabled,且 syncMode ≠ shadow-read 才入队/派发;
 * ② **脱敏硬闸**(T0.11 接线位):任何 remember 出网前必经 pushRedactRecord,
 *    捕获侧 redactSecrets:false 绕不过这道;闸门异常 = 拒推,绝不带原文出境;
 * ③ **Phase 2 驱动白名单**:deletionMode=hard 的家任务挂 pending 不派发
 *    (allowHardDelete=false 时),不可逆远端删的传导等 Phase 3 面板闭环;
 * ④ **族白名单**:add 只推 push.families(默认 work——个人 chat 记忆默认不出机);
 *    forget 不受族限制,但只对**已在账影子**造队(没推过的外远端无事可做)。
 *
 * 写放大闸:shadow.db_digest 与当前记录指纹相同且已链 externalId → done skip;
 * 退避阶梯 [1000,3000,10000] 达 maxAttempts 转 dead(面板可查,不无限重放)。
 */
import { createHash, randomUUID } from 'node:crypto';
import { isRetired } from '../store/supersede.js';
import { canSync } from './types.js';
import { pushRedactRecord } from './redact-gate.js';
import { settleShadow } from './reconciler.js';
import { normContentKey, recordDigest } from './util.js';
/** 影子行的稳定主键:三元组的 sha 前缀——同一 (driver,space,record) 恒等,
 *  upsert 走冲突更新不裂变。**不用分隔符拼原文**:嵌入式 NUL/长路径在
 *  sqlite 绑定的字符串处理上有截断前科,纯 hex 键没有这个形状问题。 */
export function shadowIdFor(driverId, spaceId, recordId) {
    return `sh-${createHash('sha256').update(`${driverId}\u0000${spaceId}\u0000${recordId}`, 'utf8').digest('hex').slice(0, 32)}`;
}
/** 入队目标驱动集:只看"能不能同步"(remember + 寻址能力),**不看 hard 闸**——
 *  入队是意志的记录,派发才是门禁(allowHardDelete 在 processJob 逐任务拦);
 *  两边用同一过滤器会把 hard 家的意图在配置翻脸(Phase 3)后直接丢掉。 */
function enqueueTargets(deps) {
    return deps.registry.enabled().filter((d) => d.capabilities.remember && canSync(d.capabilities));
}
export function makeExtPusher(deps) {
    const nowMs = deps.now ?? (() => Date.now());
    const pushable = () => {
        const c = deps.cfg();
        return c.masterEnabled && c.enabled && c.syncMode !== 'shadow-read';
    };
    const hook = {
        enqueue(records, intent, _why) {
            if (!pushable() || records.length === 0)
                return;
            const c = deps.cfg();
            const targets = enqueueTargets(deps);
            if (targets.length === 0)
                return;
            let queued = 0;
            for (const rec of records) {
                if (rec.id === undefined || rec.id === '')
                    continue;
                for (const driver of targets) {
                    const spaces = deps.spacesOf(driver.id);
                    for (const space of spaces) {
                        if (intent === 'add') {
                            // 族白名单只约束 add(chat 记忆默认不出机);空集 = 全推
                            if (c.families.size > 0 && !c.families.has((rec.family ?? '').toLowerCase()))
                                continue;
                            if (deps.ext.enqueueOutbox({
                                jobId: `ob-${nowMs().toString(36)}-${randomUUID().slice(0, 8)}`,
                                driverId: driver.id,
                                spaceId: space.spaceId,
                                recordId: rec.id,
                                intent: 'add',
                                payloadDigest: recordDigest(rec),
                            }))
                                queued++;
                        }
                        else {
                            // forget 只对已在账影子造队:没推出去过的东西远端无事可做
                            const shadow = deps.ext.getShadowByRecord(driver.id, space.spaceId, rec.id);
                            if (shadow === undefined)
                                continue;
                            if (deps.ext.enqueueOutbox({
                                jobId: `ob-${nowMs().toString(36)}-${randomUUID().slice(0, 8)}`,
                                driverId: driver.id,
                                spaceId: space.spaceId,
                                recordId: rec.id,
                                intent: 'forget',
                                payloadDigest: recordDigest(rec),
                            }))
                                queued++;
                        }
                    }
                }
            }
            if (queued > 0)
                deps.wake();
        },
    };
    const backoffAt = (c, attempts) => {
        const idx = Math.min(attempts, c.backoffMs.length - 1);
        return nowMs() + (c.backoffMs[idx] ?? 10_000);
    };
    const runBatch = async () => {
        const stats = { processed: 0, done: 0, skipped: 0, settled: 0, orphans: 0, failed: 0, dead: 0, gated: 0 };
        if (!pushable())
            return stats;
        const c = deps.cfg();
        const deadline = nowMs() + c.timeBudgetMs;
        const jobs = deps.ext.pickDueOutbox(nowMs(), c.maxItems);
        for (const job of jobs) {
            if (nowMs() >= deadline)
                break;
            stats.processed++;
            await processJob(job, stats);
        }
        // 有积压自续一轮(wake 侧单飞;全空则不再续,杜绝热转)
        const remaining = deps.ext.countOutbox().pending;
        if (remaining > 0 && jobs.length > 0)
            deps.wake();
        return stats;
    };
    const processJob = async (job, stats) => {
        const c = deps.cfg();
        const driver = deps.registry.get(job.driverId);
        if (driver === undefined || !deps.registry.enabled().some((d) => d.id === driver.id)) {
            // 驱动不在册/被禁:退避重排(它可能只是面板临时停用),不计死
            deps.ext.bumpOutboxAttempt(job.jobId, backoffAt(c, job.attempts), 'driver unavailable/disabled');
            stats.failed++;
            return;
        }
        if (!c.allowHardDelete && driver.capabilities.deletionMode === 'hard') {
            // Phase 2 硬闸:挂 pending 远期重排(不算失败);60s 一步既防热转,配置翻脸后一分钟内恢复流动
            deps.ext.setOutboxStatus(job.jobId, 'pending', { nextAttemptAt: nowMs() + 60_000, error: 'Phase 2 仅派发 soft-delete 驱动(allowHardDelete=false)' });
            stats.gated++;
            return;
        }
        const space = deps.spacesOf(job.driverId).find((s) => s.spaceId === job.spaceId) ?? deps.spacesOf(job.driverId)[0];
        if (space === undefined) {
            deps.ext.setOutboxStatus(job.jobId, 'dead', { error: 'space 未配置' });
            stats.dead++;
            return;
        }
        if (job.status === 'awaiting_settle') {
            const shadow = deps.ext.getShadowByRecord(job.driverId, job.spaceId, job.recordId);
            if (shadow === undefined) {
                deps.ext.setOutboxStatus(job.jobId, 'done');
                stats.done++;
                return;
            }
            const outcome = await settleShadow(driver, space, shadow, { ext: deps.ext, scanLimit: c.settleScanLimit, now: nowMs(), logger: deps.logger });
            if (outcome === 'linked') {
                deps.ext.setOutboxStatus(job.jobId, 'done');
                stats.settled++;
            }
            else if (outcome === 'orphan') {
                deps.ext.setOutboxStatus(job.jobId, 'dead', { error: 'settle 超时未回捞到 externalId(orphan 挂账)' });
                stats.orphans++;
            }
            else {
                deps.ext.setOutboxStatus(job.jobId, 'awaiting_settle', { nextAttemptAt: nowMs() + (c.backoffMs[0] ?? 1000) });
            }
            return;
        }
        try {
            if (job.intent === 'forget') {
                await processForget(driver, space, job, stats);
            }
            else {
                await processAdd(driver, space, job, stats);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const attempts = job.attempts + 1;
            if (attempts >= c.maxAttempts) {
                deps.ext.setOutboxStatus(job.jobId, 'dead', { error: msg });
                stats.dead++;
            }
            else {
                deps.ext.bumpOutboxAttempt(job.jobId, backoffAt(c, attempts), msg);
                stats.failed++;
            }
        }
    };
    const processAdd = async (driver, space, job, stats) => {
        const c = deps.cfg();
        const rec = deps.l1.getByIds([job.recordId])[0];
        if (rec === undefined || isRetired(rec)) {
            // 记录已不在库/已退场(退场由 forget 任务传导):本轮 done noop
            deps.ext.setOutboxStatus(job.jobId, 'done');
            stats.skipped++;
            return;
        }
        const digest = recordDigest(rec);
        const shadow = deps.ext.getShadowByRecord(driver.id, space.spaceId, rec.id);
        if (shadow !== undefined && shadow.externalId !== '' && shadow.dbDigest === digest) {
            deps.ext.setOutboxStatus(job.jobId, 'done');
            stats.skipped++; // 写放大闸:内容没变不重推
            return;
        }
        // 脱敏硬闸(T0.11 接线位):content + metadata 字符串叶子全过,入参不改写
        const gate = pushRedactRecord({ content: rec.content, metadata: rec.metadata });
        if ('redactError' in gate) {
            deps.ext.bumpOutboxAttempt(job.jobId, backoffAt(c, job.attempts + 1), `脱敏闸门异常,拒推: ${gate.redactError}`);
            stats.failed++;
            return;
        }
        const receipt = await driver.remember(space, {
            content: gate.content,
            category: rec.type,
            localRecordId: rec.id,
        }, AbortSignal.timeout(c.timeBudgetMs > 60_000 ? 60_000 : c.timeBudgetMs));
        const contentNorm = normContentKey(gate.content);
        const baseShadow = {
            shadowId: shadowIdFor(driver.id, space.spaceId, rec.id),
            driverId: driver.id,
            spaceId: space.spaceId,
            recordId: rec.id,
            extKey: rec.extKey ?? '',
            aliasOf: shadow?.aliasOf ?? '',
            extUri: shadow?.extUri ?? '',
            dbDigest: digest,
            extDigest: shadow?.extDigest ?? '',
            contentNorm,
        };
        if ((receipt.completion === 'committed' || receipt.completion === 'skipped') && receipt.externalId !== undefined) {
            deps.ext.upsertShadow({ ...baseShadow, externalId: receipt.externalId, syncState: 'clean', lastSyncedAt: nowMs() });
            deps.ext.setOutboxStatus(job.jobId, 'done');
            stats.done++;
            return;
        }
        if (receipt.completion === 'skipped') {
            // 远端明确拒收(无 externalId 的 skipped,如 openviking commit 未归档):
            // 不是失败,不建影子;记原因后 done——重试一百次也是同一种拒。
            deps.ext.setOutboxStatus(job.jobId, 'done', { error: receipt.error ?? '远端 skipped(未归档)' });
            stats.skipped++;
            return;
        }
        if (receipt.pendingOp !== undefined || receipt.completion === 'accepted') {
            // async-extracting:任务转 awaiting_settle,shadow 记 pendingOp 与回捞死线
            deps.ext.upsertShadow({
                ...baseShadow,
                externalId: receipt.externalId ?? '',
                syncState: 'awaiting_settle',
                pendingOp: receipt.pendingOp ?? '',
                settleDeadline: nowMs() + c.settleTimeoutMs,
            });
            // 回捞重排用退避首档(短而可配):写死秒级常量会让测试与真实时序都被拖进魔法等待
            deps.ext.setOutboxStatus(job.jobId, 'awaiting_settle', { nextAttemptAt: nowMs() + (c.backoffMs[0] ?? 1000) });
            stats.done++;
            return;
        }
        throw new Error(`remember 回执不可用: ${receipt.completion}${receipt.error === undefined ? '' : ` (${receipt.error})`}`);
    };
    const processForget = async (driver, space, job, stats) => {
        const shadow = deps.ext.getShadowByRecord(driver.id, space.spaceId, job.recordId);
        if (shadow === undefined) {
            deps.ext.setOutboxStatus(job.jobId, 'done');
            stats.skipped++;
            return;
        }
        if (shadow.externalId === '') {
            // 从未拿到 externalId(awaiting_settle 中途退场):远端无从删,清账了事
            deps.ext.deleteShadow(shadow.shadowId);
            deps.ext.setOutboxStatus(job.jobId, 'done', { error: '无 externalId,影子账清除(远端可能残留,Phase 3 orphan 面板可见)' });
            stats.skipped++;
            return;
        }
        const receipt = await driver.forget(space, shadow.externalId);
        if (receipt.completion === 'committed' || receipt.completion === 'skipped') {
            deps.ext.deleteShadow(shadow.shadowId);
            deps.ext.setOutboxStatus(job.jobId, 'done');
            stats.done++;
            return;
        }
        throw new Error(`forget 回执不可用: ${receipt.completion}${receipt.error === undefined ? '' : ` (${receipt.error})`}`);
    };
    return { hook, runBatch };
}
