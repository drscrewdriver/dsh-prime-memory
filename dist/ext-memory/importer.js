const IDLE = 'idle';
/**
 * “整驱动导入”（面板不选空间）时断点记在哪个 space 名下。
 *
 * 用哨兵 `*` 而不是省略：第一版对 `spaceId === ''` 直接跳过所有读写，于是面板上
 * “可中断、断点保留”在默认路径上**根本不成立**（真机验收时 `ext_import` 空表才暴露）。
 * 哨兵值与真实 spaceId 不会撞：spaceId 来自驱动 `id:externalId`，不可能等于 `*`。
 */
const ALL_SPACES = '*';
export function makeExtImporter(deps) {
    let progress = null;
    const assertNotRunning = () => {
        if (progress !== null && progress.running)
            throw new Error('已有导入任务在跑，请等它结束或先取消');
    };
    return {
        start(input) {
            assertNotRunning();
            const guard = deps.cfg();
            const maxItems = Math.max(1, Math.min(50_000, Math.floor(input.maxItems ?? guard.maxItems)));
            const driverId = input.driverId.trim();
            if (driverId === '')
                throw new Error('driverId 为空');
            const spaceId = input.spaceId !== undefined && input.spaceId !== '' ? input.spaceId : '';
            // 断点键：选了空间就用它，否则用哨兵——不能因为“没选空间”就不记断点。
            const bpKey = spaceId === '' ? ALL_SPACES : spaceId;
            // restart = 先清断点，从 0 重来（否则只能改库才能清）。
            if (input.restart === true)
                deps.ext.clearImport(driverId, bpKey);
            // 断点从表里读回：上一轮崩在中间时，本轮从 offset 续，不重复嵌入已完成条目。
            const bp = input.restart === true ? null : deps.ext.getImport(driverId, bpKey);
            const startedAt = Date.now();
            const l1TotalBefore = deps.l1Total();
            progress = {
                running: true, driverId, spaceId, startedAt, cancelRequested: false,
                offset: bp?.offset ?? 0, imported: bp?.imported ?? 0, skipped: bp?.skipped ?? 0,
                last: progress?.last,
            };
            deps.logger?.info(`[memory] 外源导入开始：driver=${driverId} space=${spaceId || '(全部)'} 上限=${maxItems} 断点=${progress.offset}`);
            // 不 await：受理响应与进度必须是一套语义（照 embedding-reindex 的先例）。
            void (async () => {
                const p = progress;
                try {
                    const summary = await deps.puller.importSpace({
                        driverId,
                        ...(spaceId === '' ? {} : { spaceId }),
                        maxItems,
                        timeBudgetMs: guard.timeBudgetMs,
                        ...(bp?.offset !== undefined && bp.offset > 0 ? { startOffset: bp.offset } : {}),
                        // 每页提交后落断点并刷进度；返回 true 表示用户请求中止。
                        onPage: ({ offset, imported, skipped, hasMore }) => {
                            p.offset = offset;
                            p.imported = imported;
                            p.skipped = skipped;
                            deps.ext.upsertImport({
                                driverId, spaceId: bpKey, offset, imported, skipped,
                                state: p.cancelRequested ? 'cancelling' : 'running',
                            });
                            if (p.cancelRequested)
                                return true;
                            // 单页给满且已达上限时不再续跑：让 importSpace 自己的 capped 判据说话。
                            return !hasMore && offset >= maxItems;
                        },
                    });
                    const finishedAt = Date.now();
                    const last = {
                        finishedAt,
                        durationMs: finishedAt - startedAt,
                        pulled: summary.pulled,
                        imported: summary.imported,
                        skipped: summary.skipped,
                        conflicts: summary.conflicts,
                        failed: summary.failed,
                        offset: summary.offset,
                        truncation: summary.truncation,
                        l1TotalBefore,
                        l1TotalAfter: deps.l1Total(),
                    };
                    p.last = last;
                    p.running = false;
                    p.offset = summary.offset;
                    p.imported = summary.imported;
                    p.skipped = summary.skipped;
                    // 翻到底才算完成，清断点；capped/budget/cancelled 都保留断点供续跑。
                    if (summary.truncation === 'complete')
                        deps.ext.clearImport(driverId, bpKey);
                    else
                        deps.ext.upsertImport({ driverId, spaceId: bpKey, offset: summary.offset, imported: summary.imported, skipped: summary.skipped, state: summary.truncation });
                    deps.logger?.info(`[memory] 外源导入收尾：driver=${driverId} 新增=${last.imported} 跳过=${last.skipped} `
                        + `冲突=${last.conflicts} 失败=${last.failed} 收尾=${last.truncation} 耗时=${last.durationMs}ms`);
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    p.running = false;
                    p.error = message;
                    deps.ext.upsertImport({ driverId, spaceId: bpKey, offset: p.offset, imported: p.imported, skipped: p.skipped, state: 'error' });
                    deps.logger?.warn(`[memory] 外源导入失败(driver=${driverId}): ${message}`);
                }
            })();
            return { accepted: true, startedAt };
        },
        status() {
            return progress === null ? null : { ...progress };
        },
        cancel() {
            if (progress === null || !progress.running)
                return { cancelled: false };
            progress.cancelRequested = true;
            // 断点留在表里（state=cancelling），下一次 start 从那儿续。
            deps.ext.upsertImport({
                driverId: progress.driverId,
                spaceId: progress.spaceId === '' ? ALL_SPACES : progress.spaceId,
                offset: progress.offset,
                imported: progress.imported, skipped: progress.skipped, state: 'cancelling',
            });
            return { cancelled: true };
        },
        resetBreakpoint(input) {
            assertNotRunning();
            const driverId = input.driverId.trim();
            const spaceId = input.spaceId !== undefined && input.spaceId !== '' ? input.spaceId : '';
            if (driverId === '')
                throw new Error('driverId 为空');
            // 不选空间 = 断点在哨兵名下；「重新开始」必须把它一起清掉，
            // 否则用户点了重来、下一轮仍从上次 offset 续跑（看起来像“重置没生效”）。
            const keys = spaceId === '' ? [ALL_SPACES] : [spaceId];
            if (progress !== null && progress.driverId === driverId) {
                const cur = progress.spaceId === '' ? ALL_SPACES : progress.spaceId;
                if (!keys.includes(cur))
                    keys.push(cur);
            }
            for (const k of keys)
                deps.ext.clearImport(driverId, k);
            if (progress !== null && progress.driverId === driverId)
                progress = { ...progress, offset: 0, imported: 0, skipped: 0 };
            deps.logger?.info(`[memory] 外源导入断点已重置：driver=${driverId} space=${keys.join(',') || IDLE}`);
            return { cleared: true };
        },
    };
}
