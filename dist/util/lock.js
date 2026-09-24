/**
 * 同机多进程文件互斥(`<target>.lock` 独占创建)。
 *
 * 为什么自己写:只需要"同机、按文件、有界等待、能回收陈旧锁"这四件事,
 * 第三方锁库带来的依赖与守护进程语义都用不上(spec §4 非目标:不引第三方库)。
 *
 * 形态(spec §3 L2 冻结):
 * - `open(path,'wx')` 独占创建——原子性由 OS 保证,不需要额外的 exists+create 竞态处理;
 * - 锁内容 `{ pid, hostname, startedAt, purpose }`,用于诊断与陈旧回收判定;
 * - **按文件**加锁(不做全局锁):`session-modes` 的写不该阻塞 `slots`;
 * - 有界等待 + 退避,超时**显式抛错**——绝不静默跳过写入(团队准则);
 * - 陈旧回收需要**两个条件同时成立**:mtime 超阈值 **且** 持有者 pid 已不存活。
 *   只看 mtime 会把"跑得久但活着"的持有者误杀;只看 pid 会被 pid 复用骗。
 */
import { hostname } from 'node:os';
import { promises as fs } from 'node:fs';
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_BACKOFF_MS = 10;
const MAX_BACKOFF_MS = 100;
/** 等待上限到点:调用方必须显式处理(要么重试要么停止),不允许"没锁也写"。 */
export class FileLockTimeoutError extends Error {
    target;
    waitMs;
    constructor(target, waitMs) {
        super(`获取文件锁超时(${waitMs}ms): ${target}.lock —— 未写入,避免覆盖`);
        this.target = target;
        this.waitMs = waitMs;
        this.name = 'FileLockTimeoutError';
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** pid 是否存活。信号 0 只做存在性探测,不真的发信号。 */
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function readLockInfo(lockPath) {
    try {
        const [raw, st] = await Promise.all([fs.readFile(lockPath, 'utf-8'), fs.stat(lockPath)]);
        try {
            return { info: JSON.parse(raw), mtimeMs: st.mtimeMs };
        }
        catch {
            return { mtimeMs: st.mtimeMs }; // 锁内容坏了:按"只能等超时"处理,不擅删
        }
    }
    catch {
        return { mtimeMs: 0 };
    }
}
const queues = new Map();
const pumping = new Set();
/**
 * 在锁内执行 `fn`。
 *
 * **持锁范围纪律**:只包 read-modify-write 临界区——锁内不得有 LLM 调用、
 * 网络请求或 `npm ci` 之类长任务(spec §3 L2),否则一个慢任务会拖住另一个文件
 * (同进程内还会拖住本批次的其它调用)。
 */
export function withFileLock(target, fn, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        const q = queues.get(target) ?? [];
        const item = {
            fn: fn,
            resolve: resolve,
            reject,
            enqueueAt: Date.now(),
            timeoutMs,
        };
        // 每个等待者**独立计时**:队首若卡住(违反持锁纪律),后续调用各自到点失败,
        // 而不是跟着无限等——那会把一个局部故障放大成整条链路挂起。
        item.timer = setTimeout(() => {
            const q2 = queues.get(target);
            const idx = q2 ? q2.indexOf(item) : -1;
            if (idx >= 0 && q2) {
                q2.splice(idx, 1);
                const waited = Date.now() - item.enqueueAt;
                opts.logger?.warn?.(`[memory] 文件锁超时(同进程前一持有者未释放): ${target}.lock wait_ms=${waited} timeout=${item.timeoutMs}`);
                item.reject(new FileLockTimeoutError(target, waited));
            }
        }, timeoutMs);
        q.push(item);
        queues.set(target, q);
        void pump(target, opts);
    });
}
async function pump(target, opts) {
    if (pumping.has(target))
        return; // 已有泵在跑:它会在循环里消费新入队的项
    const q = queues.get(target);
    if (!q || q.length === 0)
        return;
    pumping.add(target);
    let staleReclaimed = false;
    try {
        const acquired = await acquireLockFile(target, opts);
        staleReclaimed = acquired.staleReclaimed;
        try {
            for (;;) {
                const q2 = queues.get(target);
                if (!q2 || q2.length === 0)
                    break;
                const item = q2.shift();
                if (item.timer !== undefined)
                    clearTimeout(item.timer);
                const waited = Date.now() - item.enqueueAt;
                try {
                    item.resolve({ value: await item.fn(), waitMs: waited, staleReclaimed });
                }
                catch (err) {
                    item.reject(err);
                }
            }
        }
        finally {
            await releaseLockFile(target, opts);
        }
    }
    catch (err) {
        // 拿不到锁(超时/IO 错误):队列里所有等待者一起失败,绝不"没锁也写"
        const rest = queues.get(target) ?? [];
        queues.set(target, []);
        for (const item of rest) {
            if (item.timer !== undefined)
                clearTimeout(item.timer);
            item.reject(err);
        }
    }
    finally {
        pumping.delete(target);
    }
    // 收尾期间(尤其 release 的 unlink)入队的调用不能没人管:此刻 `pumping` 还是 true,
    // 它们的 `pump()` 会直接返回,于是只能干等到自己的超时。收尾后再看一眼队列。
    if ((queues.get(target)?.length ?? 0) > 0)
        void pump(target, opts);
}
/** 独占创建锁文件(成功 = 拿到锁)。失败原因:EEXIST(别人持有)或 IO 错误。 */
async function createLockFile(lockPath, purpose) {
    const info = {
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
        purpose: purpose ?? 'rmw',
    };
    const fh = await fs.open(lockPath, 'wx');
    try {
        await fh.writeFile(JSON.stringify(info, null, 2), 'utf-8');
    }
    finally {
        await fh.close();
    }
}
/**
 * 获取磁盘锁(有界等待 + 退避 + 陈旧回收)。
 * @throws {FileLockTimeoutError} 超时
 */
async function acquireLockFile(target, opts) {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    let backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    const lockPath = `${target}.lock`;
    let staleReclaimed = false;
    let lastWaitDiagnosed = false;
    for (;;) {
        const waited = Date.now() - started;
        try {
            await createLockFile(lockPath, opts.purpose);
            if (waited > 0) {
                opts.logger?.debug?.(`[memory] 文件锁等待后获取: ${lockPath} wait_ms=${waited}`);
            }
            return { staleReclaimed, waitMs: waited };
        }
        catch (err) {
            const code = err?.code;
            if (code !== 'EEXIST')
                throw err; // 目录不可写等:直接抛出,不假装拿到锁
            // 陈旧回收:mtime 超阈 **且** 持有者已不在
            const { info: holder, mtimeMs } = await readLockInfo(lockPath);
            if (holder && mtimeMs > 0 && Date.now() - mtimeMs > staleMs && !pidAlive(holder.pid)) {
                await fs.unlink(lockPath).catch(() => { });
                staleReclaimed = true;
                opts.logger?.warn?.(`[memory] 回收陈旧文件锁: ${lockPath} (持有者 pid=${holder.pid} 已退出,锁龄 ${Date.now() - mtimeMs}ms, purpose=${holder.purpose ?? '?'})`);
                continue; // 立刻重试,不消耗等待预算
            }
            const now = Date.now();
            if (now - started >= timeoutMs) {
                opts.logger?.warn?.(`[memory] 文件锁超时: ${lockPath} wait_ms=${now - started} timeout=${timeoutMs}` +
                    `${holder ? ` holder_pid=${holder.pid} purpose=${holder.purpose ?? '?'}` : ''}`);
                throw new FileLockTimeoutError(target, now - started);
            }
            // 等待诊断只记一次(等待期每轮都记会刷屏)
            if (!lastWaitDiagnosed) {
                lastWaitDiagnosed = true;
                opts.logger?.debug?.(`[memory] 文件锁等待中: ${lockPath} holder_pid=${holder?.pid ?? '?'}`);
            }
            await sleep(backoff);
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
    }
}
/** 释放磁盘锁。删除失败要留诊断(残留由陈旧回收兜底,但那是 30s 后的事)。 */
async function releaseLockFile(target, opts) {
    const lockPath = `${target}.lock`;
    await fs.unlink(lockPath).catch((err) => {
        opts.logger?.warn?.(`[memory] 锁文件释放失败(将由陈旧回收兜底): ${lockPath} — ${err instanceof Error ? err.message : String(err)}`);
    });
}
