/**
 * 治理升级 schema 迁移(Wave 1,T1.8)。
 *
 * 挂 MemoryDb.init() 内、在 L1 建表之后调用(非构造期——构造永不抛,I-24)。
 * 三条纪律:
 * - **幂等**:hasColumn 判据 + ALTER ADD COLUMN DEFAULT,重跑无副作用;
 * - **零搬运(O(1))**:DEFAULT 即标注,绝不 UPDATE 回填存量(计划 §三"本波零回填",
 *   P1-12 DEFAULT 语义必须="不变"非"已治理");
 * - **降级 no-op(ADR-0011)**:任一语句失败只告警,不抛——迁移失败时列缺失,
 *   读侧按 fail-open 归一(tier 缺→active / repo_key 缺→'' 不围栏),主链路不受阻。
 *
 * 新列一律**不进 l1_fts、不进 canonicalRecords 哈希投影**(I-3/I-4):
 * FTS5 无法 ALTER(加列须 DROP+全量回灌),快照哈希投影是冻结白名单——
 * 两处都靠"不加"从根上满足,无需额外代码。
 */
import type { MemoryLogger } from '../../types.js';
/** l1_records 治理列(列名 → DDL 片段)。DEFAULT 语义全部="不变"。 */
export declare const GOVERNANCE_COLUMNS: ReadonlyArray<{
    name: string;
    ddl: string;
}>;
interface MinimalDb {
    exec(sql: string): void;
    prepare(sql: string): {
        all(...args: unknown[]): unknown[];
        run(...args: unknown[]): unknown;
        get(...args: unknown[]): unknown;
    };
}
/** 行数上限:留痕是诊断设施不是审计法律——超限裁最老(按 decided_at),有界性直接成立。 */
export declare const GATE_REJECTIONS_MAX_ROWS = 5000;
/**
 * 幂等落地治理 schema。对 `db`(即 MemoryDb 的 this.db)执行:
 * l1_records 治理列(缺则补)+ l1_gate_rejections 留痕表 + 裁剪索引。
 * 失败不抛——调用方(init)在本函数返回后照常继续。
 */
export declare function ensureGovernanceColumns(db: MinimalDb, logger?: MemoryLogger): void;
export {};
