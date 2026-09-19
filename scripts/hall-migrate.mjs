#!/usr/bin/env node
/**
 * hall 词表迁移 CLI(task_14):一次性脚本,dry-run 先行。
 *
 * 用法:npm run build && node scripts/hall-migrate.mjs [--db <memory.db 路径>] [--apply] [--backup-dir <dir>]
 *   缺省 db = $DSH_HOME/memory/memory.db(dshHomePath('memory') 同口径)
 *   缺省 dry-run:只读扫描出报告,不写任何文件;--apply 才写 metadata_json 备份。
 * 退出码:0 = 报告正常(expected 或 unknown-values 已列出);非 0 = 扫描失败。
 */
import { statSync } from 'node:fs';

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const hasFlag = (name) => process.argv.includes(name);

const dryRun = !hasFlag('--apply');
let dbPath = argOf('--db');
if (!dbPath) {
  const { dshHomePath } = await import('@deepseek-ai/dsh-home-paths');
  dbPath = `${dshHomePath('memory')}/memory.db`;
}
if (!statSync(dbPath, { throwIfNoEntry: false })) {
  console.error(`db 不存在: ${dbPath}`);
  process.exit(2);
}

const { runHallMigration } = await import('../dist/hall-migrate.js');
const report = runHallMigration({
  dbPath,
  dryRun,
  backupDir: argOf('--backup-dir'),
});

console.log(JSON.stringify(report, null, 2));
console.log(
  report.dryRun
    ? `\n[dry-run] 未写任何文件。加 --apply 写 metadata_json 备份(本迁移不改任何 hall 值)。`
    : `\n[apply] 备份已写入: ${report.backupPath ?? '(无)'}`,
);
if (Object.keys(report.unknownValues).length > 0) {
  console.log('存在词表外历史值(按 R10 保留,已逐值计数,不自动改写):', report.unknownValues);
}
