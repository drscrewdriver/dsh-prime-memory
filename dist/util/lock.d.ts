import type { MemoryLogger } from '../types.js';
export interface LockInfo {
    pid: number;
    hostname: string;
    startedAt: string;
    purpose: string;
}
export interface FileLockOptions {
    logger?: MemoryLogger;
    /** 等待上限(ms);超时抛错。默认 2000。 */
    timeoutMs?: number;
    /** 陈旧阈值(ms):锁文件 mtime 超过它才考虑回收。默认 30000。 */
    staleMs?: number;
    /** 首次退避(ms),指数增长并封顶。默认 10/100。 */
    backoffMs?: number;
    /** 锁文件里记的用途(诊断用)。 */
    purpose?: string;
}
export interface FileLockResult<T> {
    value: T;
    /** 实际等待锁的毫秒数(0 = 一次拿到)。 */
    waitMs: number;
    /** 本次是否回收了别人的陈旧锁。 */
    staleReclaimed: boolean;
}
/** 等待上限到点:调用方必须显式处理(要么重试要么停止),不允许"没锁也写"。 */
export declare class FileLockTimeoutError extends Error {
    readonly target: string;
    readonly waitMs: number;
    constructor(target: string, waitMs: number);
}
/**
 * 在锁内执行 `fn`。
 *
 * **持锁范围纪律**:只包 read-modify-write 临界区——锁内不得有 LLM 调用、
 * 网络请求或 `npm ci` 之类长任务(spec §3 L2),否则一个慢任务会拖住另一个文件
 * (同进程内还会拖住本批次的其它调用)。
 */
export declare function withFileLock<T>(target: string, fn: () => Promise<T>, opts?: FileLockOptions): Promise<FileLockResult<T>>;
