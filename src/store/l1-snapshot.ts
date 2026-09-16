/**
 * L1 全库快照与恢复路径(task_8c-1)——破坏性重建的**准入条件**。
 *
 * ## 为什么单独立项
 * `MemoryDb.clearL1()`(`store/sqlite.ts:1046-1069`)是**不可逆**的。它实际销毁的
 * 不止 `l1_records`:还含 `l1_fts`、`l1_vec`(DROP + 重建)与**图谱表族**
 * (`graphStore.resetAll()`)。测试与实机都可能跑在真实库上——**没有恢复路径就
 * 不允许动 `rebuild.ts`**,所以快照不是"附带产物",是前置。
 *
 * ## 代码事实(纠正计划里的旧表述)
 * 计划里写的是"清空 L1 三表(`l1_records` / `l1_receipts` / `conflict_pending`)"。
 * **读 `clearL1()` 的函数体**(`store/sqlite.ts:1046-1069`)得到的结论不是这样:它
 * 只 `DELETE FROM l1_records` + `l1_fts`,再加 `graphStore.resetAll()` 与 `l1_vec`
 * 的 DROP + 重建——**SQL 里没有 receipts 与 conflict_pending**。故本模块按**实际
 * 销毁面**分级:
 * - `l1_records`:**全量可恢复**(丢的就是它)
 * - `l1_receipts` / `conflict_pending`:快照**内容与哈希**。按当前代码不被清,故不
 *   需要恢复;快照它们的意义是"将来谁改了 `clearL1()` 的销毁面,这里能立刻看出来",
 *   同时给运维一份拷贝
 * - `l1_vec`:**不落快照**。它是 `l1_records` 的派生投影,体积大且可重算;只记行数
 *
 * > 口径说明:以上是**读代码**结论(附行号),不是运行时实测;若要把它变成实测,
 * > 需要构造 receipts / conflict_pending 行后跑一次 `clearL1()` 再比对——那需要
 * > 这两个表各自的写入入口,归其所有者,不在本模块范围内。
 *
 * ## 恢复为什么幂等
 * 恢复走既有 `upsertL1`(按 id upsert),**不是 INSERT**。所以恢复两遍与一遍等价,
 * 中断后重跑也安全。
 *
 * ## 红线:恢复必须保住锚点
 * 锚点在 `metadata_json` 的保留键 `dsh_source_anchors` 里(task_31)。记录过一遍
 * JSON 往返再 upsert,**锚点必须原样还在**——否则恢复出来的记忆再也无法取证,
 * 等于把证据链悄悄拆了。这条有专门用例。
 */
import { createHash } from 'node:crypto';
import { atomicWriteJson, readJsonIfExists } from '../util/io.js';
import type { MemoryRecord } from '../types.js';

export const SNAPSHOT_VERSION = 1;

/** 快照里的一节:行数 + 内容哈希。哈希是"内容有没有变"的判据,行数看不出来。 */
export interface SnapshotSection {
  count: number
  hash: string
}

/** 快照清单(可追溯:什么时候、为什么、各节多大)。 */
export interface L1SnapshotManifest {
  version: 1
  createdAt: string
  /** 为什么建这份快照(如 `pre-rebuild`),便于事后定位。 */
  reason: string
  sections: {
    records: SnapshotSection
    receipts: SnapshotSection
    conflicts: SnapshotSection
  }
  /** `l1_vec` 行数(只记数:它是派生投影,可重算,不落快照)。 */
  vecCount: number
}

/** 快照目录名:`l1-<时间戳>-<原因>`。**时间戳在前**,目录自然按时间排序。 */
export function snapshotDirName(createdAt: Date, reason: string): string {
  const stamp = createdAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const slug = reason.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'snapshot';
  return `l1-${stamp}-${slug}`;
}

/** 快照目录的绝对路径(与既有 `pendingPathFor` / `reconcileStatePathFor` 同风格)。 */
export function snapshotPathFor(dataDir: string, createdAt: Date, reason: string): string {
  return `${dataDir.replace(/[\\/]+$/, '')}/snapshots/${snapshotDirName(createdAt, reason)}`;
}

/** 记录数组的规范序列化:键序固定 + 按 id 排序,保证**同一内容恒得同一哈希**。 */
function canonicalRecords(records: readonly MemoryRecord[]): string {
  return JSON.stringify(
    records
      .map((r) => ({
        id: r.id,
        content: r.content,
        type: r.type,
        priority: r.priority,
        scene_name: r.scene_name,
        timestamps: r.timestamps,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        version: r.version,
        metadata: r.metadata ?? {},
        sessionId: r.sessionId,
        family: r.family,
        // 时间演进字段(R3)也进哈希:它们改了同样是"静默改写",必须被 verify 抓到
        validFrom: r.validFrom,
        validTo: r.validTo,
        persistence: r.persistence,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

/** 稳定内容哈希(与 `canonicalRecords` 配套:同内容恒同哈希)。 */
export function hashRecords(records: readonly MemoryRecord[]): string {
  return createHash('sha1').update(canonicalRecords(records), 'utf8').digest('hex');
}

/** 任意对象的内容哈希(用于 receipts / conflicts 这类外来形状)。 */
export function hashJson(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value), 'utf8').digest('hex');
}

/** `MemoryDb` 里本模块用到的最小面(便于单测注入)。 */
export interface SnapshotDbLike {
  listL1: (opts: { limit: number; offset: number }) => { items: readonly MemoryRecord[]; total: number }
  countReceipts: (opts: Record<string, never>) => number
  listReceipts: (opts: { limit: number }) => readonly unknown[]
  countConflictPendingUnresolved: () => number
  listConflictPending: (opts?: { limit?: number }) => readonly unknown[]
  countL1Vec: () => number
  upsertL1: (record: MemoryRecord) => boolean
}

const PAGE = 500;

/** 分页取全量 L1(一次 500,避免大库一次性拉爆内存)。 */
export function listAllL1(db: SnapshotDbLike, hardLimit = 100_000): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  for (let offset = 0; offset < hardLimit; offset += PAGE) {
    const page = db.listL1({ limit: PAGE, offset });
    out.push(...page.items);
    if (page.items.length < PAGE) break;
  }
  return out;
}

export interface CreateSnapshotResult {
  dir: string
  manifest: L1SnapshotManifest
  records: readonly MemoryRecord[]
}

/**
 * 建快照。**在任何清空动作之前调用。**
 *
 * @param db - 记忆库。
 * @param dir - 快照目录(调用方用 `snapshotPathFor` 生成)。
 * @param reason - 建快照的原因(写进清单,可追溯)。
 * @param now - 注入时钟(单测用)。
 */
export async function createL1Snapshot(
  db: SnapshotDbLike,
  dir: string,
  reason: string,
  now: Date = new Date(),
): Promise<CreateSnapshotResult> {
  const records = listAllL1(db);
  const receipts = db.listReceipts({ limit: 100_000 });
  const conflicts = db.listConflictPending({ limit: 100_000 });
  const manifest: L1SnapshotManifest = {
    version: SNAPSHOT_VERSION,
    createdAt: now.toISOString(),
    reason,
    sections: {
      records: { count: records.length, hash: hashRecords(records) },
      receipts: { count: receipts.length, hash: hashJson(receipts) },
      conflicts: { count: conflicts.length, hash: hashJson(conflicts) },
    },
    vecCount: db.countL1Vec(),
  };
  // 先写正文再写清单:清单存在即代表正文完整(反过来的话,清单会指向半截快照)
  await atomicWriteJson(`${dir}/l1-records.json`, records);
  await atomicWriteJson(`${dir}/l1-receipts.json`, receipts);
  await atomicWriteJson(`${dir}/l1-conflicts.json`, conflicts);
  await atomicWriteJson(`${dir}/manifest.json`, manifest);
  return { dir, manifest, records };
}

/** 读快照清单;不存在或版本不符返回 undefined。 */
export async function readSnapshotManifest(dir: string): Promise<L1SnapshotManifest | undefined> {
  const raw = await readJsonIfExists<Partial<L1SnapshotManifest>>(`${dir}/manifest.json`);
  if (!raw || raw.version !== SNAPSHOT_VERSION) return undefined;
  return raw as L1SnapshotManifest;
}

/** 读回快照里的记录(与 `createL1Snapshot` 的写入格式必须成对:`atomicWriteJson` ↔ `readJsonIfExists`)。 */
export async function readSnapshotRecords(dir: string): Promise<MemoryRecord[]> {
  const raw = await readJsonIfExists<MemoryRecord[]>(`${dir}/l1-records.json`);
  return Array.isArray(raw) ? raw : [];
}

/** 快照与当前库的差异。 */
export interface SnapshotVerification {
  ok: boolean
  diffs: string[]
}

/** 比对快照与当前库(**按内容哈希**,不是按行数)。 */
export async function verifySnapshot(db: SnapshotDbLike, dir: string): Promise<SnapshotVerification> {
  const manifest = await readSnapshotManifest(dir);
  if (manifest === undefined) return { ok: false, diffs: ['快照清单缺失或版本不符'] };
  const now = listAllL1(db);
  const diffs: string[] = [];
  const currentHash = hashRecords(now);
  if (currentHash !== manifest.sections.records.hash) {
    diffs.push(`l1_records 内容不一致:快照 ${manifest.sections.records.hash.slice(0, 8)} / 当前 ${currentHash.slice(0, 8)}(快照 ${manifest.sections.records.count} 条,当前 ${now.length} 条)`);
  }
  const receipts = hashJson(db.listReceipts({ limit: 100_000 }));
  if (receipts !== manifest.sections.receipts.hash) diffs.push('l1_receipts 内容与快照不一致');
  const conflicts = hashJson(db.listConflictPending({ limit: 100_000 }));
  if (conflicts !== manifest.sections.conflicts.hash) diffs.push('conflict_pending 内容与快照不一致');
  return { ok: diffs.length === 0, diffs };
}

export interface RestoreResult {
  restored: number
  failed: number
}

/**
 * 从快照恢复 L1。
 *
 * **幂等**:走 `upsertL1`(按 id upsert),恢复两遍与一遍等价,中断后重跑安全。
 * 只恢复 `l1_records`——receipts / conflicts 今天不被 `clearL1()` 销毁(见模块头),
 * 且它们的写入口不归本模块所有(单一所有者)。
 */
export async function restoreL1Snapshot(
  db: SnapshotDbLike,
  dir: string,
  logger?: { info: (m: string) => void; warn: (m: string) => void },
): Promise<RestoreResult> {
  const records = await readSnapshotRecords(dir);
  let restored = 0;
  let failed = 0;
  for (const record of records) {
    if (typeof record?.id !== 'string' || typeof record.content !== 'string') {
      failed += 1;
      continue;
    }
    if (db.upsertL1(record)) restored += 1;
    else failed += 1;
  }
  if (failed > 0) logger?.warn(`[memory] 快照恢复:${restored} 条成功,${failed} 条失败`);
  else logger?.info(`[memory] 快照恢复:${restored} 条`);
  return { restored, failed };
}

/**
 * 清空前必须调用的守门函数:先建快照,再允许清空。
 *
 * 抽出来是为了让"先快照后清空"成为**调用方无法绕过的一步**,而不是一段注释。
 *
 * @returns 快照目录与清单;调用方拿到后才可以继续清空。
 */
export async function snapshotBeforeClear(
  db: SnapshotDbLike,
  dataDir: string,
  reason: string,
  now: Date = new Date(),
): Promise<CreateSnapshotResult> {
  const dir = snapshotPathFor(dataDir, now, reason);
  return createL1Snapshot(db, dir, reason, now);
}
