/**
 * T1.3 / T1.5:孤儿 tmp 启动清理 + embedding-source 收编。
 *
 * - 原子性补全:写失败不留固定名 tmp;进程被 kill 留下的 tmp 由启动扫描回收;
 * - G6 静默失败消除:`set()` 的写失败必须对调用方可观测(旧实现 `.catch(()=>{})` 吞掉)。
 *
 * ⚠️ 本机 `fs.rm({recursive:true})` 实测 30–60s(杀软/索引),远超 vitest 默认
 * 10s hook 超时 → 全文件**共用**一个临时目录、只在 afterAll 清一次,并显式放宽
 * hook 超时。别在 afterEach 里递归删目录。
 */
import { mkdir, readFile, readdir, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EmbeddingSourceStore } from '../src/store/embedding-source.js';
import { cleanupOrphanTmp } from '../src/util/io.js';
import { flTmp } from './file-layer-tmp.js';

// 本机删除极慢(单次 unlink 1.6～5.4s),跑本文件要显式放宽超时:
//   vitest run tests/file-layer-*.test.ts --testTimeout=60000 --hookTimeout=600000
// 临时目录只在 evidence/cleanup-pending.txt 留记录,不做同步清理(见 file-layer-tmp.ts)。

const collectLogs = () => {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    logger: { debug() {}, info: (m: string) => info.push(m), warn: (m: string) => warn.push(m), error() {} },
  };
};

/**
 * 等锁文件真正被释放(本机 unlink 异常慢 1.6~5.4s,见 findings §11)。
 * `withFileLock` 在值返回后才异步 `unlink` 锁文件,若紧接着 `readdir` 判"无残留"会
 * 与未完成的 unlink 竞态,把环境 IO 慢误判成产品缺陷。轮询到锁文件消失再继续。
 */
async function waitLockGone(lockPath: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(lockPath);
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error(`锁文件未在 ${timeoutMs}ms 内释放: ${lockPath}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('T1.3 孤儿 tmp 启动清理', () => {
  it('清理本插件命名的 tmp 与 legacy 固定名,跳过第三方 .tmp 与 runtime 子树,且每条留日志', async () => {
    const d = await flTmp('orphan');
    // 本插件命名规则:<target>.<pid>.<hex8>.tmp
    await writeFile(join(d, 'slots.json.1234.abcd1234.tmp'), '{}', 'utf8');
    await mkdir(join(d, 'snapshots'), { recursive: true });
    // 注意:末段必须是真实的小写 hex(randomUUID 产物),否则不匹配命名规则
    await writeFile(join(d, 'snapshots', 'l1-records.json.1234.cafe5678.tmp'), '[]', 'utf8');
    // 收编前的遗留固定名(embedding-source 旧 persist)
    await writeFile(join(d, 'embedding-source.json.tmp'), '{}', 'utf8');
    // 不该动的:第三方 tmp、runtime 子树(tmp 可能在 node_modules 里正常存在)
    await writeFile(join(d, 'someone-else.tmp'), 'x', 'utf8');
    await mkdir(join(d, 'runtime', 'node_modules'), { recursive: true });
    await writeFile(join(d, 'runtime', 'node_modules', 'pkg.json.9999.aaaaaaaa.tmp'), 'x', 'utf8');
    // 正常产物绝不能被误删
    await writeFile(join(d, 'slots.json'), '{"version":1}', 'utf8');

    const log = collectLogs();
    const removed = await cleanupOrphanTmp(d, log.logger);

    expect(removed).toBe(3);
    const left = (await readdir(d, { recursive: true })).sort();
    expect(left).toContain('slots.json');
    expect(left).toContain('someone-else.tmp'); // 第三方产物:不是我们的命名,不碰
    expect(left).toContain(join('runtime', 'node_modules', 'pkg.json.9999.aaaaaaaa.tmp'));
    expect(left).not.toContain('slots.json.1234.abcd1234.tmp');
    expect(left).not.toContain(join('snapshots', 'l1-records.json.1234.cafe5678.tmp'));
    expect(left).not.toContain('embedding-source.json.tmp');
    // 每条清理都有诊断(不静默删):逐条带路径 + 结尾一条汇总
    expect(log.info.filter((m) => m.includes('启动清理孤儿临时文件:'))).toHaveLength(3);
    expect(log.info.filter((m) => m.includes('启动清理孤儿临时文件 3 个'))).toHaveLength(1);
  });

  it('目录不可读时不抛(清理失败不影响启动)', async () => {
    const log = collectLogs();
    await expect(cleanupOrphanTmp(join(await flTmp('orphan'), 'nope'), log.logger)).resolves.toBe(0);
  });
});

describe('T1.5 embedding-source 收编', () => {
  it('set() 写失败对调用方可观测(不再 await 成功却没落盘)', async () => {
    const d = await flTmp('fail');
    // 让目标路径成为目录 → rename 必然失败(跨平台)
    await mkdir(join(d, 'embedding-source.json'));
    const store = new EmbeddingSourceStore(d);
    await expect(store.set({ source: 'local', activeModel: 'm' })).rejects.toThrow();
  });

  it('写失败不把后续 set 永久钉死(队列仍可用)', async () => {
    const d = await flTmp('recover');
    const blocker = join(d, 'embedding-source.json');
    await mkdir(blocker);
    const store = new EmbeddingSourceStore(d);
    await expect(store.set({ source: 'off', activeModel: null })).rejects.toThrow();
    await rmdir(blocker); // 空目录:rmdir 是百毫秒级,rm -r 在本机要几十秒
    await expect(store.set({ source: 'local', activeModel: 'm' })).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(d, 'embedding-source.json'), 'utf8'))).toEqual({
      source: 'local',
      activeModel: 'm',
    });
  });

  it('落盘走 atomicWriteText:不留固定名 tmp,内容两空格缩进', async () => {
    const d = await flTmp('clean');
    const store = new EmbeddingSourceStore(d);
    await store.set({ source: 'remote', activeModel: null });
    await waitLockGone(join(d, 'embedding-source.json.lock')); // 等释放落盘,避免误判残留
    const files = await readdir(d);
    expect(files).toEqual(['embedding-source.json']); // 无 embedding-source.json.tmp 残留
    expect(await readFile(join(d, 'embedding-source.json'), 'utf8')).toBe(
      JSON.stringify({ source: 'remote', activeModel: null }, null, 2),
    );
  });
});

