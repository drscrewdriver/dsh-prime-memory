/**
 * GBK 解码构造失败回退(spec D 兜底项):ICU 无 gbk 的运行时里 `new TextDecoder('gbk')`
 * 抛 RangeError 时,安装链必须回退旧 String(buffer) 行为照常完成——不因解码面把安装弄炸。
 * 本文件把 node:util 的 TextDecoder 换成"gbk 必抛"的替身后才装载被测模块;
 * 走真实 cmd.exe 输出(win32 专属路径),非 win 平台空跑跳过。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>();
  class ThrowingTextDecoder extends actual.TextDecoder {
    constructor(encoding?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) {
      if (encoding === 'gbk') throw new RangeError('mock: no gbk in this runtime');
      super(encoding, options);
    }
  }
  return { ...actual, TextDecoder: ThrowingTextDecoder };
});

// mock 就位后再装载被测模块(其顶层 import { TextDecoder } from 'node:util' 将拿到替身)。
const { RuntimeInstaller, PINNED_TRANSFORMERS_VERSION } = await import('../src/store/runtime-installer.js');

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('GBK TextDecoder 构造失败 → 回退 String(d) 不炸 (spec D)', () => {
  it('win32 真 cmd.exe 输出全链走通,尾行可读', async () => {
    if (process.platform !== 'win32') return;
    dir = await mkdtemp(join(tmpdir(), 'dsh-ri-gbkfb-'));
    const marker = `fallback-ok-${Date.now()}`;
    // 'cmd' 为裸命令名 → useShell=true → 命中被 mock 的 gbk 构造(必抛)→ 回退路径。
    // 退出码 0 但模块未就位,ensure 预期 false——本用例断言的是"不抛异常 + 输出可读"。
    const installer = new RuntimeInstaller(dir, PINNED_TRANSFORMERS_VERSION, {
      lockfileSource: join(dir, 'none.json'),
      pmProbe: async () => ({ cmd: 'cmd', argsPrefix: ['/c', 'echo', marker], pnpmLike: false, label: 'cmd' }),
      logger: noopLogger,
    });
    await expect(installer.ensure()).resolves.toBeTypeOf('boolean');
    const tail = installer.getProgress().lastLines.join('\n');
    expect(tail).toContain(marker);
    expect(tail).not.toContain('\uFFFD');
  });
});
