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
    claimSceneRecluster(): {
        jobId: string;
        family: string;
        sceneNames: string[];
    } | null;
    finishSceneRecluster(jobId: string, ok: boolean): void;
}
/**
 * 处理一批重聚类作业。**绝不抛**——重聚类是派生层维护,失败降级为作业保留
 * failed 状态供诊断,绝不拖垮 ruminate 主流程。
 * @returns 处理的作业数(0 = 队列空)。
 */
export declare function processSceneReclusterJobs(source: ReclusterJobSource, scenes: Record<MemoryFamily, SceneStore>, logger?: MemoryLogger, maxJobs?: number): Promise<number>;
