function baseName(p) {
    return p.split(/[\\/]/).pop() ?? p;
}
/**
 * 处理一批重聚类作业。**绝不抛**——重聚类是派生层维护,失败降级为作业保留
 * failed 状态供诊断,绝不拖垮 ruminate 主流程。
 * @returns 处理的作业数(0 = 队列空)。
 */
export async function processSceneReclusterJobs(source, scenes, logger, maxJobs = 1) {
    let processed = 0;
    for (let i = 0; i < maxJobs; i++) {
        const job = source.claimSceneRecluster();
        if (!job)
            break;
        const family = job.family === 'work' ? 'work' : 'chat';
        const store = scenes[family];
        // 快照在 try 外声明:catch 的回滚要用它
        let snapshots = [];
        try {
            // ① 内存快照:按场景名(文件 basename)匹配当前存在的摘要文件
            const all = await store.list();
            const wanted = new Set(job.sceneNames);
            const names = all.map((s) => baseName(s.path)).filter((n) => wanted.has(n));
            for (const n of names) {
                // 快照必须走 store 同源路径(相对 path 依赖 cwd 会读到 null → 回滚误删)
                snapshots.push({ name: n, content: await store.readRaw(n) });
            }
            // ② 幂等重算:删派生摘要,交给下一次 L2 整合由当前事实重建
            for (const n of names) {
                await store.write(n, '[DELETED]');
            }
            source.finishSceneRecluster(job.jobId, true);
            processed++;
            logger?.info(`[memory] 场景重聚类:作业 ${job.jobId} 清除过期摘要 ${names.length}/${job.sceneNames.length} 个(${family}),将由下一轮 L2 整合按当前事实重算`);
        }
        catch (err) {
            // ③ 失败整体回滚:内存快照原样写回;原本不存在的内容写 [DELETED](删除语义)
            logger?.warn(`[memory] 场景重聚类失败(作业 ${job.jobId}),整体回滚: ${err instanceof Error ? err.message : String(err)}`);
            for (const snap of snapshots) {
                try {
                    await store.write(snap.name, snap.content ?? '[DELETED]');
                }
                catch (rollbackErr) {
                    logger?.error(`[memory] 重聚类回滚失败 scene=${snap.name}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
                }
            }
            source.finishSceneRecluster(job.jobId, false);
        }
    }
    return processed;
}
