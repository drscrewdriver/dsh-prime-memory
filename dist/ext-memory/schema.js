export const EXT_SYNC_DDL_VERSION = 2;
/** sync_state 九值(计划 spec 影子层节;`unforgettable`=远端根本没有删除口,如 byterover)。 */
export const EXT_SHADOW_STATES = [
    'clean',
    'local_dirty',
    'remote_dirty',
    'both_dirty',
    'awaiting_settle',
    'orphan',
    'linked_remote_missing',
    'unforgettable',
    'dead',
];
/** 出站意图。retire+appendNew 同 extKey 的折叠在 pusher 侧做,这里只存原始意图。 */
export const EXT_OUTBOX_INTENTS = ['add', 'update', 'forget', 'relink'];
export const EXT_OUTBOX_STATUSES = ['pending', 'running', 'awaiting_settle', 'done', 'dead'];
export const EXT_SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS ext_drivers (
  driver_id     TEXT PRIMARY KEY,
  type_id       TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  score_semantics   TEXT NOT NULL DEFAULT 'none',
  conn_json     TEXT NOT NULL DEFAULT '{}',
  secret_refs   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  healthy       INTEGER NOT NULL DEFAULT 0,
  last_probe_at INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT NOT NULL DEFAULT '',
  created_time  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_time  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ext_shadow (
  shadow_id     TEXT PRIMARY KEY,
  driver_id     TEXT NOT NULL,
  space_id      TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  ext_key       TEXT NOT NULL DEFAULT '',
  external_id   TEXT NOT NULL DEFAULT '',
  alias_of      TEXT NOT NULL DEFAULT '',
  ext_uri       TEXT NOT NULL DEFAULT '',
  db_digest     TEXT NOT NULL DEFAULT '',
  ext_digest    TEXT NOT NULL DEFAULT '',
  content_norm  TEXT NOT NULL DEFAULT '',
  sync_state    TEXT NOT NULL DEFAULT 'clean',
  pending_op    TEXT NOT NULL DEFAULT '',
  settle_deadline INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER NOT NULL DEFAULT 0,
  created_time  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_time  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ext_shadow_rec_uidx
  ON ext_shadow(driver_id, space_id, record_id);
CREATE UNIQUE INDEX IF NOT EXISTS ext_shadow_extid_uidx
  ON ext_shadow(driver_id, space_id, external_id) WHERE external_id <> '';
CREATE INDEX IF NOT EXISTS ext_shadow_state_idx
  ON ext_shadow(sync_state, updated_time);
CREATE INDEX IF NOT EXISTS ext_shadow_extkey_idx
  ON ext_shadow(driver_id, ext_key);

CREATE TABLE IF NOT EXISTS ext_outbox (
  job_id          TEXT PRIMARY KEY,
  driver_id       TEXT NOT NULL,
  space_id        TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  intent          TEXT NOT NULL,
  payload_digest  TEXT NOT NULL DEFAULT '',
  priority        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error           TEXT NOT NULL DEFAULT '',
  created_time    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_time    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ext_outbox_pick_idx
  ON ext_outbox(status, priority, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS ext_outbox_dedup_uidx
  ON ext_outbox(driver_id, space_id, record_id, intent)
  WHERE status IN ('pending','running','awaiting_settle');

CREATE TABLE IF NOT EXISTS ext_conflicts (
  conflict_id   TEXT PRIMARY KEY,
  driver_id     TEXT NOT NULL,
  space_id      TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  external_id   TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL,
  db_digest     TEXT NOT NULL DEFAULT '',
  ext_digest    TEXT NOT NULL DEFAULT '',
  detail_json   TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'open',
  resolution    TEXT NOT NULL DEFAULT '',
  created_time  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_time  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ext_conflicts_open_uidx
  ON ext_conflicts(driver_id, space_id, record_id, external_id, kind) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS ext_conflicts_status_idx
  ON ext_conflicts(status, updated_time);

CREATE TABLE IF NOT EXISTS ext_cursor (
  driver_id     TEXT NOT NULL,
  space_id      TEXT NOT NULL,
  cursor_json   TEXT NOT NULL DEFAULT '{}',
  updated_time  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (driver_id, space_id)
);

/*
 * 导入断点与结果（计划 ext-to-l1-import）。
 *
 * 不复用 ext_cursor：那张表存的是“对账游标”（驱动自定义的增量语义），这张存的是
 * “导入翻页到哪儿了”。两者语义互斥——对账推进游标会直接毁掉导入断点，
 * 合在一张表里就是“一个动作静默抹掉另一个动作的进度”。
 */
CREATE TABLE IF NOT EXISTS ext_import (
  driver_id     TEXT NOT NULL,
  space_id      TEXT NOT NULL,
  offset_rows   INTEGER NOT NULL DEFAULT 0,
  imported      INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'idle',
  updated_time  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (driver_id, space_id)
);
`;
/** 冲突账(kind 三族):both_dirty=两边都变挂账;orphan=远端寻不到影;unforgettable=远端无删除口。 */
export const EXT_CONFLICT_KINDS = ['both_dirty', 'orphan', 'unforgettable'];
function toConflict(r) {
    if (!r)
        return undefined;
    return {
        conflictId: String(r.conflict_id ?? ''),
        driverId: String(r.driver_id ?? ''),
        spaceId: String(r.space_id ?? ''),
        recordId: String(r.record_id ?? ''),
        externalId: String(r.external_id ?? ''),
        kind: String(r.kind ?? 'both_dirty'),
        dbDigest: String(r.db_digest ?? ''),
        extDigest: String(r.ext_digest ?? ''),
        detailJson: String(r.detail_json ?? '{}'),
        status: String(r.status ?? 'open'),
        resolution: String(r.resolution ?? ''),
    };
}
function toShadow(r) {
    if (!r)
        return undefined;
    return {
        shadowId: String(r.shadow_id ?? ''),
        driverId: String(r.driver_id ?? ''),
        spaceId: String(r.space_id ?? ''),
        recordId: String(r.record_id ?? ''),
        extKey: String(r.ext_key ?? ''),
        externalId: String(r.external_id ?? ''),
        aliasOf: String(r.alias_of ?? ''),
        extUri: String(r.ext_uri ?? ''),
        dbDigest: String(r.db_digest ?? ''),
        extDigest: String(r.ext_digest ?? ''),
        contentNorm: String(r.content_norm ?? ''),
        syncState: EXT_SHADOW_STATES.includes(String(r.sync_state))
            ? r.sync_state
            : 'clean',
        pendingOp: String(r.pending_op ?? ''),
        settleDeadline: Number(r.settle_deadline ?? 0),
        lastSyncedAt: Number(r.last_synced_at ?? 0),
    };
}
function toOutbox(r) {
    if (!r)
        return undefined;
    return {
        jobId: String(r.job_id ?? ''),
        driverId: String(r.driver_id ?? ''),
        spaceId: String(r.space_id ?? ''),
        recordId: String(r.record_id ?? ''),
        intent: EXT_OUTBOX_INTENTS.includes(String(r.intent))
            ? r.intent
            : 'add',
        payloadDigest: String(r.payload_digest ?? ''),
        priority: Number(r.priority ?? 0),
        status: EXT_OUTBOX_STATUSES.includes(String(r.status))
            ? r.status
            : 'pending',
        attempts: Number(r.attempts ?? 0),
        nextAttemptAt: Number(r.next_attempt_at ?? 0),
        error: String(r.error ?? ''),
    };
}
export class ExtSyncStore {
    db = null;
    logger;
    /** 建表(幂等)。自带 try/catch:失败则本 store 保持未注入态,全部方法 no-op,
     *  不传染主库降级(与 GraphStore.init 同纪律,调用方无需再包一层)。 */
    init(db, logger) {
        try {
            db.exec(EXT_SYNC_SCHEMA);
            this.migrateConflictUniq(db, logger);
            this.db = db;
            this.logger = logger;
        }
        catch (err) {
            this.db = null;
            logger?.warn(`[memory] 外部同步表创建失败,外部记忆功能停用(主库不受影响): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /**
     * ext_conflicts 的 open 唯一键必须含 external_id（v1 → v2 迁移）。
     *
     * 旧键 `(driver, space, record_id, kind)` 在“无本地记录”的 unforgettable 挂账上
     * `record_id` 恒为空串 → 同一驱动同一空间的**全部**此类冲突塌成一条：
     * `stats.conflicts` 报 N 条、表里只有 1 条，面板队列看着很干净，
     * 而其余 N-1 个远端条目既不入库也不在任何待办里——静默丢失。
     * 新键更细（多一列），已有行不会因此违反约束，所以 drop+create 安全；
     * 而 `CREATE UNIQUE INDEX IF NOT EXISTS` 同名不会重建旧定义，必须显式 drop。
     */
    migrateConflictUniq(db, logger) {
        try {
            const row = db
                .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ext_conflicts_open_uidx'")
                .get();
            if (row?.sql !== undefined && !row.sql.includes('external_id')) {
                db.exec('DROP INDEX ext_conflicts_open_uidx');
                db.exec("CREATE UNIQUE INDEX ext_conflicts_open_uidx ON ext_conflicts(driver_id, space_id, record_id, external_id, kind) WHERE status = 'open'");
            }
        }
        catch (err) {
            // 迁移失败不停用整个外部记忆面：旧键只会少挂几条账，不会写坏用户数据。
            logger?.warn(`[memory] ext_conflicts 唯一键迁移跳过: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    close() {
        this.db = null;
    }
    get ready() {
        return this.db !== null;
    }
    // ── ext_drivers ──
    upsertDriver(row) {
        if (!this.db)
            return;
        try {
            this.db
                .prepare(`INSERT INTO ext_drivers (driver_id, type_id, enabled, capabilities_json, score_semantics, conn_json, secret_refs, updated_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(driver_id) DO UPDATE SET
             type_id = excluded.type_id,
             enabled = excluded.enabled,
             capabilities_json = excluded.capabilities_json,
             score_semantics = excluded.score_semantics,
             conn_json = excluded.conn_json,
             secret_refs = excluded.secret_refs,
             updated_time = excluded.updated_time`)
                .run(row.driverId, row.typeId, row.enabled ? 1 : 0, row.capabilitiesJson ?? '{}', row.scoreSemantics ?? 'none', 
            // conn_json 只存非敏感字段——写侧契约由调用方保证(密钥走 secret_refs 名单)。
            row.connJson ?? '{}', row.secretRefs ?? '');
        }
        catch (err) {
            this.logger?.warn(`[memory] ext_drivers upsert 失败(驱动态镜像不落,不影响运行): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 健康探测缓存位写入(探测级 60s 缓存的消费方在 Phase 1 lane 侧)。 */
    recordProbe(driverId, healthy, error = '') {
        if (!this.db)
            return;
        try {
            this.db
                .prepare(`UPDATE ext_drivers SET healthy = ?, last_probe_at = ?, last_error = ?, updated_time = datetime('now') WHERE driver_id = ?`)
                .run(healthy ? 1 : 0, Date.now(), error.slice(0, 500), driverId);
        }
        catch {
            // 探测回写失败只影响面板新鲜度,不告警刷屏
        }
    }
    listDrivers() {
        if (!this.db)
            return [];
        try {
            const rows = this.db
                .prepare(`SELECT driver_id, type_id, enabled, capabilities_json, score_semantics, conn_json, secret_refs,
                  status, healthy, last_probe_at, last_error
             FROM ext_drivers ORDER BY driver_id`)
                .all();
            return rows.map((r) => ({
                driverId: String(r.driver_id),
                typeId: String(r.type_id),
                enabled: Number(r.enabled) === 1,
                capabilitiesJson: String(r.capabilities_json ?? '{}'),
                scoreSemantics: String(r.score_semantics ?? 'none'),
                connJson: String(r.conn_json ?? '{}'),
                secretRefs: String(r.secret_refs ?? ''),
                status: String(r.status ?? 'active'),
                healthy: Number(r.healthy) === 1,
                lastProbeAt: Number(r.last_probe_at ?? 0),
                lastError: String(r.last_error ?? ''),
            }));
        }
        catch {
            return [];
        }
    }
    // ── ext_shadow ──
    /** 影子行 upsert(按 driver+space+record 唯一位)。shadowId 由调用方给定(稳定派生)。 */
    upsertShadow(row) {
        if (!this.db)
            return;
        try {
            this.db
                .prepare(`INSERT INTO ext_shadow (shadow_id, driver_id, space_id, record_id, ext_key, external_id, alias_of, ext_uri,
              db_digest, ext_digest, content_norm, sync_state, pending_op, settle_deadline, last_synced_at, updated_time)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
           ON CONFLICT(driver_id, space_id, record_id) DO UPDATE SET
             ext_key = excluded.ext_key,
             external_id = excluded.external_id,
             alias_of = excluded.alias_of,
             ext_uri = excluded.ext_uri,
             db_digest = excluded.db_digest,
             ext_digest = excluded.ext_digest,
             content_norm = excluded.content_norm,
             sync_state = excluded.sync_state,
             pending_op = excluded.pending_op,
             settle_deadline = excluded.settle_deadline,
             last_synced_at = excluded.last_synced_at,
             updated_time = excluded.updated_time`)
                .run(row.shadowId, row.driverId, row.spaceId, row.recordId, row.extKey ?? '', row.externalId ?? '', row.aliasOf ?? '', row.extUri ?? '', row.dbDigest ?? '', row.extDigest ?? '', row.contentNorm ?? '', row.syncState ?? 'clean', row.pendingOp ?? '', row.settleDeadline ?? 0, row.lastSyncedAt ?? 0);
        }
        catch (err) {
            this.logger?.warn(`[memory] ext_shadow upsert 失败(账本落后,下轮对账自愈): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    getShadowByRecord(driverId, spaceId, recordId) {
        if (!this.db)
            return undefined;
        try {
            return toShadow(this.db
                .prepare('SELECT * FROM ext_shadow WHERE driver_id = ? AND space_id = ? AND record_id = ? LIMIT 1')
                .get(driverId, spaceId, recordId));
        }
        catch {
            return undefined;
        }
    }
    getShadowByExternal(driverId, spaceId, externalId) {
        if (!this.db || !externalId)
            return undefined;
        try {
            return toShadow(this.db
                .prepare('SELECT * FROM ext_shadow WHERE driver_id = ? AND space_id = ? AND external_id = ? LIMIT 1')
                .get(driverId, spaceId, externalId));
        }
        catch {
            return undefined;
        }
    }
    /** 映射了结(外部 forget 确认后删行):历史流水在 outbox(status=done 行)里,影子表只活在账。 */
    deleteShadow(shadowId) {
        if (!this.db)
            return;
        try {
            this.db.prepare('DELETE FROM ext_shadow WHERE shadow_id = ?').run(shadowId);
        }
        catch {
            // 删不掉只会多一条陈旧映射,下轮对账自愈(与所有旁路回写同口径)
        }
    }
    /**
     * 冲突挂账(可重复调):同 (driver,space,record,external,kind) 的 open 行幂等——
     * 重复冲突只刷新 detail/指纹与 updated_time,**不堆行**（面板一屏一条）。
     *
     * 去重键必须含 external_id，与 `ext_conflicts_open_uidx` 逐项对齐：
     * “无本地记录”的 unforgettable 挂账 record_id 恒为空串，不拿 external_id 区分时
     * 第二条会直接 UPDATE 掉第一条（stats.conflicts 报 N、表里只存 1），
     * 其余条目既不入库也不在任何待办里——静默丢失。
     */
    upsertConflict(row) {
        if (!this.db)
            return;
        try {
            // 两步写法(不用 ON CONFLICT):open 唯一索引是 **partial** 的,
            // SQLite 的 conflict target 不接受部分索引——写上去只会每行报
            // "does not match any UNIQUE constraint" 再被 catch 吞掉,面板永远空。
            const upd = this.db
                .prepare(`UPDATE ext_conflicts SET db_digest = ?, ext_digest = ?, detail_json = ?, updated_time = datetime('now')
           WHERE driver_id = ? AND space_id = ? AND record_id = ? AND external_id = ? AND kind = ? AND status = 'open'`)
                .run(row.dbDigest ?? '', row.extDigest ?? '', JSON.stringify(row.detail ?? {}).slice(0, 4000), row.driverId, row.spaceId, row.recordId, row.externalId ?? '', row.kind);
            if (Number(upd.changes ?? 0) > 0)
                return;
            this.db
                .prepare(`INSERT INTO ext_conflicts (conflict_id, driver_id, space_id, record_id, external_id, kind, db_digest, ext_digest, detail_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(row.conflictId, row.driverId, row.spaceId, row.recordId, row.externalId ?? '', row.kind, row.dbDigest ?? '', row.extDigest ?? '', JSON.stringify(row.detail ?? {}).slice(0, 4000));
        }
        catch {
            // 挂账失败不阻断拉取;面板少一条远好于整批回港失败
        }
    }
    listConflicts(opts = {}) {
        if (!this.db)
            return [];
        try {
            const where = ['status = ?'];
            const args = [opts.status ?? 'open'];
            if (opts.kind !== undefined) {
                where.push('kind = ?');
                args.push(opts.kind);
            }
            args.push(Math.max(1, Math.min(500, opts.limit ?? 100)), Math.max(0, opts.offset ?? 0));
            const rows = this.db
                .prepare(`SELECT * FROM ext_conflicts WHERE ${where.join(' AND ')} ORDER BY updated_time DESC, conflict_id LIMIT ? OFFSET ?`)
                .all(...args);
            return rows.map((r) => toConflict(r)).filter((r) => r !== undefined);
        }
        catch {
            return [];
        }
    }
    countConflicts() {
        if (!this.db)
            return { open: 0, byKind: {} };
        try {
            const rows = this.db
                .prepare("SELECT kind, COUNT(*) AS n FROM ext_conflicts WHERE status = 'open' GROUP BY kind")
                .all();
            const byKind = {};
            let open = 0;
            for (const r of rows) {
                const n = Number(r.n ?? 0);
                byKind[String(r.kind ?? '')] = n;
                open += n;
            }
            return { open, byKind };
        }
        catch {
            return { open: 0, byKind: {} };
        }
    }
    /** 裁决/忽略;同键再冲突时 upsertConflict 会重新挂 open(可重开,不封死)。 */
    resolveConflict(conflictId, resolution) {
        if (!this.db)
            return false;
        try {
            const r = this.db
                .prepare("UPDATE ext_conflicts SET status = 'resolved', resolution = ?, updated_time = datetime('now') WHERE conflict_id = ? AND status = 'open'")
                .run(resolution.slice(0, 200), conflictId);
            return Number(r.changes ?? 0) > 0;
        }
        catch {
            return false;
        }
    }
    dismissConflict(conflictId) {
        if (!this.db)
            return false;
        try {
            const r = this.db
                .prepare("UPDATE ext_conflicts SET status = 'dismissed', updated_time = datetime('now') WHERE conflict_id = ? AND status = 'open'")
                .run(conflictId);
            return Number(r.changes ?? 0) > 0;
        }
        catch {
            return false;
        }
    }
    /** 增量拉取游标(cursor 家的 sincePull 断点;json 不透明,由驱动自解)。 */
    getCursor(driverId, spaceId) {
        if (!this.db)
            return {};
        try {
            const r = this.db.prepare('SELECT cursor_json FROM ext_cursor WHERE driver_id = ? AND space_id = ?').get(driverId, spaceId);
            if (r === undefined)
                return {};
            const parsed = JSON.parse(String(r.cursor_json ?? '{}'));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
                return {};
            const out = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === 'string' || typeof v === 'number')
                    out[k] = v;
            }
            return out;
        }
        catch {
            return {};
        }
    }
    setCursor(driverId, spaceId, cursor) {
        if (!this.db)
            return;
        try {
            this.db
                .prepare(`INSERT INTO ext_cursor (driver_id, space_id, cursor_json, updated_time) VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(driver_id, space_id) DO UPDATE SET cursor_json = excluded.cursor_json, updated_time = datetime('now')`)
                .run(driverId, spaceId, JSON.stringify(cursor).slice(0, 4000));
        }
        catch {
            // 游标丢失只造成下次重复拉取(幂等兜住),不阻断
        }
    }
    /**
     * 导入断点落盘（每页提交后调一次）。写失败不阻断导入——断点丢只造成重复翻页，
     * ext_key 幂等会兜住；而因断点写不进就中断导入，会把一个存储问题放大成功能故障。
     */
    upsertImport(prog) {
        if (!this.db)
            return;
        try {
            this.db
                .prepare(`INSERT INTO ext_import (driver_id, space_id, offset_rows, imported, skipped, state, updated_time)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(driver_id, space_id) DO UPDATE SET
             offset_rows = excluded.offset_rows, imported = excluded.imported,
             skipped = excluded.skipped, state = excluded.state, updated_time = datetime('now')`)
                .run(prog.driverId, prog.spaceId, prog.offset, prog.imported, prog.skipped, prog.state);
        }
        catch {
            /* 断点写不进不阻断导入（幂等兜重复） */
        }
    }
    /** 导入断点（无记录 = null，调用方按“从头开始”处理）。 */
    getImport(driverId, spaceId) {
        if (!this.db)
            return null;
        try {
            const r = this.db
                .prepare('SELECT offset_rows, imported, skipped, state FROM ext_import WHERE driver_id = ? AND space_id = ?')
                .get(driverId, spaceId);
            if (r === undefined)
                return null;
            return {
                offset: Number(r.offset_rows ?? 0),
                imported: Number(r.imported ?? 0),
                skipped: Number(r.skipped ?? 0),
                state: String(r.state ?? 'idle'),
            };
        }
        catch {
            return null;
        }
    }
    /** 清断点（导入完成/用户主动重置）；下一次从头来。 */
    clearImport(driverId, spaceId) {
        if (!this.db)
            return;
        try {
            this.db.prepare('DELETE FROM ext_import WHERE driver_id = ? AND space_id = ?').run(driverId, spaceId);
        }
        catch {
            /* 忽略 */
        }
    }
    /** 最早一个待派发任务的到票时刻(ms;无待办 = 0)——推送泵的一次性重臂定时器用它。 */
    earliestPendingWake() {
        if (!this.db)
            return 0;
        try {
            const r = this.db
                .prepare("SELECT MIN(next_attempt_at) AS t FROM ext_outbox WHERE status IN ('pending','awaiting_settle')")
                .get();
            return Number(r?.t ?? 0) || 0;
        }
        catch {
            return 0;
        }
    }
    /** 按驱动计影子条数(面板删除/编辑前的"已有账本"提醒)。 */
    countShadowsByDriver(driverId) {
        if (!this.db || driverId === '')
            return 0;
        try {
            const r = this.db.prepare('SELECT COUNT(*) AS n FROM ext_shadow WHERE driver_id = ?').get(driverId);
            return Number(r?.n ?? 0);
        }
        catch {
            return 0;
        }
    }
    /** 某记录的全部影子跨驱动列举(三侧裁决的 remote 输入面,T4.1)。 */
    listShadowsByRecord(recordId) {
        if (!this.db || recordId === '')
            return [];
        try {
            return this.db
                .prepare('SELECT * FROM ext_shadow WHERE record_id = ? ORDER BY driver_id, space_id')
                .all(recordId)
                .map((r) => toShadow(r))
                .filter((r) => r !== undefined);
        }
        catch {
            return [];
        }
    }
    /** merge 换 id 后的重挂位:按 ext_key 找影子(身份在 key 上,不在 record_id 上)。 */
    findShadowsByExtKey(driverId, extKey) {
        if (!this.db || !extKey)
            return [];
        try {
            return this.db
                .prepare('SELECT * FROM ext_shadow WHERE driver_id = ? AND ext_key = ?')
                .all(driverId, extKey).map(toShadow).filter((r) => r !== undefined);
        }
        catch {
            return [];
        }
    }
    /**
     * merge 重挂(冲突解决⑥ 身份漂移的落盘动作):把指向 (oldRecordId) 的影子行
     * 改指 newRecordId——**移动**而非新插,因为 (driver,space,external_id) 唯一索引
     * 决定了同一外部条目只能有一条在账影子;新插同 externalId 会被约束拒绝。
     * 不动 ext_key(它才是认人锚),刷 updated_time。
     */
    repointShadowRecord(driverId, spaceId, oldRecordId, newRecordId) {
        if (!this.db)
            return false;
        try {
            const res = this.db
                .prepare(`UPDATE ext_shadow SET record_id = ?, updated_time = datetime('now')
            WHERE driver_id = ? AND space_id = ? AND record_id = ?`)
                .run(newRecordId, driverId, spaceId, oldRecordId);
            return Number(res.changes) > 0;
        }
        catch (err) {
            this.logger?.warn(`[memory] 影子重挂失败(旧映射保留,下轮对账自愈): ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }
    /** 按状态列(面板计数/回捞扫描共用;limit 封顶防大账本拖死 RPC)。 */
    listShadowsByState(state, limit = 200) {
        if (!this.db)
            return [];
        try {
            return this.db
                .prepare('SELECT * FROM ext_shadow WHERE sync_state = ? ORDER BY updated_time ASC LIMIT ?')
                .all(state, Math.max(1, Math.min(2000, limit))).map(toShadow).filter((r) => r !== undefined);
        }
        catch {
            return [];
        }
    }
    countShadows() {
        const out = Object.fromEntries(EXT_SHADOW_STATES.map((s) => [s, 0]));
        if (!this.db)
            return out;
        try {
            for (const r of this.db.prepare('SELECT sync_state, COUNT(*) AS n FROM ext_shadow GROUP BY sync_state').all()) {
                const st = String(r.sync_state);
                if (st in out)
                    out[st] = Number(r.n);
            }
        }
        catch {
            // 计数失败回零值:面板把它呈现为"账本不可读"是 Phase 1 的事,这里不造假也不炸
        }
        return out;
    }
    // ── ext_outbox ──
    /**
     * 意图入队(同步写、零网络)。重复点火被 pending 唯一索引吃掉(INSERT OR IGNORE)
     * ——写侧的幂等来自**索引**而不是调用方自觉,与 conflictPairId 同一手法。
     * @returns true = 新增了一条待办;false = 同四元组的在途任务已存在(或降级 no-op)。
     */
    enqueueOutbox(row) {
        if (!this.db)
            return false;
        try {
            const res = this.db
                .prepare(`INSERT OR IGNORE INTO ext_outbox (job_id, driver_id, space_id, record_id, intent, payload_digest, priority, next_attempt_at)
           VALUES (?,?,?,?,?,?,?,?)`)
                .run(row.jobId, row.driverId, row.spaceId, row.recordId, row.intent, row.payloadDigest ?? '', row.priority ?? 0, row.nextAttemptAt ?? 0);
            return Number(res.changes) > 0;
        }
        catch (err) {
            this.logger?.warn(`[memory] ext_outbox 入队失败(本地写已成立,同步欠账由下轮对账兜底): ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }
    /** 取到期待办(priority 高者先、同优先级按入队序;驱动级串行由 pusher 自己保证)。 */
    pickDueOutbox(nowMs, limit) {
        if (!this.db)
            return [];
        try {
            return this.db
                .prepare(`SELECT * FROM ext_outbox
            WHERE status IN ('pending','awaiting_settle') AND next_attempt_at <= ?
            ORDER BY priority DESC, created_time ASC LIMIT ?`)
                .all(nowMs, Math.max(1, Math.min(500, limit))).map(toOutbox).filter((r) => r !== undefined);
        }
        catch {
            return [];
        }
    }
    setOutboxStatus(jobId, status, opts = {}) {
        if (!this.db)
            return;
        try {
            // CASE 守卫必须先判 NULL 再比较:三值逻辑下 `NULL >= 0` 不是真也不是假,
            // 会静默落到 ELSE 保留旧值——"状态写了、到票时间没落"是比异常难查一个量级的脏。
            // node:sqlite 不接受 undefined 绑定,缺省一律归一 -1(= 不改)。
            const next = Number.isFinite(opts.nextAttemptAt) ? opts.nextAttemptAt : -1;
            const att = Number.isFinite(opts.attempts) ? opts.attempts : -1;
            this.db
                .prepare(`UPDATE ext_outbox SET status = ?,
             error = ?,
             next_attempt_at = CASE WHEN ? >= 0 THEN ? ELSE next_attempt_at END,
             attempts = CASE WHEN ? >= 0 THEN ? ELSE attempts END,
             updated_time = datetime('now')
           WHERE job_id = ?`)
                .run(status, (opts.error ?? '').slice(0, 500), next, next, att, att, jobId);
        }
        catch {
            // 状态回写失败:任务会被下轮重新拾起,payload_digest 幂等兜住重复执行
        }
    }
    bumpOutboxAttempt(jobId, nextAttemptAt, error) {
        if (!this.db)
            return;
        try {
            this.db
                .prepare(`UPDATE ext_outbox SET attempts = attempts + 1, next_attempt_at = ?, error = ?, updated_time = datetime('now')
            WHERE job_id = ?`)
                .run(nextAttemptAt, error.slice(0, 500), jobId);
        }
        catch {
            // 同上:退避位没写上只会让重试更早发生,不会丢任务
        }
    }
    countOutbox() {
        const out = { pending: 0, dead: 0 };
        if (!this.db)
            return out;
        try {
            for (const r of this.db
                .prepare("SELECT status, COUNT(*) AS n FROM ext_outbox WHERE status IN ('pending','running','awaiting_settle','dead') GROUP BY status")
                .all()) {
                const st = String(r.status);
                const n = Number(r.n);
                if (st === 'dead')
                    out.dead += n;
                else
                    out.pending += n;
            }
        }
        catch {
            // 零值 + 面板"不可读"呈现,同 countShadows 口径
        }
        return out;
    }
    /** 单驱动在途待同步数(面板驱动卡用;not ready = 0)。 */
    outboxPendingByDriver(driverId) {
        if (!this.db)
            return 0;
        try {
            const r = this.db
                .prepare("SELECT COUNT(*) AS n FROM ext_outbox WHERE driver_id = ? AND status IN ('pending','running','awaiting_settle')")
                .get(driverId);
            return Number(r?.n ?? 0);
        }
        catch {
            return 0;
        }
    }
}
