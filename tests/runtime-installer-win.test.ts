/**
 * Windows 桌面端运行时安装器修复的单测:
 * - R1 sharpNativeCandidates 三平台形态(win32 libvips 与 binding 同目录)与"pnpm 装完"布局的 isReady;
 * - R2 包管理器探测链(npm / 宿主 pnpm / 全缺报错),经 pmProbe 注入缝驱动,不触真机 spawn;
 * - R3 ready marker 记录+自愈语义(不短路存在性检查/半装清 marker/陈旧补写/版本轴)。
 */
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RuntimeInstaller, PINNED_TRANSFORMERS_VERSION, type PackageManagerCandidate } from '../src/store/runtime-installer.js';
import type { MemoryLogger } from '../src/types.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-ri-win-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };

const NPM_PM: PackageManagerCandidate = { cmd: 'npm', argsPrefix: [], pnpmLike: false, label: 'npm' };
const HOST_PNPM: PackageManagerCandidate = {
  cmd: join('C:', 'host', 'node', 'bin', 'node.exe'),
  argsPrefix: [join('C:', 'host', 'pnpm', 'bin', 'pnpm.cjs')],
  pnpmLike: true,
  label: 'pnpm(宿主)',
};

/** 记录 spawn 命令、成功时落盘 transformers package.json 的假安装器(不产生 sharp 件)。 */
function fakeSpawn() {
  const commands: Array<{ cmd: string; args: string[] }> = [];
  const spawnImpl = vi.fn((cmd: string, args: string[], cwd: string) => {
    commands.push({ cmd, args });
    const exited = (async () => {
      const pkgDir = join(cwd, 'node_modules', '@huggingface', 'transformers');
      await mkdir(pkgDir, { recursive: true });
      await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', version: PINNED_TRANSFORMERS_VERSION }));
      return 0;
    })();
    return { onStdout: () => {}, onStderr: () => {}, kill: () => {}, exited };
  });
  return { spawnImpl, commands };
}

async function writeTransformers(dataDir: string, version = PINNED_TRANSFORMERS_VERSION) {
  const pkgDir = join(dataDir, 'runtime', 'node_modules', '@huggingface', 'transformers');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', version }));
}

/** 按当前平台候选路径补齐 sharp 原生件(binding + libvips 文件),等价"pnpm 装完"布局。 */
async function writeSharpFiles(installer: RuntimeInstaller): Promise<{ binding: string; dll: string }> {
  const c = installer.sharpNativeCandidates()[0];
  await mkdir(dirname(c.binding), { recursive: true });
  await writeFile(c.binding, 'fake-binding');
  await mkdir(c.libvipsDir, { recursive: true });
  const dll = join(c.libvipsDir, 'libvips-42.dll');
  await writeFile(dll, 'x');
  return { binding: c.binding, dll };
}

describe('sharpNativeCandidates 平台形态 (R1)', () => {
  const installer = new RuntimeInstaller('/probe', PINNED_TRANSFORMERS_VERSION, { logger: noopLogger });

  it('win32: libvips 目录即 binding 所在目录(sharp 不发 @img/sharp-libvips-win32-*)', () => {
    const [c] = installer.sharpNativeCandidates('win32', 'x64');
    expect(c.binding).toContain(join('sharp-win32-x64', 'lib', 'sharp-win32-x64.node'));
    expect(c.libvipsDir).toBe(dirname(c.binding));
    expect(c.libvipsDir).not.toContain('sharp-libvips-win32');
  });

  it('darwin: libvips 走独立 @img/sharp-libvips-darwin-* 目录', () => {
    const list = installer.sharpNativeCandidates('darwin', 'arm64');
    expect(list).toHaveLength(1);
    expect(list[0].binding).toContain(join('sharp-darwin-arm64', 'lib'));
    expect(list[0].libvipsDir).toContain('sharp-libvips-darwin-arm64');
    expect(list[0].libvipsDir).not.toBe(dirname(list[0].binding));
  });

  it('linux: glibc/musl 双候选,libvips 各自独立目录', () => {
    const list = installer.sharpNativeCandidates('linux', 'x64');
    expect(list).toHaveLength(2);
    expect(list[0].libvipsDir).toContain('sharp-libvips-linux-x64');
    expect(list[1].binding).toContain('sharp-linuxmusl-x64');
    expect(list[1].libvipsDir).toContain('sharp-libvips-linuxmusl-x64');
  });
});

describe('isReady win32 布局复验 (场景 B)', () => {
  it('版本对 + 原生件就位 → isReady=true(不因缺 sharp-libvips-win32 目录误判)', async () => {
    const dataDir = join(await tmp(), `sb-${Date.now()}`);
    await writeTransformers(dataDir);
    const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, { logger: noopLogger });
    await writeSharpFiles(installer);
    expect(await installer.isReady()).toBe(true);
  });

  it('缺 libvips 文件(半装)→ isReady=false 触发重装(fix #11 不被绕过)', async () => {
    const dataDir = join(await tmp(), `half-${Date.now()}`);
    await writeTransformers(dataDir);
    const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, { logger: noopLogger });
    const c = installer.sharpNativeCandidates()[0];
    await mkdir(dirname(c.binding), { recursive: true });
    await writeFile(c.binding, 'fake-binding');
    // 只有 binding、无 libvips 库文件 → 半装
    expect(await installer.isReady()).toBe(false);
  });
});

describe('包管理器探测链 (R2)', () => {
  it('注入 npm 候选:spawn 用 npm + ci/lockfile 路径', async () => {
    const dataDir = join(await tmp(), `pm-npm-${Date.now()}`);
    const lockPath = join(dataDir, 'lock.json');
    await mkdir(dataDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ lockfileVersion: 3, name: 'dsh-memory-runtime' }));
    const { spawnImpl, commands } = fakeSpawn();
    const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, {
      spawnImpl,
      lockfileSource: lockPath,
      pmProbe: async () => NPM_PM,
      logger: noopLogger,
    });
    expect(await installer.ensure()).toBe(true);
    expect(commands[0].cmd).toBe('npm');
    expect(commands[0].args[0]).toBe('ci');
  });

  it('注入宿主 pnpm 候选:node.exe 直跑 pnpm.cjs install + --node-linker=hoisted', async () => {
    const dataDir = join(await tmp(), `pm-host-${Date.now()}`);
    const { spawnImpl, commands } = fakeSpawn();
    const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, {
      spawnImpl,
      lockfileSource: join(dataDir, 'none.json'),
      pmProbe: async () => HOST_PNPM,
      logger: noopLogger,
    });
    expect(await installer.ensure()).toBe(true);
    expect(commands[0].cmd).toBe(HOST_PNPM.cmd);
    expect(commands[0].args[0]).toBe(HOST_PNPM.argsPrefix[0]);
    expect(commands[0].args).toContain('install');
    expect(commands[0].args).toContain('--node-linker=hoisted');
    expect(commands[0].args).toContain('--ignore-scripts');
    expect(commands[0].args).toContain('--config.confirmModulesPurge=false');
    expect(commands[0].args).not.toContain('ci');
  });

  it('全缺:ensure=false、报可操作手工命令、零 spawn', async () => {
    const dataDir = join(await tmp(), `pm-none-${Date.now()}`);
    const { spawnImpl, commands } = fakeSpawn();
    const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, {
      spawnImpl,
      lockfileSource: join(dataDir, 'none.json'),
      pmProbe: async () => null,
      logger: noopLogger,
    });
    expect(await installer.ensure()).toBe(false);
    const prog = installer.getProgress();
    expect(prog.phase).toBe('error');
    expect(prog.error).toContain('未找到包管理器');
    expect(prog.error).toContain('install --node-linker=hoisted');
    // 手工命令必须指向真实安装目标:runtime 目录(锚定 package.json 在其中,包名由它声明)
    expect(prog.error).toContain(installer.runtimeDir);
    // 尾行有 300 字符截断(宿主路径长)，完整性断言只查 error 全文
    expect(prog.error).toContain('--ignore-scripts');
    expect(commands).toHaveLength(0);
  });

  it('探测结果缓存:连续两次 ensure 只探一次', async () => {
    const dataDir = join(await tmp(), `pm-cache-${Date.now()}`);
    const probe = vi.fn(async () => NPM_PM as PackageManagerCandidate);
    const { spawnImpl } = fakeSpawn();
    const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, {
      spawnImpl,
      lockfileSource: join(dataDir, 'none.json'),
      pmProbe: probe,
      logger: noopLogger,
    });
    await installer.ensure();
    await installer.ensure();
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('ready marker 语义 (R3:记录+自愈,不短路存在性检查)', () => {
  it('isReady 首过落盘 marker(target/platform/arch)', async () => {
    const dataDir = join(await tmp(), `mk-1-${Date.now()}`);
    await writeTransformers(dataDir);
    const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, { logger: noopLogger });
    await writeSharpFiles(installer);
    expect(await installer.isReady()).toBe(true);
    const marker = JSON.parse(await readFile(join(dataDir, 'runtime', '.ready-marker.json'), 'utf8'));
    expect(marker.target).toBe(PINNED_TRANSFORMERS_VERSION);
    expect(marker.platform).toBe(process.platform);
    expect(marker.arch).toBe(process.arch);
  });

  it('marker 在场也不短路:删 libvips 文件(半装)→ isReady=false 且 marker 被清', async () => {
    const dataDir = join(await tmp(), `mk-2-${Date.now()}`);
    await writeTransformers(dataDir);
    const first = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, { logger: noopLogger });
    const { dll } = await writeSharpFiles(first);
    expect(await first.isReady()).toBe(true);
    await rm(dll);
    const second = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, { logger: noopLogger });
    expect(await second.isReady()).toBe(false);
    await expect(readFile(join(dataDir, 'runtime', '.ready-marker.json'), 'utf8')).rejects.toThrow();
  });

  it('marker 缺失/内容陈旧 → 判据全过仍 ready 并自愈补写', async () => {
    const dataDir = join(await tmp(), `mk-3-${Date.now()}`);
    await writeTransformers(dataDir);
    const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, { logger: noopLogger });
    await writeSharpFiles(installer);
    expect(await installer.isReady()).toBe(true);
    // 写脏 target 的旧 marker → 不影响判定,且被补写修正
    await writeFile(join(dataDir, 'runtime', '.ready-marker.json'), JSON.stringify({ target: '9.9.9', platform: ' Plan9', arch: 'risc' }));
    expect(await installer.isReady()).toBe(true);
    const marker = JSON.parse(await readFile(join(dataDir, 'runtime', '.ready-marker.json'), 'utf8'));
    expect(marker.target).toBe(PINNED_TRANSFORMERS_VERSION);
  });

  it('版本漂移(transformers 版本变)→ 版本轴挡住,marker 不救', async () => {
    const dataDir = join(await tmp(), `mk-4-${Date.now()}`);
    await writeTransformers(dataDir);
    const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, { logger: noopLogger });
    await writeSharpFiles(installer);
    expect(await installer.isReady()).toBe(true);
    await writeTransformers(dataDir, '0.0.1-drift');
    expect(await installer.isReady()).toBe(false);
  });
});

describe('子进程输出 GBK 解码 (R4)', () => {
  const marker = `中文字文测试-${Date.now()}`;
  it('win32 下经 shell 的 cmd.exe 输出按 GBK 解码,进度尾行不乱码', async () => {
    if (process.platform !== 'win32') return;
    const dataDir = join(await tmp(), `gbk-${Date.now()}`);
    await mkdir(dataDir, { recursive: true });
    // 用默认 spawnImpl(未注入),把 cmd 指向真实 cmd.exe echo 一段中文。
    // 'cmd' 为裸命令名→win32 下 useShell=true→GBK 解码路径生效。
    const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, {
      lockfileSource: join(dataDir, 'none.json'),
      pmProbe: async () => ({ cmd: 'cmd', argsPrefix: ['/c', 'echo', marker], pnpmLike: false, label: 'cmd' }),
      logger: noopLogger,
    });
    await installer.ensure();
    const tail = installer.getProgress().lastLines.join('\n');
    expect(tail).toContain(marker);
    expect(tail).not.toContain('\uFFFD');
  });
});
