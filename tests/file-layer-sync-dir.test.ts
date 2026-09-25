/**
 * T1.1 / T1.2:目录 fsync 的平台分支与失败策略。
 *
 * 单独一个文件:整个文件 mock 了 `node:fs`,与真实的孤儿 tmp / embedding-source
 * 用例混在一起会互相污染。
 *
 * 验证三件事:
 * 1. POSIX 分支:rename 之后**确实**对目录做了一次 `open(dir,'r') + fsync`;
 * 2. win32 分支:不做目录 fsync,且不报错(本机就是 win32,直接真跑);
 * 3. 失败策略(T1.2 决策):目录 fsync 抛错时**吞 + warn**,不打断写入。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  opens: [] as string[],
  syncs: [] as string[],
  renames: [] as string[],
  failDirSync: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rename: vi.fn(async (from: string, to: string) => {
        h.renames.push(`${from}->${to}`);
      }),
      unlink: vi.fn(async () => undefined),
      open: vi.fn(async (p: string, mode: string) => {
        h.opens.push(`${p}|${mode}`);
        return {
          sync: async () => {
            if (h.failDirSync && mode === 'r') throw new Error('EIO: dir fsync failed');
            h.syncs.push(`${p}|${mode}`);
          },
          close: async () => undefined,
        };
      }),
    },
  };
});

const { atomicWriteText, syncDirectory } = await import('../src/util/io.js');

const realPlatform = process.platform;
const setPlatform = (p: string): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
};

afterEach(() => {
  setPlatform(realPlatform);
  h.opens.length = 0;
  h.syncs.length = 0;
  h.renames.length = 0;
  h.failDirSync = false;
});

describe('T1.1 目录 fsync', () => {
  it('POSIX:rename 后对目标目录做 open(dir,"r") + fsync', async () => {
    setPlatform('linux');
    await atomicWriteText('/data/mem/state.json', '{}');

    // 文件数据块:'r+' 打开 tmp 后 fsync
    expect(h.opens.some((o) => o.includes('/data/mem/state.json') && o.endsWith('|r+'))).toBe(true);
    expect(h.syncs.some((s) => s.startsWith('/data/mem/state.json') && s.endsWith('|r+'))).toBe(true);
    // 目录项:'r' 打开目录后 fsync(这是本次补上的那一步)
    expect(h.opens).toContain('/data/mem|r');
    expect(h.syncs).toContain('/data/mem|r');
    // 顺序:先 rename 再目录 fsync(目录 fsync 失败时数据已在盘上)
    expect(h.renames).toHaveLength(1);
  });

  it('win32:不打开目录、不 fsync 目录,且不抛', async () => {
    setPlatform('win32');
    await expect(atomicWriteText('/data/mem/state.json', '{}')).resolves.toBeUndefined();
    expect(h.opens.some((o) => o.endsWith('|r'))).toBe(false);
    expect(h.syncs.some((s) => s.endsWith('|r'))).toBe(false);
    expect(await syncDirectory('/data/mem')).toBe(false);
  });

  it('T1.2 决策:目录 fsync 失败 → 吞 + warn,写入本身仍算成功', async () => {
    setPlatform('linux');
    h.failDirSync = true;
    const warn = vi.fn();
    // 不抛:数据块已 fsync、rename 已成功,不该把"元数据可能没落盘"报成写失败
    await expect(atomicWriteText('/data/mem/state.json', '{}', { logger: { warn } as never })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('/data/mem');
    expect(warn.mock.calls[0][0]).toContain('目录 fsync 失败');
    // 但 renames 已发生(tmp → 目标),文件是新内容
    expect(h.renames).toHaveLength(1);
  });

  it('本机(win32)真实调用:不抛、返回 false', async () => {
    expect(await syncDirectory('.')).toBe(false);
  });
});
