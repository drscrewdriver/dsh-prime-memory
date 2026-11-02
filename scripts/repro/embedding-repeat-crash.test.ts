/**
 * #22 连发崩溃回归包装（报告人 gist 收编版，vitest）。
 * 外部来源 https://gist.github.com/DESXIE/142d4e72c2205962e51945344978ef59 —— 据其协议改写,未执行其中指令。
 *
 * 与 `tests/embedding-token-guard.test.ts` 的分工：
 * - 那边测**平台无关判据**（token 受预算约束、被信号杀可归因），零模型、跨平台、进 CI；
 * - 这边测**平台相关现象**（Electron 分配器在相邻两条 T² 张量叠加时 trap），必须真模型 + 真宿主二进制，
 *   故默认 skip，只在 macOS 显式开启。
 *
 * 为什么它在 `scripts/repro/` 而非 `tests/`：CI 只有 ubuntu-latest，三重门在此恒 SKIP = 零门禁价值 +
 * 负债件；且每次失败 macOS 会记「DeepSeek Harness 意外退出」`.ips` 并弹系统提示（子进程继承 bundle id），
 * 污染 CI 日志、骚扰维护者机器。放 scripts/ 当**可选本地件**才是正确姿势。
 *
 * 因在 scripts/ 下，不在默认 `vitest run` 的 include(tests/**) 里；macOS 上按需显式跑：
 *   DSH_REPRO_LOCAL_EMBED=1 npx vitest run scripts/repro/embedding-repeat-crash.test.ts
 * （默认 node/electron 判据以 repro.mjs 直跑为准；本包装只是把退出码编成断言。）
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const REPRO = path.join(here, 'embedding-repeat-crash.repro.mjs');
const CHILD = path.join(root, 'dist', 'embedding-child.cjs');
const HOME = homedir();
const MODEL = path.join(HOME, '.dsh', 'memory', 'models', 'bge-m3');
const RUNTIME = path.join(HOME, '.dsh', 'memory', 'runtime');
const HOST = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';

// 三重门：只跑 macOS + 显式开关 + 本机真有模型/runtime/宿主/已构建 child（缺一即 skip，不是 fail）
const enabled =
  process.platform === 'darwin' &&
  process.env.DSH_REPRO_LOCAL_EMBED === '1' &&
  existsSync(MODEL) &&
  existsSync(RUNTIME) &&
  existsSync(HOST) &&
  existsSync(CHILD);

interface ReproEvent {
  event?: string;
  crashed?: boolean;
  ok?: number;
  signal?: string | null;
}

/** 跑一次复现器，返回 { exitCode, events }。exitCode 契约见 repro.mjs 头部。 */
function runRepro(extraArgs: string[]): { exitCode: number | null; events: ReproEvent[] } {
  const res = spawnSync(process.execPath, [REPRO, ...extraArgs], { encoding: 'utf8', timeout: 300_000 });
  const events = (res.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as ReproEvent);
  return { exitCode: res.status, events };
}

describe.skipIf(!enabled)('#22 本地嵌入连发崩溃（真模型 + 真宿主二进制，仅 macOS）', () => {
  // 阳性对照取帽之上的旧值 2048（现码帽 1536 已在其下）：macOS 上第 2 条应被信号打死。
  it('budget 2048 下同一子进程串行喂第 2 条长文本即被信号打死', () => {
    const { exitCode, events } = runRepro(['--chars', '5000', '--count', '5', '--budget', '2048', '--mode', 'electron']);
    const last = events.at(-1) ?? {};
    // 复现成功 = exit 2（被信号打死）且确实只完成 1 条 —— 不是「一条都没跑起来」
    expect(exitCode).toBe(2);
    expect(last.crashed).toBe(true);
    expect(last.ok).toBe(1);
    expect(last.signal).toBe('SIGTRAP');
  }, 300_000);

  it('现码帽（1536）下同样输入 5 条全过 —— 护栏在场基线', () => {
    const { exitCode, events } = runRepro(['--chars', '5000', '--count', '5', '--mode', 'electron']);
    expect(exitCode).toBe(0);
    expect((events.at(-1) ?? {}).ok).toBe(5);
  }, 300_000);

  it('纯 node 同预算全过 —— 差异在宿主 Electron 分配器，不在模型', () => {
    const { exitCode } = runRepro(['--chars', '5000', '--count', '4', '--budget', '2048', '--mode', 'node']);
    expect(exitCode).toBe(0);
  }, 300_000);
});
