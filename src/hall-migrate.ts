/**
 * hall 词表迁移(task_14):v0.12 5 值词表 → 8 角 + general 跨域兜底的**有界 targeted pass**。
 *
 * 关键事实(决定本迁移的形态):
 * - 4 个保留 id(work/relationships/finance/journey)在新词表下仍是合法角,**存量标签零改动**;
 * - `general` 保留为跨域兜底值(不重写、不删除);
 * - 4 个新角无存量。因此本迁移**不改任何行的 hall 值**——它做的是:
 *   ① 备份 metadata_json(apply 模式);② **扫 L1 主表全量(含 retired 行)**逐行核对;
 *   ③ 落报告:逐值计数(含 null)/活性与 retired 拆分/未知值清单。
 *
 * 幂等:连续执行两次报告一致(扫描是纯读)。共享扫描函数 = `MemoryDb.scanL1Metadata`
 * (单一所有者;计划 B 的引用门禁复用同一函数,不写第二份扫描)。
 */
import { openSync, closeSync, writeSync, existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { MemoryDb } from './store/sqlite.js';
import { HALL_CATALOG, HALL_FALLBACK } from './types.js';
import type { MemoryLogger } from './types.js';

/** 新词表下的全部合法 hall 值(8 角 + 跨域兜底)。 */
export const HALL_VALID_VALUES: readonly string[] = [...HALL_CATALOG.map((h) => h.id), HALL_FALLBACK];

export interface HallMigrationReport {
  dbPath: string;
  dryRun: boolean;
  /** 主表全量行数(含 retired;与 hallL1Counts 的扫描口径一致)。 */
  total: number;
  /** retired 行数(valid_to 非空或带退场标记——迁移**不加过滤**,全量扫描自动覆盖)。 */
  retired: number;
  active: number;
  /** 逐值计数(含 retired 行;null 单列)。 */
  byHall: Record<string, number>;
  unlabeled: number;
  /** 不在新词表内的历史值(按 R10 不删已有标签,仅报告)。 */
  unknownValues: Record<string, number>;
  /** metadata 解析失败的行数(备份仍写入原始 JSON)。 */
  corruptMetadata: number;
  /** apply 模式写出的备份文件路径(dry-run 为 null)。 */
  backupPath: string | null;
  /** 结论:expected = 全部值合法(迁移无需改写);unknown = 存在历史遗留值(已报告,保留)。 */
  verdict: 'expected' | 'unknown-values';
}

export interface HallMigrationOptions {
  dbPath: string;
  /** true = 只读报告,不写备份;false = 先备份 metadata_json 再出报告。 */
  dryRun?: boolean;
  /** 备份输出目录(缺省 = db 同目录 hall-migrate-backup/)。 */
  backupDir?: string;
  logger?: MemoryLogger;
}

export function runHallMigration(opts: HallMigrationOptions): HallMigrationReport {
  const db = new MemoryDb(opts.dbPath, 0, opts.logger);
  // 开库即建表/补列(CREATE TABLE IF NOT EXISTS 惯例);未 init 则句柄未打开,扫描恒 0
  db.init();
  try {
    const report: HallMigrationReport = {
      dbPath: opts.dbPath,
      dryRun: !!opts.dryRun,
      total: 0,
      retired: 0,
      active: 0,
      byHall: {},
      unlabeled: 0,
      unknownValues: {},
      corruptMetadata: 0,
      backupPath: null,
      verdict: 'expected',
    };

    let backupFd: number | null = null;
    if (!report.dryRun) {
      const dir = opts.backupDir ?? path.join(path.dirname(opts.dbPath), 'hall-migrate-backup');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const backupPath = path.join(dir, `metadata-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
      backupFd = openSync(backupPath, 'w');
      report.backupPath = backupPath;
    }

    try {
      report.total = db.scanL1Metadata((recordId, metadata) => {
        const hall = metadata && typeof metadata.hall === 'string' && metadata.hall !== '' ? metadata.hall : null;
        // metadata 缺失/解析失败与"无 hall"同样计入未打标(存量 524 null 的主口径)
        // 备份:原始 metadata_json 原样落盘(apply 模式;dry-run 不写任何文件)
        if (backupFd !== null) {
          writeSync(backupFd, JSON.stringify({ recordId, metadata }) + '\n');
        }
        if (hall === null) {
          report.unlabeled++;
        } else {
          report.byHall[hall] = (report.byHall[hall] ?? 0) + 1;
          if (!HALL_VALID_VALUES.includes(hall)) {
            report.unknownValues[hall] = (report.unknownValues[hall] ?? 0) + 1;
          }
        }
      });
      // retired 拆分:退场判定与存储层同口径(valid_to 非空 ∨ dsh_superseded 标记)。
      // 扫描本身**不加过滤**(全表 SELECT 自动覆盖 retired),这里仅分类计数。
      report.active = report.total - countRetired(db);
      report.retired = report.total - report.active;
    } finally {
      if (backupFd !== null) closeSync(backupFd);
    }

    report.verdict = Object.keys(report.unknownValues).length > 0 ? 'unknown-values' : 'expected';
    return report;
  } finally {
    db.close();
  }
}

/** retired 行计数(与 sqlite 层退场判定同口径;用于验证"全量扫描不漏 retired")。 */
function countRetired(db: MemoryDb): number {
  // 借道 scanL1Metadata 之外的轻量路径不可得(retired 判定在行级字段),
  // 这里直接用 hallL1Counts 的同族 SQL:valid_to 非空 ∨ metadata 带 dsh_superseded。
  // 为保持"单一所有者",经由 scanL1Metadata 之外不再开第二条 SQL——改为返回占位 0,
  // 由 retire 拆分调用方(db.retiredL1Count)提供。
  return db.retiredL1Count();
}
