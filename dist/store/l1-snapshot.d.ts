import type { MemoryRecord } from '../types.js';
export declare const SNAPSHOT_VERSION = 1;
/** 快照里的一节:行数 + 内容哈希。哈希是"内容有没有变"的判据,行数看不出来。 */
export interface SnapshotSection {
    count: number;
    hash: string;
}
/** 快照清单(可追溯:什么时候、为什么、各节多大)。 */
export interface L1SnapshotManifest {
    version: 1;
    createdAt: string;
    /** 为什么建这份快照(如 `pre-rebuild`),便于事后定位。 */
    reason: string;
    sections: {
        records: SnapshotSection;
        receipts: SnapshotSection;
        conflicts: SnapshotSection;
    };
    /** `l1_vec` 行数(只记数:它是派生投影,可重算,不落快照)。 */
    vecCount: number;
}
/** 快照目录名:`l1-<时间戳>-<原因>`。**时间戳在前**,目录自然按时间排序。 */
export declare function snapshotDirName(createdAt: Date, reason: string): string;
/** 快照目录的绝对路径(与既有 `pendingPathFor` / `reconcileStatePathFor` 同风格)。 */
export declare function snapshotPathFor(dataDir: string, createdAt: Date, reason: string): string;
/** 稳定内容哈希(与 `canonicalRecords` 配套:同内容恒同哈希)。 */
export declare function hashRecords(records: readonly MemoryRecord[]): string;
/** 任意对象的内容哈希(用于 receipts / conflicts 这类外来形状)。 */
export declare function hashJson(value: unknown): string;
/** `MemoryDb` 里本模块用到的最小面(便于单测注入)。 */
export interface SnapshotDbLike {
    listL1: (opts: {
        limit: number;
        offset: number;
    }) => {
        items: readonly MemoryRecord[];
        total: number;
    };
    countReceipts: (opts: Record<string, never>) => number;
    listReceipts: (opts: {
        limit: number;
    }) => readonly unknown[];
    countConflictPendingUnresolved: () => number;
    listConflictPending: (opts?: {
        limit?: number;
    }) => readonly unknown[];
    countL1Vec: () => number;
    upsertL1: (record: MemoryRecord) => boolean;
}
/** 分页取全量 L1(一次 500,避免大库一次性拉爆内存)。 */
export declare function listAllL1(db: SnapshotDbLike, hardLimit?: number): MemoryRecord[];
export interface CreateSnapshotResult {
    dir: string;
    manifest: L1SnapshotManifest;
    records: readonly MemoryRecord[];
}
/**
 * 建快照。**在任何清空动作之前调用。**
 *
 * @param db - 记忆库。
 * @param dir - 快照目录(调用方用 `snapshotPathFor` 生成)。
 * @param reason - 建快照的原因(写进清单,可追溯)。
 * @param now - 注入时钟(单测用)。
 */
export declare function createL1Snapshot(db: SnapshotDbLike, dir: string, reason: string, now?: Date): Promise<CreateSnapshotResult>;
/** 读快照清单;不存在或版本不符返回 undefined。 */
export declare function readSnapshotManifest(dir: string): Promise<L1SnapshotManifest | undefined>;
/** 读回快照里的记录(与 `createL1Snapshot` 的写入格式必须成对:`atomicWriteJson` ↔ `readJsonIfExists`)。 */
export declare function readSnapshotRecords(dir: string): Promise<MemoryRecord[]>;
/** 快照与当前库的差异。 */
export interface SnapshotVerification {
    ok: boolean;
    diffs: string[];
}
/** 比对快照与当前库(**按内容哈希**,不是按行数)。 */
export declare function verifySnapshot(db: SnapshotDbLike, dir: string): Promise<SnapshotVerification>;
export interface RestoreResult {
    restored: number;
    failed: number;
}
/**
 * 从快照恢复 L1。
 *
 * **幂等**:走 `upsertL1`(按 id upsert),恢复两遍与一遍等价,中断后重跑安全。
 * 只恢复 `l1_records`——receipts / conflicts 今天不被 `clearL1()` 销毁(见模块头),
 * 且它们的写入口不归本模块所有(单一所有者)。
 */
export declare function restoreL1Snapshot(db: SnapshotDbLike, dir: string, logger?: {
    info: (m: string) => void;
    warn: (m: string) => void;
}): Promise<RestoreResult>;
/**
 * 清空前必须调用的守门函数:先建快照,再允许清空。
 *
 * 抽出来是为了让"先快照后清空"成为**调用方无法绕过的一步**,而不是一段注释。
 *
 * @returns 快照目录与清单;调用方拿到后才可以继续清空。
 */
export declare function snapshotBeforeClear(db: SnapshotDbLike, dataDir: string, reason: string, now?: Date): Promise<CreateSnapshotResult>;
