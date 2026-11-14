/**
 * 外部驱动凭据存储(计划 T3.5):Windows 用户级 DPAPI 优先 + 0600 文件回退。
 *
 * ## 为什么不用 0600
 * Phase 0 已实测:NTFS 上 chmod 0600 是**空操作**(ACL 才是权限载体),而外部
 * 驱动密钥恰好是最不能裸存的形态(第三方服务的写权限)。Windows 下用 DPAPI
 * (`ProtectedData.Protect(CurrentUser)`)——密文只能被**同一用户**解开,拷走
 * 文件也没用;非 Windows(开发机/CI)才退回 0600 + warn,那是平台能力差异,
 * 不是安全判断。
 *
 * ## 两个硬性质
 * 1. **值永不进日志/审计**:store 只暴露 get/set/list(键名),没有任何
 *    "回显值"的出口;装配报错只报 ref 名。
 * 2. **失败 fail-open 到明文文件**:DPAPI 不可用(无 PowerShell/权限异常)时
 *    退到 0600 文件 + warn——把用户档案锁死比"密钥在盘上"更糟,且密钥本来
 *    就允许写在 ext_memory.drivers[].apiKey 里(兼容路径),不引入新的硬失败面。
 *
 * ## 传输形态
 * 数据全程走**临时文件 + 环境变量传路径**,加密脚本本身是静态文本经 stdin
 * (`-Command -`)送入——命令行里不出现任何密文/明文,天然免疫引号与转义问题。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { MemoryLogger } from '../types.js';

export interface SecretStoreConfig {
  dataDir: string;
  /** 平台缝(测试注入;缺省 process.platform)。 */
  platform?: NodeJS.Platform;
  /** PowerShell 执行缝(测试注入;缺省 spawn powershell.exe,stdin 送脚本)。 */
  runPowerShell?: (script: string, env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
  logger?: MemoryLogger;
}

export interface SecretStore {
  /** 读密钥;不存在/解密失败 → undefined(调用方按"未配置"处理)。 */
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  /** 已配置的键名(值不回显;面板只显示键名)。 */
  list(): Promise<string[]>;
  readonly backend: 'dpapi' | 'file';
}

const DICT_FILE = 'ext-secrets.json';
const DPAPI_FILE = 'ext-secrets.dpapi';

/** 静态 PowerShell 脚本(经 stdin 送:`-Command -`),路径走环境变量。 */
const PS_ENCRYPT = [
  '$ErrorActionPreference="Stop"',
  '$d=[Text.Encoding]::UTF8.GetBytes((Get-Content -Raw -LiteralPath $env:DSH_SECRET_IN))',
  '$e=[Security.Cryptography.ProtectedData]::Protect($d,$null,"CurrentUser")',
  '[IO.File]::WriteAllText($env:DSH_SECRET_OUT,[Convert]::ToBase64String($e))',
].join('\n');

const PS_DECRYPT = [
  '$ErrorActionPreference="Stop"',
  '$b=[Convert]::FromBase64String((Get-Content -Raw -LiteralPath $env:DSH_SECRET_IN))',
  '$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,"CurrentUser")',
  '[IO.File]::WriteAllText($env:DSH_SECRET_OUT,[Text.Encoding]::UTF8.GetString($d))',
].join('\n');

function spawnPowerShell(script: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin?.end(script, 'utf8');
  });
}

function parseDict(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function createSecretStore(cfg: SecretStoreConfig): SecretStore {
  const platform = cfg.platform ?? process.platform;
  const ps = cfg.runPowerShell ?? spawnPowerShell;
  const logger = cfg.logger;
  const dictPath = path.join(cfg.dataDir, DICT_FILE);
  const dpapiPath = path.join(cfg.dataDir, DPAPI_FILE);
  let backend: 'dpapi' | 'file' = platform === 'win32' ? 'dpapi' : 'file';
  let warnedFile = false;

  const warnFile = (why: string): void => {
    if (warnedFile) return;
    warnedFile = true;
    logger?.warn(`[memory] 外部驱动密钥改用 0600 文件存储(${why});NTFS 上权限位不生效,仅作开发机回退。`);
  };

  const readDict = async (): Promise<Record<string, string>> => {
    if (backend === 'dpapi') {
      if (!existsSync(dpapiPath)) return {};
      const dir = await mkdtemp(path.join(tmpdir(), 'dsh-secret-'));
      try {
        const cipher = path.join(dir, 'cipher.b64');
        const plain = path.join(dir, 'plain.json');
        await writeFile(cipher, await readFile(dpapiPath, 'utf8'), 'utf8');
        const r = await ps(PS_DECRYPT, { DSH_SECRET_IN: cipher, DSH_SECRET_OUT: plain });
        if (r.code !== 0 || !existsSync(plain)) {
          backend = 'file';
          warnFile(`DPAPI 解密失败退出码 ${r.code}: ${r.stderr.slice(0, 200)}`);
          return readDict(); // 降级后重读明文档(可能存在旧格式)
        }
        return parseDict(await readFile(plain, 'utf8'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    if (!existsSync(dictPath)) return {};
    try {
      return parseDict(await readFile(dictPath, 'utf8'));
    } catch {
      return {};
    }
  };

  const writeDict = async (dict: Record<string, string>): Promise<void> => {
    const json = JSON.stringify(dict, null, 2);
    if (backend === 'dpapi') {
      const dir = await mkdtemp(path.join(tmpdir(), 'dsh-secret-'));
      try {
        const plain = path.join(dir, 'plain.json');
        const cipher = path.join(dir, 'cipher.b64');
        await writeFile(plain, json, 'utf8');
        const r = await ps(PS_ENCRYPT, { DSH_SECRET_IN: plain, DSH_SECRET_OUT: cipher });
        if (r.code !== 0 || !existsSync(cipher)) {
          backend = 'file';
          warnFile(`DPAPI 加密失败退出码 ${r.code}: ${r.stderr.slice(0, 200)}`);
          await writeDict(dict); // 降级写明文档
          return;
        }
        await writeFile(dpapiPath, await readFile(cipher, 'utf8'), 'utf8');
        return;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    await writeFile(dictPath, json, { encoding: 'utf8', mode: 0o600 });
    await chmod(dictPath, 0o600).catch(() => undefined);
  };

  return {
    /** getter 而非快照:DPAPI 失败降级后调用方看到的 backend 必须反映真实状态。 */
    get backend() {
      return backend;
    },
    async get(ref: string): Promise<string | undefined> {
      if (ref === '') return undefined;
      return (await readDict())[ref];
    },
    async set(ref: string, value: string): Promise<void> {
      if (ref === '') throw new Error('secret ref 不能为空');
      const dict = await readDict();
      dict[ref] = value;
      await writeDict(dict);
    },
    async delete(ref: string): Promise<void> {
      const dict = await readDict();
      if (dict[ref] === undefined) return;
      delete dict[ref];
      await writeDict(dict);
    },
    async list(): Promise<string[]> {
      return Object.keys(await readDict()).sort();
    },
  };
}

/** `secret://ref` 形态的配置值 → { 源, ref };非该形态返回 undefined(兼容明文 apiKey)。 */
export function parseSecretRef(raw: string): { ref: string } | undefined {
  const m = /^secret:\/\/([A-Za-z0-9._-]{1,64})$/u.exec(raw.trim());
  return m === null ? undefined : { ref: m[1]! };
}
