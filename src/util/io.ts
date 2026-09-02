/**
 * 持久化工具:原子写(tmp + fsync + rename)与 JSON/JSONL 读写。
 *
 * JSONL 追加是热路径(每轮对话一次),走 OS 写回不加 fsync——逐条 fsync 的延迟
 * 代价大于崩溃窗口丢尾部几行的损失;状态文件则必须原子写,防半截状态。
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * 原子写文本文件。tmp 写满后先 fsync 数据块再 rename——否则断电时文件系统可能
 * 先持久化 rename 元数据、后持久化数据块(ext4 delayed allocation / NTFS 均可能),
 * 目标文件变成空文件或半截。tmp 名带随机段防同毫秒碰撞;失败路径清理孤儿 tmp。
 */
export async function atomicWriteText(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf-8');
    const fh = await fs.open(tmp, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** 原子写 JSON(两空格缩进,人工可查)。 */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteText(file, JSON.stringify(value, null, 2));
}

export async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return undefined;
  }
}

/** 追加 JSONL 行(存在则追加,否则创建);空数组零副作用。 */
export async function appendJsonl(file: string, lines: unknown[]): Promise<void> {
  if (lines.length === 0) return;
  await ensureDir(path.dirname(file));
  const payload = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await fs.appendFile(file, payload, 'utf-8');
}

/** 读取 JSONL 全部行(坏行跳过,不抛出)。 */
export async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const out: T[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as T);
      } catch {
        // 跳过坏行
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 本地时区的 YYYY-MM-DD 键(L0/L1 按天分文件的文件名来源)。 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
