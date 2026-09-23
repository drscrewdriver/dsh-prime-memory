/**
 * 存量未打标记录的一键回填(task_15):从 WingWheel"未打标 M"入口触发,
 * 对 metadata 无 wing 的 L1 记录按 8 角词表批量补打标签(复用 L1 抽取的打标路径:
 * 同一候选词表与措辞,经既有蒸馏 LLM 路由)。
 *
 * 安全边界:
 * - **单飞**:同时最多一个回填任务,重复触发直接返回 running(不排队不叠加);
 * - **后台执行**:端点立即返回,逐块推进(每块 20 条),不阻塞 RPC/管线;
 * - **失败可退**:LLM 失败/输出不合法只跳过当前块,原记录零改动(标签只写成功的);
 * - **有界**:单次任务最多处理 MAX_RECORDS 条,防止一次跑飞;其余可再次触发。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type MemoryLogger } from './types.js';
import type { L1Store } from './store/l1.js';
import type { MemoryConfig } from './config.js';
export interface HallBackfillDeps {
    ctx: Context;
    cfg: MemoryConfig;
    l1: L1Store;
    logger: MemoryLogger;
}
export interface HallBackfillState {
    running: boolean;
    /** 本进程累计成功打标条数(重启归零;仅作观测,不作账)。 */
    updated: number;
    failed: number;
}
export declare function wingBackfillState(): HallBackfillState;
/** 启动后台回填;已在运行返回 false(单飞)。 */
export declare function startWingBackfill(deps: HallBackfillDeps): {
    started: boolean;
    running: boolean;
};
