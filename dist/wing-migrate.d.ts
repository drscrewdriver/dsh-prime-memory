import type { MemoryLogger } from './types.js';
/** 新词表下的全部合法 wing 值(8 角 + 跨域兜底)。 */
export declare const WING_VALID_VALUES: readonly string[];
export interface HallMigrationReport {
    dbPath: string;
    dryRun: boolean;
    /** 主表全量行数(含 retired;与 wingL1Counts 的扫描口径一致)。 */
    total: number;
    /** retired 行数(valid_to 非空或带退场标记——迁移**不加过滤**,全量扫描自动覆盖)。 */
    retired: number;
    active: number;
    /** 逐值计数(含 retired 行;null 单列)。 */
    byWing: Record<string, number>;
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
export interface WingMigrationOptions {
    dbPath: string;
    /** true = 只读报告,不写备份;false = 先备份 metadata_json 再出报告。 */
    dryRun?: boolean;
    /** 备份输出目录(缺省 = db 同目录 wing-migrate-backup/)。 */
    backupDir?: string;
    logger?: MemoryLogger;
}
export declare function runWingMigration(opts: WingMigrationOptions): HallMigrationReport;
