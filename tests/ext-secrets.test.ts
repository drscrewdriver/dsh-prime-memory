/**
 * 凭据安全与日志脱敏测(计划 T3.5 判据):
 * ① DPAPI 后端:经注入的 PowerShell 缝完成 加密→落密文→解密→取回,盘上不出现明文;
 * ② DPAPI 失败 → 自动降级 0600 文件 + 只 warn 一次(不锁死用户档案);
 * ③ `secret://ref` 解析只认白名单字符;
 * ④ 日志 sink 脱敏:密钥样文本进日志前被替换,脱敏自身异常回占位符不泄原文。
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecretStore, parseSecretRef } from '../src/ext-memory/secrets.js';
import { scrubSecretsForLog } from '../src/ext-memory/redact-gate.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    for (let i = 0; i < 5; i++) {
      try {
        await rm(d, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'dsh-secret-test-'));
  dirs.push(d);
  return d;
}

/** 伪 DPAPI:加密=反转字节+b64,解密=反向;只验证"经 PS 缝且盘上非明文"。 */
const fakePs = vi.fn(async (script: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> => {
  const enc = script.includes('Protect(');
  const plain = await readFile(env.DSH_SECRET_IN!, 'utf8');
  const out = enc ? Buffer.from(plain, 'utf8').reverse().toString('base64') : Buffer.from(plain, 'base64').reverse().toString('utf8');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(env.DSH_SECRET_OUT!, out, 'utf8');
  return { code: 0, stdout: '', stderr: '' };
});

describe('凭据库(T3.5)', () => {
  it('DPAPI 后端:set→get 往返经 PS 缝;盘上只有密文文件', async () => {
    const dataDir = await tmp();
    const store = createSecretStore({ dataDir, platform: 'win32', runPowerShell: fakePs });
    expect(store.backend).toBe('dpapi');
    await store.set('mem0-prod', 'sk-super-secret');
    expect(await store.get('mem0-prod')).toBe('sk-super-secret');
    expect(await store.list()).toEqual(['mem0-prod']);
    const files = await readdir(dataDir);
    expect(files).toContain('ext-secrets.dpapi');
    expect(files).not.toContain('ext-secrets.json');
    const onDisk = await readFile(join(dataDir, 'ext-secrets.dpapi'), 'utf8');
    expect(onDisk).not.toContain('sk-super-secret');
    await store.delete('mem0-prod');
    expect(await store.get('mem0-prod')).toBeUndefined();
  });

  it('DPAPI 加密失败 → 降级 0600 文件 + warn 一次(不锁死)', async () => {
    const dataDir = await tmp();
    const warn = vi.fn();
    const failing = vi.fn(async (): Promise<{ code: number; stdout: string; stderr: string }> => ({ code: 1, stdout: '', stderr: 'no powershell' }));
    const store = createSecretStore({ dataDir, platform: 'win32', runPowerShell: failing, logger: { info: () => {}, warn, error: () => {} } });
    await store.set('k1', 'v1');
    expect(store.backend).toBe('file');
    expect(await store.get('k1')).toBe('v1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await readdir(dataDir))).toContain('ext-secrets.json');
  });

  it('非 Windows:直接 0600 文件后端;set/delete/list 幂等', async () => {
    const dataDir = await tmp();
    const store = createSecretStore({ dataDir, platform: 'linux' });
    expect(store.backend).toBe('file');
    await store.set('a', '1');
    await store.set('a', '2');
    expect(await store.get('a')).toBe('2');
    expect(await store.list()).toEqual(['a']);
    await store.delete('missing');
    await store.delete('a');
    expect(await store.list()).toEqual([]);
    await expect(store.set('', 'x')).rejects.toThrow();
  });

  it('secret://ref 解析:合法 ref 通过,非法形态返回 undefined(兼容明文)', () => {
    expect(parseSecretRef('secret://mem0-prod')).toEqual({ ref: 'mem0-prod' });
    expect(parseSecretRef('secret://a.b_c-1')).toEqual({ ref: 'a.b_c-1' });
    expect(parseSecretRef('sk-plain-key')).toBeUndefined();
    expect(parseSecretRef('secret://has space')).toBeUndefined();
    expect(parseSecretRef('secret://')).toBeUndefined();
  });

  it('日志脱敏:密钥样文本被替换;异常回占位符不泄原文', () => {
    const out = scrubSecretsForLog('request failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(out).toContain('REDACTED');
    expect(scrubSecretsForLog('普通文本不受影响')).toBe('普通文本不受影响');
  });
});
