import type { MemoryLogger } from '../types.js';
import { type FileLockOptions } from './lock.js';
export declare function ensureDir(dir: string): Promise<void>;
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
export declare function syncDirectory(dir: string, logger?: MemoryLogger): Promise<boolean>;
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
export declare function atomicWriteText(file: string, content: string, opts?: AtomicWriteOptions): Promise<void>;
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
export declare function cleanupOrphanTmp(dataDir: string, logger?: MemoryLogger): Promise<number>;
/**
 * 严格 JSON 读的四态结果。
 *
 * 与 `readJsonIfExists` 的关键差别:**损坏不再被压成「不存在」**——调用方必须
 * 显式处理 `corrupt` / `unreadable`,否则会拿默认值去 `save()` 把原文件洗掉。
 */
export type JsonReadResult<T> = {
    ok: true;
    value: T;
    version?: number;
} | {
    ok: false;
    reason: 'missing' | 'unreadable' | 'corrupt' | 'unknown_version';
    detail?: string;
};
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
export declare function readJsonStrict<T>(file: string, opts?: ReadJsonStrictOptions): Promise<JsonReadResult<T>>;
/** 原子写 JSON(两空格缩进,人工可查);写前做覆盖保护(见 `guardAgainstCorrupt`)。 */
export declare function atomicWriteJson(file: string, value: unknown, opts?: AtomicWriteOptions): Promise<void>;
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
export declare function rmwJson<T, R>(file: string, decide: (current: JsonReadResult<T>) => Promise<{
    next?: T;
    result: R;
}>, opts?: FileLockOptions): Promise<R>;
/**
 * @deprecated 保留供历史调用方,**禁止新增使用**:它把「不存在 / 不可读 / JSON 损坏」
 * 压成同一个 `undefined`(findings §2)。新代码一律用 `readJsonStrict`。
 */
export declare function readJsonIfExists<T>(file: string): Promise<T | undefined>;
export declare function readTextIfExists(file: string): Promise<string | undefined>;
/** 追加 JSONL 行(存在则追加,否则创建);空数组零副作用。 */
export declare function appendJsonl(file: string, lines: unknown[]): Promise<void>;
/** 读取 JSONL 全部行(坏行跳过,不抛出)。 */
export declare function readJsonl<T>(file: string): Promise<T[]>;
export declare function nowIso(): string;
/** 本地时区的 YYYY-MM-DD 键(L0/L1 按天分文件的文件名来源)。 */
export declare function dayKey(ts: number): string;
