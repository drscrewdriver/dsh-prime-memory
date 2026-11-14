/**
 * CLI 驱动的子进程执行器(计划 T1.x;byterover / mnemon-native 用)。
 *
 * 纪律取自参考实现 operations 约束与本地嵌入子进程(#22)的教训:
 * - `spawn(command, args, { shell: false })`——绝不拼 shell 字符串,查询原文
 *   里带 `;`/反引号就是命令注入的入口;
 * - stdout/stderr 各有字节上限(默认 256 KiB),超限即杀——防失控 CLI 把宿主内存吃穿;
 * - 超时先 SIGTERM、1.5s 后 SIGKILL 钉底;Windows 走 `taskkill /T /F` 杀整棵
 *   子进程树(node kill 对 conhost 包裹的孙进程无效);
 * - 外部 AbortSignal 贯穿:取消 = 立刻杀,不留孤儿;
 * - 单实例复用交给驱动自己(每 driver 至多一路在途,pusher/lane 侧已串行化);
 *   本函数保持"一次调用一个进程"的简单形状,不隐藏池。
 */
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** 错误文案前缀(哪家 CLI 炸的一眼可辨)。 */
  label?: string;
}

export interface RunProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class ExtProcessError extends Error {
  readonly killed: boolean;
  constructor(message: string, killed = false) {
    super(message);
    this.name = 'ExtProcessError';
    this.killed = killed;
  }
}

export type ProcessRunner = (command: string, args: readonly string[], opts: RunProcessOptions) => Promise<RunProcessResult>;

function killTree(child: { pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean }): void {
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true });
      killer.on('error', () => child.kill());
      return;
    } catch {
      /* 落到 node 自带 kill */
    }
  }
  child.kill();
}

export const runProcess: ProcessRunner = (command, args, opts) =>
  new Promise<RunProcessResult>((resolve, reject) => {
    const label = opts.label ?? command;
    if (opts.signal?.aborted === true) {
      reject(new ExtProcessError(`${label} request aborted`));
      return;
    }
    const maxBytes = opts.maxOutputBytes ?? 256 * 1024;
    let spawnOpts: SpawnOptions;
    try {
      spawnOpts = {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(opts.env === undefined ? {} : { env: opts.env }),
        windowsHide: true,
      } as SpawnOptions;
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], spawnOpts);
    } catch (err) {
      reject(new ExtProcessError(`${label} spawn failed: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    let out = '';
    let errText = '';
    let overflow = false;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const bail = (msg: string, killed: boolean): void => {
      if (killed) killTree(child);
      finish(() => reject(new ExtProcessError(msg, killed)));
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.length > maxBytes) bail(`${label} output exceeded ${maxBytes} bytes`, true);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errText += chunk.toString('utf8');
      if (errText.length > maxBytes) overflow = true;
    });
    const timer = setTimeout(() => bail(`${label} timed out after ${opts.timeoutMs}ms`, true), opts.timeoutMs);
    const onAbort = (): void => bail(`${label} request aborted`, true);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      // ENOENT 最常见:CLI 未安装。文案点名下令,面板能把锅还给配置。
      const code = (err as NodeJS.ErrnoException).code;
      finish(() => reject(new ExtProcessError(`${label} spawn error${code === undefined ? '' : ` (${code})`}: ${err.message}`)));
    });
    child.on('close', (code) => {
      if (overflow) {
        finish(() => reject(new ExtProcessError(`${label} stderr exceeded ${maxBytes} bytes`)));
        return;
      }
      finish(() => resolve({ exitCode: code ?? -1, stdout: out, stderr: errText }));
    });
  });

/** SIGTERM → 宽限 → SIGKILL 的通用等待形态(供常驻子进程驱动复用,Phase 1 先用即发即走)。 */
export const TERM_GRACE_MS = 1_500;
