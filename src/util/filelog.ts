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
import type { MemoryLogger } from '../types.js';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** 轮转 rename 连续失败多少次后放弃归档、直接截断重开(Windows 文件占用兜底)。 */
const ROTATE_FAIL_LIMIT = 5;
/** 缓冲行数达到该值立即刷盘(未到定时器也不积压);同时是体积检查的抽样粒度。 */
export const SIZE_CHECK_INTERVAL = 32;
/** 定时刷盘间隔(ms);unref,不阻止进程退出。 */
const FLUSH_INTERVAL_MS = 500;

/** 错误对象转带堆栈的单行描述(诊断日志用,非 Error 直接字符串化)。 */
export function errDetail(err: unknown): string {
  if (err instanceof Error) return `${err.message} @ ${err.stack?.split('\n')[1]?.trim() ?? err.name}`;
  return String(err);
}

/** 文件日志句柄:在 MemoryLogger 之上多一个 close(),供 apply 用 ctx.effect 登记释放(issue #51)。 */
export type FileLogHandle = MemoryLogger & { close: () => void };

export function withFileLog(dataDir: string, logger: MemoryLogger): FileLogHandle {
  const logPath = join(dataDir, 'memory.log');
  let buffer: string[] = [];
  let rotateFailures = 0;
  let writesSinceCheck = 0;
  let flushing: Promise<void> = Promise.resolve();

  const line = (level: string, msg: string): string => `${new Date().toISOString()} [${level}] ${msg}\n`;

  const rotateIfNeeded = (): void => {
    if (writesSinceCheck++ % SIZE_CHECK_INTERVAL !== 0 || !existsSync(logPath) || statSync(logPath).size <= MAX_LOG_BYTES) {
      return;
    }
    try {
      renameSync(logPath, `${logPath}.1`);
      rotateFailures = 0;
    } catch {
      // rename 可能因文件被占用失败(Windows EBUSY):连续失败达上限后截断重开,
      // 保住"日志体积有上界"的底线(放弃 .1 归档,保当前日志可用)
      if (++rotateFailures >= ROTATE_FAIL_LIMIT) {
        writeFileSync(logPath, '');
        rotateFailures = 0;
      }
    }
  };

  const drain = (lines: string[]): void => {
    flushing = flushing
      .then(async () => {
        if (lines.length === 0) return;
        rotateIfNeeded();
        await appendFile(logPath, lines.join(''), 'utf-8');
      })
      .catch(() => {
        /* ignore */
      });
  };

  const flushNow = (): void => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    drain(batch);
  };

  const timer = setInterval(flushNow, FLUSH_INTERVAL_MS);
  timer.unref?.();
  // 退出前兜底同步刷盘。必须命名:close() 要用同一个函数引用解绑,
  // 匿名监听器摘不掉(issue #51:apply 重跑一次就多一份)。
  const onBeforeExit = (): void => {
    if (buffer.length > 0) {
      const batch = buffer;
      buffer = [];
      try {
        appendFileSync(logPath, batch.join(''), 'utf-8');
      } catch {
        /* ignore */
      }
    }
  };
  process.once('beforeExit', onBeforeExit);

  const write = (level: string, msg: string): void => {
    try {
      buffer.push(line(level, msg));
      if (buffer.length >= SIZE_CHECK_INTERVAL) flushNow();
    } catch {
      /* ignore */
    }
  };

  return {
    /**
     * 释放本实例持有的全局资源:Cordis 卸载/重跑 apply 时调用,幂等。
     * 收尾再 flushNow 一次,让卸载前缓冲的几行仍落进 memory.log。
     */
    close: () => {
      clearInterval(timer);
      process.off('beforeExit', onBeforeExit);
      flushNow();
    },
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
