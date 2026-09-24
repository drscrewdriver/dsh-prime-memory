/**
 * T4.1~T4.5 文件锁:独占创建、锁内容、有界等待超时、陈旧回收、诊断可区分。
 *
 * 跑法(本机删除极慢,超时必须放宽):
 *   vitest run tests/file-layer-lock.test.ts --testTimeout=60000 --hookTimeout=600000
 */
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLockTimeoutError, withFileLock, type LockInfo } from '../src/util/lock.js';
import { flTmp } from './file-layer-tmp.js';

const logs = () => {
  const warn: string[] = [];
  const debug: string[] = [];
  return {
    warn,
    debug,
    logger: {
      debug: (m: string) => debug.push(m),
      info() {},
      warn: (m: string) => warn.push(m),
      error() {},
    },
  };
};

/** 造一个"别人的锁":pid 可指定,mtime 可回拨。 */
async function forgeLock(file: string, pid: number, ageMs: number): Promise<void> {
  const info: LockInfo = { pid, hostname: 'other-host', startedAt: new Date(Date.now() - ageMs).toISOString(), purpose: 'forged' };
  await writeFile(`${file}.lock`, JSON.stringify(info, null, 2), 'utf8');
  const back = new Date(Date.now() - ageMs);
  await utimes(`${file}.lock`, back, back);
}

/**
 * 等锁文件真正被释放。
 *
 * ⚠️ 本机 `unlink` 异常慢(1.6~5.4s,见 findings §11):`withFileLock` 在值返回后才异步
 * `unlink` 锁文件。若紧接着 `forgeLock` 覆盖同一路径或立刻 `stat` 判存在,会与未完成的
 * `unlink` 竞态——前者会被慢 unlink 删掉、后者会误判"锁没释放"。这里轮询到锁文件消失,
 * 让释放真正落盘后再继续,避免把环境 IO 慢误判成产品缺陷。(产品语义不变:调用方不被 unlink 阻塞)
 */
async function waitLockGone(lockPath: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(lockPath);
    } catch {
      return; // 已释放
    }
    if (Date.now() >= deadline) throw new Error(`锁文件未在 ${timeoutMs}ms 内释放: ${lockPath}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('T4.1 / T4.2 独占创建与锁内容', () => {
  it('锁内执行;锁文件内容含 pid/hostname/startedAt/purpose', async () => {
    const d = await flTmp('lock-basic');
    const f = join(d, 'slots.json');
    const r = await withFileLock(f, async () => {
      const raw = await readFile(`${f}.lock`, 'utf8');
      const info = JSON.parse(raw) as LockInfo;
      expect(info.pid).toBe(process.pid);
      expect(typeof info.hostname).toBe('string');
      expect(typeof info.startedAt).toBe('string');
      return 'done';
    }, { purpose: 'rmw' });
    expect(r.value).toBe('done');
    expect(r.waitMs).toBeGreaterThanOrEqual(0);
    expect(r.staleReclaimed).toBe(false);
    await waitLockGone(`${f}.lock`); // 本机 unlink 慢:等释放真正落盘
    // 正常释放后锁文件不留
    await expect(stat(`${f}.lock`)).rejects.toThrow();
  });

  it('第二个获取者等待(不是直接写):持锁期间拿不到,释放后能拿到', async () => {
    const d = await flTmp('lock-wait');
    const f = join(d, 'slots.json');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inside = false;

    const first = withFileLock(f, async () => {
      inside = true;
      await gate;
      return 'first';
    });
    // 等第一把锁真正进到临界区
    while (!inside) await new Promise((r) => setTimeout(r, 5));

    const log = logs();
    const second = withFileLock(f, async () => 'second', { timeoutMs: 200, logger: log.logger, purpose: 'waiter' });
    await expect(second).rejects.toBeInstanceOf(FileLockTimeoutError); // 等待而非并发写入
    expect(log.warn.some((m) => m.includes('文件锁超时') && m.includes('timeout=200'))).toBe(true);

    release();
    await expect(first).resolves.toEqual(expect.objectContaining({ value: 'first' }));
    await waitLockGone(`${f}.lock`); // 等 first 释放落盘,避免 third 在锁还在时被陈旧回收误判
    const third = await withFileLock(f, async () => 'third', { timeoutMs: 2000 });
    expect(third.value).toBe('third');
  });
});

describe('T4.3 有界等待 + 超时显式抛错', () => {
  it('持锁不放 → 等待方超时抛错(不静默跳过)', async () => {
    const d = await flTmp('lock-timeout');
    const f = join(d, 'state.json');
    await forgeLock(f, process.pid, 1_000); // 活 pid:不会触发陈旧回收
    const log = logs();
    await expect(withFileLock(f, async () => 'x', { timeoutMs: 300, logger: log.logger })).rejects.toThrow(
      FileLockTimeoutError,
    );
    expect(log.warn.some((m) => m.includes('文件锁超时'))).toBe(true);
  });

  it('fn 抛错时锁照常释放(不得留下死锁)', async () => {
    const d = await flTmp('lock-throw');
    const f = join(d, 'occupancy.json');
    await expect(
      withFileLock(f, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await waitLockGone(`${f}.lock`); // 本机 unlink 慢:等释放真正落盘
    await expect(stat(`${f}.lock`)).rejects.toThrow();
    // 后续仍可正常获取
    await expect(withFileLock(f, async () => 'ok')).resolves.toMatchObject({ value: 'ok' });
  });
});

describe('T4.4 陈旧回收(两条件都要)', () => {
  it('mtime 超阈 + 持有者 pid 已死 → 回收并记诊断', async () => {
    const d = await flTmp('lock-stale');
    const f = join(d, 'slots.json');
    await forgeLock(f, 999_999, 60_000); // 不存在的 pid + 60s 前
    const log = logs();
    const r = await withFileLock(f, async () => 'ok', { staleMs: 30_000, logger: log.logger });
    expect(r.value).toBe('ok');
    expect(r.staleReclaimed).toBe(true);
    expect(log.warn.some((m) => m.includes('回收陈旧文件锁') && m.includes('999999'))).toBe(true);
  });

  it('mtime 超阈但持有者 pid 仍活 → 不回收,超时', async () => {
    const d = await flTmp('lock-alive');
    const f = join(d, 'slots.json');
    await forgeLock(f, process.pid, 60_000); // 自己:pid 存活
    await expect(withFileLock(f, async () => 'x', { timeoutMs: 300, staleMs: 30_000 })).rejects.toThrow(
      FileLockTimeoutError,
    );
  });

  it('mtime 未超阈(锁很新)→ 不回收,超时', async () => {
    const d = await flTmp('lock-fresh');
    const f = join(d, 'slots.json');
    await forgeLock(f, 999_999, 1_000); // 死 pid 但才 1s
    await expect(withFileLock(f, async () => 'x', { timeoutMs: 300, staleMs: 30_000 })).rejects.toThrow(
      FileLockTimeoutError,
    );
  });
});

describe('T4.5 三种情形诊断可区分', () => {
  it('wait_ms / timeout / stale_reclaimed 各字段独立可见', async () => {
    const d = await flTmp('lock-diag');
    const f = join(d, 'session-modes.json');
    // 情形 1:一次拿到 → waitMs 小、staleReclaimed=false
    const r1 = await withFileLock(f, async () => 1);
    expect(r1.waitMs).toBeLessThan(1_000);
    expect(r1.staleReclaimed).toBe(false);
    await waitLockGone(`${f}.lock`); // 等 r1 释放落盘,避免慢 unlink 误删下面 forgeLock 造的锁
    // 情形 2:陈旧回收 → staleReclaimed=true + 专属 warn
    const log2 = logs();
    await forgeLock(f, 999_998, 60_000);
    const r2 = await withFileLock(f, async () => 2, { staleMs: 30_000, logger: log2.logger });
    expect(r2.staleReclaimed).toBe(true);
    expect(log2.warn.some((m) => m.includes('回收陈旧文件锁'))).toBe(true);
    await waitLockGone(`${f}.lock`); // 等 r2 释放落盘,避免误删下面 forgeLock 造的锁
    // 情形 3:超时 → FileLockTimeoutError 带 waitMs,且有 timeout= 诊断
    const log3 = logs();
    await forgeLock(f, process.pid, 1_000);
    const err = await withFileLock(f, async () => 3, { timeoutMs: 200, logger: log3.logger }).catch((e) => e);
    expect(err).toBeInstanceOf(FileLockTimeoutError);
    expect((err as FileLockTimeoutError).waitMs).toBeGreaterThanOrEqual(200);
    expect(log3.warn.some((m) => m.includes('timeout=200'))).toBe(true);
  });
});
