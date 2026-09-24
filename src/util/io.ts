/**
 * 持久化工具:原子写(tmp + fsync + rename + 目录 fsync)与 JSON/JSONL 读写。
 *
 * JSONL 追加是热路径(每轮对话一次),走 OS 写回不加 fsync——逐条 fsync 的延迟
 * 代价大于崩溃窗口丢尾部几行的损失;状态文件则必须原子写,防半截状态。
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MemoryLogger } from '../types.js';
import { withFileLock, type FileLockOptions } from './lock.js';
import { assertSafePath, UnsafePathError } from './path-guard.js';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * 目录 fsync:让刚完成的 rename 目录项也落盘。
 *
 * 只 fsync 文件数据块是不够的——目录项(即"这个名字指向哪个 inode")是目录自己的
 * 数据。断电时可能出现「文件数据已在盘上、目录项还没更新」或反之,目标文件因此
 * 退回旧内容(原子性仍成立:要么是旧内容、要么是新内容,不会是半截)。
 *
 * **平台语义(冻结)**:NTFS/Windows 上无法以读方式打开目录(open 即 EISDIR/EPERM),
 * 且该语义本身不存在 → **win32 直接 return**。因此断电验收在 win32 只能覆盖
 * 「rename 原子性 + 孤儿 tmp 清理」,不得声称目录 fsync 已验证(见 spec §3 L1)。
 *
 * @returns 是否真的做了 fsync(win32 恒 false)。
 */
export async function syncDirectory(dir: string, logger?: MemoryLogger): Promise<boolean> {
  if (process.platform === 'win32') return false;
  let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
    return true;
  } catch (err) {
    // 失败策略(spec §3 L1 决策):**吞 + warn,不抛**。
    // 理由:① 走到这里时数据块已 fsync、rename 已成功,目标文件是完整新内容——
    // 最坏结果是崩溃后退回旧内容(要么旧要么新,不存在半截);② 抛出去会让
    // state.save() 之类的调用方把"已写成功"当失败处理,为已无补救动作的元数据
    // 落盘去打断主流程,性价比是负的。代价是必须留下可观测诊断(绝不静默跳过)。
    logger?.warn(
      `[memory] 目录 fsync 失败(文件数据已 fsync,崩溃时可能退回旧内容): ${dir} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** 原子写的附带选项。 */
export interface AtomicWriteOptions {
  /** 诊断口:目录 fsync 失败等"吞掉但必须可观测"的情形走它。 */
  logger?: MemoryLogger;
  /** 覆盖保护开关(默认开):目标存在但读不出时拒绝写。见 `guardAgainstCorrupt`。 */
  overwriteGuard?: boolean;
}

/**
 * 原子写文本文件。tmp 写满后先 fsync 数据块再 rename,最后 fsync 目录(见
 * `syncDirectory`)——否则断电时文件系统可能先持久化 rename 元数据、后持久化
 * 数据块(ext4 delayed allocation / NTFS 均可能),目标文件变成空文件或半截。
 * tmp 名带随机段防同毫秒碰撞;失败路径清理孤儿 tmp。
 */
export async function atomicWriteText(file: string, content: string, opts: AtomicWriteOptions = {}): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  // 路径安全(T5):父目录是 symlink / 目标是 symlink 或非普通文件 → 拒绝。
  // 否则 rename 会把内容搬到链接指向的别处,或被引导去覆盖无关文件。
  await assertSafePath(file);
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
  // rename 已成功:目录 fsync 失败不再回滚(数据已完整落盘),只留诊断。
  await syncDirectory(dir, opts.logger);
}


/** 本插件原子写的 tmp 命名规则(`<target>.<pid>.<hex8>.tmp`),孤儿清理只认这个形状。 */
const TMP_NAME_RE = /^(.+)\.(\d+)\.([0-9a-f]{8})\.tmp$/;
/**
 * 收编前的遗留固定名:唯一用过 `this.file + '.tmp'` 的是 embedding-source
 * (`store/embedding-source.ts` 旧 `persist()`)。**按名精确匹配**,不搞 `*.tmp` 通配——
 * 否则会删掉数据目录里任何第三方留下的 `.tmp`。
 */
const LEGACY_TMP_NAMES = new Set(['embedding-source.json.tmp']);
/** 这些子树体量大且非状态目录(运行时/模型),启动扫描跳过。 */
const SCAN_SKIP_DIRS = new Set(['runtime', 'node_modules', 'models', 'onnx', '.git']);

/**
 * 启动期孤儿 tmp 清理。
 *
 * 原子写在失败路径已 unlink,但**进程被 kill -9 / 断电**时 tmp 会留下。
 * 残留本身无害(不参与任何读路径),积多了却会让"数据目录里躺着一堆 .tmp"
 * 变成噪音,且旧版本固定名 tmp 有被下一次写复用(撞名)的风险。
 *
 * 只认本插件命名规则(见 `TMP_NAME_RE` / `LEGACY_TMP_NAME_RE`),不碰其它 `.tmp`,
 * 每条清理**都记诊断**(不静默删);跳过 runtime/models 等大体量子树。
 *
 * @returns 清理条数。
 */
export async function cleanupOrphanTmp(dataDir: string, logger?: MemoryLogger): Promise<number> {
  let removed = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不可读/不存在:启动期不因清理失败而阻断
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(e.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!TMP_NAME_RE.test(e.name) && !LEGACY_TMP_NAMES.has(e.name)) continue;
      try {
        await fs.unlink(full);
        removed++;
        logger?.info(`[memory] 启动清理孤儿临时文件: ${full}`);
      } catch (err) {
        logger?.warn(
          `[memory] 孤儿临时文件清理失败: ${full} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  await walk(dataDir, 0);
  if (removed > 0) logger?.info(`[memory] 启动清理孤儿临时文件 ${removed} 个`);
  return removed;
}

/**
 * 严格 JSON 读的四态结果。
 *
 * 与 `readJsonIfExists` 的关键差别:**损坏不再被压成「不存在」**——调用方必须
 * 显式处理 `corrupt` / `unreadable`,否则会拿默认值去 `save()` 把原文件洗掉。
 */
export type JsonReadResult<T> =
  | { ok: true; value: T; version?: number }
  | { ok: false; reason: 'missing' | 'unreadable' | 'corrupt' | 'unknown_version'; detail?: string };

export interface ReadJsonStrictOptions {
  /**
   * 期望的版本号(可多个)。**传了才可能产出 `unknown_version`**;
   * 不传时版本只经 `version` 字段回传,不做判定(判定责任划分见 spec §3 L3)。
   */
  expectedVersion?: number | readonly number[];
}

/**
 * 严格 JSON 读:`missing` / `unreadable` / `corrupt` / `unknown_version` 四态可区分。
 *
 * - `missing`:ENOENT(首次运行,合法);
 * - `unreadable`:存在但读不出(权限/占用/不是文件),**不等于**没有;
 * - `corrupt`:读到了但 JSON 解析失败 —— 不得当默认值,且写侧必须拒绝覆盖(见
 *   `guardAgainstCorrupt`);
 * - `unknown_version`:仅当传了 `expectedVersion` 且不匹配(含文件根本没有 version 字段)。
 */
export async function readJsonStrict<T>(
  file: string,
  opts: ReadJsonStrictOptions = {},
): Promise<JsonReadResult<T>> {
  let raw: string;
  try {
    // 路径安全(T5):违例不抛到调用方,而是归类成 `unreadable` + 明确 detail
    // (含 violation 类型),让 store 走既有的只读降级与诊断通道。
    await assertSafePath(file);
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof UnsafePathError) return { ok: false, reason: 'unreadable', detail };
    if (code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable', detail };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return { ok: false, reason: 'corrupt', detail: err instanceof Error ? err.message : String(err) };
  }
  const version =
    parsed !== null && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'number'
      ? (parsed as { version: number }).version
      : undefined;
  if (opts.expectedVersion !== undefined) {
    const expected = Array.isArray(opts.expectedVersion) ? opts.expectedVersion : [opts.expectedVersion];
    if (version === undefined || !expected.includes(version)) {
      return {
        ok: false,
        reason: 'unknown_version',
        detail: `version=${version === undefined ? '<none>' : version}, expected=${expected.join('|')}`,
      };
    }
  }
  return { ok: true, value: parsed as T, ...(version === undefined ? {} : { version }) };
}

/**
 * 覆盖保护:目标已存在但读不出(corrupt/unreadable)时**拒绝覆盖**。
 *
 * 没有这道闸的话,一次 `load()` 把损坏当空 → `save()` 用默认值写回 = 历史永久丢失
 * 且无报错(见 findings §2.2 的危害链)。宁可拒写并让调用方降级,也不能洗掉原文件。
 *
 * 只在 `atomicWriteJson` 前调用(文本类产物无 JSON 语义,不适用)。
 */
async function guardAgainstCorrupt(file: string): Promise<void> {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return; // 不存在 → 正常首写
  }
  if (!st.isFile()) return; // 非常规文件(目录等)交给后续 rename 去失败,不在这里误判
  const r = await readJsonStrict(file);
  if (r.ok) return;
  if (r.reason === 'corrupt' || r.reason === 'unreadable') {
    throw new Error(
      `拒绝覆盖损坏/不可读的目标文件(原文件已保留): ${file} [${r.reason}${r.detail ? ` — ${r.detail}` : ''}]`,
    );
  }
}

/** 原子写 JSON(两空格缩进,人工可查);写前做覆盖保护(见 `guardAgainstCorrupt`)。 */
export async function atomicWriteJson(file: string, value: unknown, opts: AtomicWriteOptions = {}): Promise<void> {
  if (opts.overwriteGuard !== false) await guardAgainstCorrupt(file);
  await atomicWriteText(file, JSON.stringify(value, null, 2), opts);
}

/**
 * **锁内 read-modify-write**(文件层加固 T4 的核心原语)。
 *
 * 顺序保证:拿锁 → 读磁盘原文 → 交给 `decide` 决定写什么 → 落盘 → 释放锁。
 * 把"读"放进锁内是关键——否则两个进程各自读到旧值、各自算、后写的那个
 * 会把前一个的更新整块盖掉(last-writer-wins 丢更新)。
 *
 * `decide` 可以:① 返回 `next` 写回;② 返回 `next: undefined` 放弃写入(快照/降级场景);
 * ③ 抛错(并发冲突 → 调用方可观测地失败,而不是静默覆盖)。
 */
export async function rmwJson<T, R>(
  file: string,
  decide: (current: JsonReadResult<T>) => Promise<{ next?: T; result: R }>,
  opts: FileLockOptions = {},
): Promise<R> {
  const r = await withFileLock(
    file,
    async () => {
      const current = await readJsonStrict<T>(file);
      const { next, result } = await decide(current);
      if (next !== undefined) await atomicWriteJson(file, next, { logger: opts.logger });
      return result;
    },
    opts,
  );
  return r.value;
}

/**
 * @deprecated 保留供历史调用方,**禁止新增使用**:它把「不存在 / 不可读 / JSON 损坏」
 * 压成同一个 `undefined`(findings §2)。新代码一律用 `readJsonStrict`。
 */
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
