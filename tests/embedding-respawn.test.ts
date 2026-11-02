/**
 * #22 机理刀·崩溃有界自愈 —— 真 fork stub 跨平台用例。
 *
 * 为什么走真 fork 而非假通道注入:`respawnChannel`/断点续试两条路径都有 `!this.injectedChannel`
 * 守卫(假通道重建会拿到同一实例、自愈无意义且混淆既有崩溃用例)。所以本文件 fork 一个
 * **无模型微型 stub**(fixtures/stub-embed-child.cjs),用 SIGKILL 代替 macOS SIGTRAP 触发同一条
 * child 'exit' → failAll → crashCb 路径,让下面四件事在 CI(ubuntu-latest)也能验:
 *   ① 崩一次 → 自愈重 fork → ready → 下一条成功;
 *   ② 多条目批按实时断点(ack)续试**一次**,头段空洞交 backfill、尾部补齐;
 *   ③ 60s 窗内 ≤2 次自愈,超限回 failed(不再有第三次自愈);
 *   ④ 禁自愈(config respawnOnCrash=false)→ 崩一次即 failed(变异对照,证明键真的在管)。
 * 真模型/真 SIGTRAP 的终验不在这里(本机不可发),见 scripts/verify 与报告人 macOS 回验。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalEmbeddingService } from '../src/store/local-embedding.js';
import { catalogById, type CatalogEntry } from '../src/store/model-catalog.js';
import type { MemoryLogger } from '../src/types.js';

const STUB_CHILD = fileURLToPath(new URL('./fixtures/stub-embed-child.cjs', import.meta.url));
// stub 出向量长度必须与服务侧 entry.dims 校验一致(bge-small-zh = 512)
const STUB_DIMS = 512;

// 模块级共享临时目录(顶层 await:本文件所有 makeService 都要拿到已初始化的 baseDir)
const baseDir = await mkdtemp(join(tmpdir(), 'dsh-respawn-'));
afterAll(async () => {
  delete process.env.STUB_STATE_FILE;
  await rm(baseDir, { recursive: true, force: true });
});

function entry(): CatalogEntry {
  const e = catalogById('bge-small-zh-v1.5');
  if (!e) throw new Error('catalog missing bge-small-zh-v1.5');
  return { ...e, id: 'fake', files: [] };
}

/** 每次调用现起一个绑定真 fork stub 通道的服务,并收集其 info/warn/error 日志。 */
function makeService(opts: { respawn: boolean; stateFile?: string }): { svc: LocalEmbeddingService; logs: string[] } {
  process.env.STUB_DIMS = String(STUB_DIMS);
  if (opts.stateFile) process.env.STUB_STATE_FILE = opts.stateFile;
  else delete process.env.STUB_STATE_FILE;
  const logs: string[] = [];
  const logger: MemoryLogger = {
    info: (s) => logs.push(String(s)),
    warn: (s) => logs.push(String(s)),
    error: (s) => logs.push(String(s)),
  };
  const svc = new LocalEmbeddingService(entry(), join(baseDir, 'models', 'fake'), {
    runtimeDir: join(baseDir, 'runtime'),
    childPath: STUB_CHILD,
    logger,
    maxInputChars: 5000,
    respawnOnCrash: opts.respawn,
  });
  return { svc, logs };
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000, stepMs = 25): Promise<boolean> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return true;
}

/** 等自愈链跑到终态(ready 或 failed),给 refork+秒 warmup 留出时间。 */
const waitSettled = (svc: LocalEmbeddingService) =>
  waitFor(() => {
    const s = svc.getState();
    return s === 'ready' || s === 'failed';
  });

describe('#22 崩溃有界自愈(真 fork stub,无模型依赖)', () => {
  it('崩一次 → 自愈重 fork → ready → 下一条嵌入成功', async () => {
    const { svc, logs } = makeService({ respawn: true });
    await svc.waitForReady();
    expect(svc.isReady()).toBe(true);
    const ok1 = await svc.embedBatch(['hello']);
    expect(ok1[0]).toBeInstanceOf(Float32Array);
    expect(ok1[0].length).toBe(STUB_DIMS);

    // 单条毒输入触发子进程自杀:本调用被拒(通道死),但崩溃应驱动自愈
    await expect(svc.embedBatch(['__CRASHALWAYS__'])).rejects.toThrow();
    expect(await waitSettled(svc)).toBe(true);
    expect(svc.getState()).toBe('ready');

    // 自愈后下一条走重 fork 的新通道,正常返回
    const ok2 = await svc.embedBatch(['world']);
    expect(ok2[0]).toBeInstanceOf(Float32Array);
    expect(ok2[0].length).toBe(STUB_DIMS);
    expect(logs.some((l) => /自愈第 1 次/.test(l))).toBe(true);
    expect(logs.some((l) => /自愈完成/.test(l))).toBe(true);
    svc.close();
  });

  it('多条目批:实时断点(ack)续试一次,头段留空洞、尾部补齐', async () => {
    const stateFile = join(baseDir, `once-${Date.now()}.flag`);
    const { svc, logs } = makeService({ respawn: true, stateFile });
    await svc.waitForReady();
    // [aaa, CRASHONCE, ccc]:aaa 出向量并上报 done=1 后,CRASHONCE 首遇即自杀(落 state 文件)
    const res = await svc.embedBatch(['aaa', '__CRASHONCE__', 'ccc']);
    // 断点续试:头 1 位向量随崩溃子进程丢失(空洞,交 backfill 补),尾部 slice(1) 在重 fork 后成功
    expect(res.length).toBe(3);
    expect(res[0]).toBeUndefined();
    expect(res[1]).toBeInstanceOf(Float32Array);
    expect(res[2]).toBeInstanceOf(Float32Array);
    expect(logs.some((l) => /断点续试/.test(l) && /from=1/.test(l))).toBe(true);
    svc.close();
  });

  it('毒输入每次必崩:仅续一次后 reject,不活锁(自愈次数 ≤2)', async () => {
    const { svc, logs } = makeService({ respawn: true });
    await svc.waitForReady();
    // [aaa, CRASHALWAYS]:aaa done=1 后崩;断点续试 slice(1)=['CRASHALWAYS'] 再崩 → reject
    await expect(svc.embedBatch(['aaa', '__CRASHALWAYS__'])).rejects.toThrow();
    // 只续了一次就抛错:批内崩点之后的重试失败不循环
    const selfHeal = logs.filter((l) => /自愈第/.test(l)).length;
    expect(selfHeal).toBeLessThanOrEqual(2);
    // 后台可能仍在自愈,close 钉死通道防孤儿
    svc.close();
    await waitFor(() => {
      const s = svc.getState();
      return s === 'terminated';
    });
  });

  it('速率上限:60s 窗内 ≤2 次自愈,超限回 failed 不再 fork', async () => {
    const { svc, logs } = makeService({ respawn: true });
    await svc.waitForReady();
    // 三次「单条毒输入」崩溃,逐次等自愈回终态再崩下一次
    for (let k = 0; k < 3; k++) {
      await svc.embedBatch(['__CRASHALWAYS__']).catch(() => {});
      await waitSettled(svc);
    }
    // 前两次算自愈,第三次超窗 → 不再 fork,转 failed
    expect(svc.getState()).toBe('failed');
    expect(logs.filter((l) => /自愈第/.test(l)).length).toBe(2);
    expect(logs.some((l) => /转入 failed/.test(l))).toBe(true);
    // failed 态下后续调用直接抛(旧语义:换源/重启恢复)
    await expect(svc.embedBatch(['ok'])).rejects.toThrow('加载失败');
    svc.close();
  });

  it('变异对照:respawnOnCrash=false 时崩一次即 failed(键真的在管)', async () => {
    const { svc, logs } = makeService({ respawn: false });
    await svc.waitForReady();
    await expect(svc.embedBatch(['__CRASHALWAYS__'])).rejects.toThrow();
    await waitSettled(svc);
    expect(svc.getState()).toBe('failed');
    expect(logs.some((l) => /自愈第/.test(l))).toBe(false);
    expect(logs.some((l) => /转入 failed/.test(l))).toBe(true);
    await expect(svc.embedBatch(['ok'])).rejects.toThrow('加载失败');
    svc.close();
  });

  it('主动 close 后 terminated:崩溃不触发自愈、不复用(铁律)', async () => {
    const { svc } = makeService({ respawn: true });
    await svc.waitForReady();
    svc.close();
    expect(svc.getState()).toBe('terminated');
    // terminated 后任何调用直接抛「不可复用」,且不会再有自愈日志
    await expect(svc.embedBatch(['x'])).rejects.toThrow('不可复用');
    svc.close(); // 幂等
    expect(svc.getState()).toBe('terminated');
  });

  it('哨兵:崩溃归因串含 signal(被硬杀时 code=null 只靠 signal 区分)', async () => {
    const { svc, logs } = makeService({ respawn: true });
    await svc.waitForReady();
    await svc.embedBatch(['__CRASHALWAYS__']).catch(() => {});
    await waitSettled(svc);
    const crashLine = logs.find((l) => /退出\(code=/.test(l));
    expect(crashLine, '崩溃行必须归因 code/signal,否则 SIGTRAP 与自杀在日志里长得一样').toBeTruthy();
    expect(/signal=/.test(crashLine ?? '')).toBe(true);
    svc.close();
  });
});
