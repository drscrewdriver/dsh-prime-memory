/**
 * wing 词表迁移(task_14):v0.12 5 值词表 → 8 角 + general 跨域兜底的**有界 targeted pass**。
 *
 * 关键事实(决定本迁移的形态):
 * - 4 个保留 id(work/relationships/finance/journey)在新词表下仍是合法角,**存量标签零改动**;
 * - `general` 保留为跨域兜底值(不重写、不删除);
 * - 4 个新角无存量。因此本迁移**不改任何行的 wing 值**——它做的是:
 *   ① 备份 metadata_json(apply 模式);② **扫 L1 主表全量(含 retired 行)**逐行核对;
 *   ③ 落报告:逐值计数(含 null)/活性与 retired 拆分/未知值清单。
 *
 * 幂等:连续执行两次报告一致(扫描是纯读)。共享扫描函数 = `MemoryDb.scanL1Metadata`
 * (单一所有者;计划 B 的引用门禁复用同一函数,不写第二份扫描)。
 */
import { openSync, closeSync, writeSync, existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { MemoryDb } from './store/sqlite.js';
import { WING_CATALOG, WING_FALLBACK } from './types.js';
/** 新词表下的全部合法 wing 值(8 角 + 跨域兜底)。 */
export const WING_VALID_VALUES = [...WING_CATALOG.map((h) => h.id), WING_FALLBACK];
export function runWingMigration(opts) {
    const db = new MemoryDb(opts.dbPath, 0, opts.logger);
    // 开库即建表/补列(CREATE TABLE IF NOT EXISTS 惯例);未 init 则句柄未打开,扫描恒 0
    db.init();
    try {
        const report = {
            dbPath: opts.dbPath,
            dryRun: !!opts.dryRun,
            total: 0,
            retired: 0,
            active: 0,
            byWing: {},
            unlabeled: 0,
            unknownValues: {},
            corruptMetadata: 0,
            backupPath: null,
            verdict: 'expected',
        };
        let backupFd = null;
        if (!report.dryRun) {
            const dir = opts.backupDir ?? path.join(path.dirname(opts.dbPath), 'wing-migrate-backup');
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            const backupPath = path.join(dir, `metadata-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
            backupFd = openSync(backupPath, 'w');
            report.backupPath = backupPath;
        }
        try {
            report.total = db.scanL1Metadata((recordId, metadata) => {
                const wing = metadata && typeof metadata.hall === 'string' && metadata.hall !== '' ? metadata.hall : null;
                // metadata 缺失/解析失败与"无 wing"同样计入未打标(存量 524 null 的主口径)
                // 备份:原始 metadata_json 原样落盘(apply 模式;dry-run 不写任何文件)
                if (backupFd !== null) {
                    writeSync(backupFd, JSON.stringify({ recordId, metadata }) + '\n');
                }
                if (wing === null) {
                    report.unlabeled++;
                }
                else {
                    report.byWing[wing] = (report.byWing[wing] ?? 0) + 1;
                    if (!WING_VALID_VALUES.includes(wing)) {
                        report.unknownValues[wing] = (report.unknownValues[wing] ?? 0) + 1;
                    }
                }
            });
            // retired 拆分:退场判定与存储层同口径(valid_to 非空 ∨ dsh_superseded 标记)。
            // 扫描本身**不加过滤**(全表 SELECT 自动覆盖 retired),这里仅分类计数。
            report.active = report.total - countRetired(db);
            report.retired = report.total - report.active;
        }
        finally {
            if (backupFd !== null)
                closeSync(backupFd);
        }
        report.verdict = Object.keys(report.unknownValues).length > 0 ? 'unknown-values' : 'expected';
        return report;
    }
    finally {
        db.close();
    }
}
/** retired 行计数(与 sqlite 层退场判定同口径;用于验证"全量扫描不漏 retired")。 */
function countRetired(db) {
    // 借道 scanL1Metadata 之外的轻量路径不可得(retired 判定在行级字段),
    // 这里直接用 wingL1Counts 的同族 SQL:valid_to 非空 ∨ metadata 带 dsh_superseded。
    // 为保持"单一所有者",经由 scanL1Metadata 之外不再开第二条 SQL——改为返回占位 0,
    // 由 retire 拆分调用方(db.retiredL1Count)提供。
    return db.retiredL1Count();
}
