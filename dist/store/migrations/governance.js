const TAG = '[memory][governance-migration]';
/** l1_records 治理列(列名 → DDL 片段)。DEFAULT 语义全部="不变"。 */
export const GOVERNANCE_COLUMNS = [
    // tier 治理轴(O-7):active|wiki;缺失/非法读侧归一为 active(判据不变)
    { name: 'tier', ddl: "ALTER TABLE l1_records ADD COLUMN tier TEXT NOT NULL DEFAULT 'active'" },
    // repo 软围栏(T1.7/T1.9):'' = 未归属 = 不围栏(fail-open 回 global 语义)
    { name: 'repo_key_name', ddl: "ALTER TABLE l1_records ADD COLUMN repo_key_name TEXT NOT NULL DEFAULT ''" },
    { name: 'repo_key_owner', ddl: "ALTER TABLE l1_records ADD COLUMN repo_key_owner TEXT NOT NULL DEFAULT ''" },
    // 记录级 applicability(T1.10):'' = 未声明(不围栏)| 'this-repo' | 'cross-project'。
    // 显式**不从 family 推导**(P0-7 四象限不塌缩);缺省=不围栏。
    { name: 'applicability', ddl: "ALTER TABLE l1_records ADD COLUMN applicability TEXT NOT NULL DEFAULT ''" },
];
/** 写入门留痕表(T1.6):冷溯源,不进检索、不进快照哈希。 */
const GATE_REJECTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS l1_gate_rejections (
    record_id TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    gate TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT '',
    priority_raw TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    content_chars INTEGER NOT NULL DEFAULT 0,
    decided_at TEXT NOT NULL DEFAULT ''
  )
`;
/**
 * 激活轻表(治理 W2,T2.1/P0-2/P0-3):高频热写与 l1_records 契约行**物理隔离**。
 * 三条不变量(计划 §三):
 * - 不打契约行:激活计数绝不写进 l1_records/metadata_json(快照哈希静默失效的根因);
 * - 不进 FTS:异表天然排除(I-3 从根满足);
 * - 原子自增:bumpActivation 走 ON CONFLICT DO UPDATE 列自增,不碰 updated_time
 *   (衰减锚点不被篡改)、不做读改写(多实例并发无丢增,P1-10)。
 */
const ACTIVATION_DDL = `
  CREATE TABLE IF NOT EXISTS l1_activation (
    record_id TEXT PRIMARY KEY,
    injection_count INTEGER NOT NULL DEFAULT 0,
    adopted_count INTEGER NOT NULL DEFAULT 0,
    last_activated_at TEXT NOT NULL DEFAULT '',
    decay_anchor_at TEXT NOT NULL DEFAULT '',
    activation_epoch TEXT NOT NULL DEFAULT ''
  )
`;
/**
 * 批量裁决批次列(治理 W3,T3.6):conflict_pending 加 batch_id,使"某批裁决"
 * 可查询可审计可定位回滚。**不进快照哈希**(projectConflictsForHash 冻结投影不含它)。
 */
const CONFLICT_BATCH_ID_DDL = "ALTER TABLE conflict_pending ADD COLUMN batch_id TEXT NOT NULL DEFAULT ''";
/** 队列 scope 列(治理 W4,T4.1):DEFAULT='global'/''=存量全可见(不搬不删,P1-13)。 */
const CONFLICT_SCOPE_DDL = [
    "ALTER TABLE conflict_pending ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'global'",
    "ALTER TABLE conflict_pending ADD COLUMN repo_key_name TEXT NOT NULL DEFAULT ''",
];
/**
 * L2 重聚类作业队列(治理 W3,T3.10):demote-to-wiki 挂钩的场景重整。
 * ruminate 空闲消费;行即作业,完成打标,失败保留重试(幂等消费方保证)。
 */
const SCENE_RECLUSTER_JOBS_DDL = `
  CREATE TABLE IF NOT EXISTS scene_recluster_jobs (
    job_id TEXT PRIMARY KEY,
    family TEXT NOT NULL DEFAULT 'chat',
    scene_names TEXT NOT NULL DEFAULT '',
    batch_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT '',
    finished_at TEXT NOT NULL DEFAULT ''
  )
`;
function hasColumn(db, table, column) {
    try {
        const rows = db.prepare(`PRAGMA table_info(${table})`).all();
        return rows.some((r) => r.name === column);
    }
    catch {
        return false;
    }
}
/** 行数上限:留痕是诊断设施不是审计法律——超限裁最老(按 decided_at),有界性直接成立。 */
export const GATE_REJECTIONS_MAX_ROWS = 5000;
/**
 * 幂等落地治理 schema。对 `db`(即 MemoryDb 的 this.db)执行:
 * l1_records 治理列(缺则补)+ l1_gate_rejections 留痕表 + 裁剪索引。
 * 失败不抛——调用方(init)在本函数返回后照常继续。
 */
export function ensureGovernanceColumns(db, logger) {
    try {
        for (const col of GOVERNANCE_COLUMNS) {
            if (hasColumn(db, 'l1_records', col.name))
                continue;
            db.exec(col.ddl);
            logger?.info?.(`${TAG} l1_records 补 ${col.name} 列(DEFAULT 即标注,存量零回填)`);
        }
        db.exec(GATE_REJECTIONS_DDL);
        db.exec(ACTIVATION_DDL);
        db.exec(SCENE_RECLUSTER_JOBS_DDL);
        db.exec('CREATE INDEX IF NOT EXISTS idx_l1_gate_rej_run ON l1_gate_rejections(run_id)');
        if (!hasColumn(db, 'conflict_pending', 'batch_id')) {
            db.exec(CONFLICT_BATCH_ID_DDL);
            logger?.info?.(`${TAG} conflict_pending 补 batch_id 列(批量裁决审计/回滚锚点)`);
        }
        for (const ddl of CONFLICT_SCOPE_DDL) {
            if (hasColumn(db, 'conflict_pending', /workspace_id/.test(ddl) ? 'workspace_id' : 'repo_key_name'))
                continue;
            db.exec(ddl);
            logger?.info?.(`${TAG} conflict_pending 补 scope 列(DEFAULT 即'全可见',存量不搬不删)`);
        }
        // 有界性:每次迁移顺手裁到上限以下(写入侧另有软裁剪;这里兜底旧行)
        const prune = db.prepare(`DELETE FROM l1_gate_rejections WHERE rowid NOT IN (
         SELECT rowid FROM l1_gate_rejections ORDER BY decided_at DESC, rowid DESC LIMIT ${GATE_REJECTIONS_MAX_ROWS}
       )`);
        prune.run();
    }
    catch (err) {
        logger?.warn?.(`${TAG} 治理列迁移失败(no-op 降级,主链路不受阻): ${err instanceof Error ? err.message : String(err)}`);
    }
}
