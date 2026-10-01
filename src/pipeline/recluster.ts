/**
 * L2 场景重聚类消费器(治理 W3,T3.10/T3.11)。
 *
 * demote-to-wiki 会改变记忆对场景的归属度——受影响场景的摘要必须**由当前事实
 * 重算**(I-20:派生层是投影,不存在只属派生层的事实)。本消费器在 ruminate
 * 空闲档被调,每次最多处理一个作业:
 *
 * ① **先快照**(T3.11/I-14):受影响场景文件读进内存,失败可整体回滚;
 * ② **幂等重算**:删除受影响场景摘要文件([DELETED] 语义)——摘要是派生投影,
 *    删除即"由当前 L1 事实在下一次整合时重算",不是把"已重聚类"单向写进
 *    某个标记(单向标记正是 I-20 禁止的形态);
 * ③ **失败整体回滚**:内存快照原样写回,**不留"旧摘要已删新摘要未生成"的
 *    中间态**(P1-8);文件原本不存在的回滚 = 维持不存在。
 *
 * 预算纪律:每次 ruminate 至多 1 个作业;作业内只有文件级操作(无 LLM)——
 * 真正的重算由既有 L2 整合(relabel 预算模型)在下轮完成,成本有界。
 */
import type { MemoryFamily, MemoryLogger } from '../types.js';
import type { SceneStore } from '../store/scenes.js';

/** 待处理作业的取数口(L1Store.claimSceneRecluster 的形状)。 */
export interface ReclusterJobSource {
  claimSceneRecluster(): { jobId: string; family: string; sceneNames: string[] } | null;
  finishSceneRecluster(jobId: string, ok: boolean): void;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * 处理一批重聚类作业。**绝不抛**——重聚类是派生层维护,失败降级为作业保留
 * failed 状态供诊断,绝不拖垮 ruminate 主流程。
 * @returns 处理的作业数(0 = 队列空)。
 */
export async function processSceneReclusterJobs(
  source: ReclusterJobSource,
  scenes: Record<MemoryFamily, SceneStore>,
  logger?: MemoryLogger,
  maxJobs = 1,
): Promise<number> {
  let processed = 0;
  for (let i = 0; i < maxJobs; i++) {
    const job = source.claimSceneRecluster();
    if (!job) break;
    const family: MemoryFamily = job.family === 'work' ? 'work' : 'chat';
    const store = scenes[family];
    // 快照在 try 外声明:catch 的回滚要用它
    const snapshots: Array<{ name: string; content: string | null }> = [];
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
      logger?.info(
        `[memory] 场景重聚类:作业 ${job.jobId} 清除过期摘要 ${names.length}/${job.sceneNames.length} 个(${family}),将由下一轮 L2 整合按当前事实重算`,
      );
    } catch (err) {
      // ③ 失败整体回滚:内存快照原样写回;原本不存在的内容写 [DELETED](删除语义)
      logger?.warn(`[memory] 场景重聚类失败(作业 ${job.jobId}),整体回滚: ${err instanceof Error ? err.message : String(err)}`);
      for (const snap of snapshots) {
        try {
          await store.write(snap.name, snap.content ?? '[DELETED]');
        } catch (rollbackErr) {
          logger?.error(`[memory] 重聚类回滚失败 scene=${snap.name}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
        }
      }
      source.finishSceneRecluster(job.jobId, false);
    }
  }
  return processed;
}
