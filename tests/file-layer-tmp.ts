/**
 * 文件层加固测试共用的临时目录。
 *
 * ⚠️ **故意不清理**。本机实测单次 `unlink` 要 1.6s(C:\TEMP)～5.4s(E:)、
 * `rmdir` 0.15～5s,删二十个文件就是 30–60s —— vitest 默认 hook 超时 10s 必爆,
 * 结果是「用例全过、文件被判失败」。等删除纯属浪费时间。
 *
 * 换目录即可:每次运行新开一个 `mkdtemp`,把路径 append 到
 * `evidence/cleanup-pending.txt`,事后要清理由人自行处理(或随系统 Temp 清理)。
 */
import { appendFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PENDING_LIST = fileURLToPath(
  new URL('../.agents/plans/file-layer-hardening/evidence/cleanup-pending.txt', import.meta.url),
);

let root: string | undefined;

/** 本次运行的临时根目录下的子目录(不存在则创建)。 */
export async function flTmp(name: string): Promise<string> {
  if (!root) {
    root = await mkdtemp(join(tmpdir(), 'file-layer-'));
    await appendFile(PENDING_LIST, `${new Date().toISOString()}\t${root}\n`, 'utf8').catch(() => {});
  }
  const d = join(root, name);
  await mkdir(d, { recursive: true });
  return d;
}
