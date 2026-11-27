import type { MemoryLogger } from '../types.js';
/** 缓冲行数达到该值立即刷盘(未到定时器也不积压);同时是体积检查的抽样粒度。 */
export declare const SIZE_CHECK_INTERVAL = 32;
/** 错误对象转带堆栈的单行描述(诊断日志用,非 Error 直接字符串化)。 */
export declare function errDetail(err: unknown): string;
/** 文件日志句柄:在 MemoryLogger 之上多一个 close(),供 apply 用 ctx.effect 登记释放(issue #51)。 */
export type FileLogHandle = MemoryLogger & {
    close: () => void;
};
export declare function withFileLog(dataDir: string, logger: MemoryLogger): FileLogHandle;
