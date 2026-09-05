/**
 * 文件日志:dsh 宿主只把插件日志打到控制台(无持久化),这里镜像 warn/error/info
 * 到数据目录 memory.log,供事后诊断蒸馏管线。
 *
 * 重写版把落盘改为异步缓冲:捕获/召回是每轮对话的热路径,逐条同步 append 在
 * Windows+杀软环境可达毫秒级。行先进内存缓冲,定时/定量批量 appendFile(队列
 * 串行保序);轮转与 Windows EBUSY 截断兜底语义保留。写入失败静默忽略——
 * 诊断日志绝不能反过来拖垮管线。
 */
import { appendFileSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** 轮转 rename 连续失败多少次后放弃归档、直接截断重开(Windows 文件占用兜底)。 */
const ROTATE_FAIL_LIMIT = 5;
/** 缓冲行数达到该值立即刷盘(未到定时器也不积压);同时是体积检查的抽样粒度。 */
export const SIZE_CHECK_INTERVAL = 32;
/** 定时刷盘间隔(ms);unref,不阻止进程退出。 */
const FLUSH_INTERVAL_MS = 500;
/** 错误对象转带堆栈的单行描述(诊断日志用,非 Error 直接字符串化)。 */
export function errDetail(err) {
    if (err instanceof Error)
        return `${err.message} @ ${err.stack?.split('\n')[1]?.trim() ?? err.name}`;
    return String(err);
}
export function withFileLog(dataDir, logger) {
    const logPath = join(dataDir, 'memory.log');
    let buffer = [];
    let rotateFailures = 0;
    let writesSinceCheck = 0;
    let flushing = Promise.resolve();
    const line = (level, msg) => `${new Date().toISOString()} [${level}] ${msg}\n`;
    const rotateIfNeeded = () => {
        if (writesSinceCheck++ % SIZE_CHECK_INTERVAL !== 0 || !existsSync(logPath) || statSync(logPath).size <= MAX_LOG_BYTES) {
            return;
        }
        try {
            renameSync(logPath, `${logPath}.1`);
            rotateFailures = 0;
        }
        catch {
            // rename 可能因文件被占用失败(Windows EBUSY):连续失败达上限后截断重开,
            // 保住"日志体积有上界"的底线(放弃 .1 归档,保当前日志可用)
            if (++rotateFailures >= ROTATE_FAIL_LIMIT) {
                writeFileSync(logPath, '');
                rotateFailures = 0;
            }
        }
    };
    const drain = (lines) => {
        flushing = flushing
            .then(async () => {
            if (lines.length === 0)
                return;
            rotateIfNeeded();
            await appendFile(logPath, lines.join(''), 'utf-8');
        })
            .catch(() => {
            /* ignore */
        });
    };
    const flushNow = () => {
        if (buffer.length === 0)
            return;
        const batch = buffer;
        buffer = [];
        drain(batch);
    };
    const timer = setInterval(flushNow, FLUSH_INTERVAL_MS);
    timer.unref?.();
    process.once('beforeExit', () => {
        if (buffer.length > 0) {
            const batch = buffer;
            buffer = [];
            try {
                appendFileSync(logPath, batch.join(''), 'utf-8');
            }
            catch {
                /* ignore */
            }
        }
    });
    const write = (level, msg) => {
        try {
            buffer.push(line(level, msg));
            if (buffer.length >= SIZE_CHECK_INTERVAL)
                flushNow();
        }
        catch {
            /* ignore */
        }
    };
    return {
        debug: (m) => logger.debug?.(m),
        info: (m) => {
            logger.info(m);
            write('info', m);
        },
        warn: (m) => {
            logger.warn(m);
            write('warn', m);
        },
        error: (m) => {
            logger.error(m);
            write('error', m);
        },
    };
}
