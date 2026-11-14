/**
 * 外部同步账本(计划 ext-mem-drivers-sync T0.3):`ext_*` 三表族 + 安全 no-op 门面。
 *
 * 与 CostLedger / GraphStore / L0WatermarkStore 同款自治纪律:独立职责类,唯一
 * 耦合是共享 node:sqlite 连接;`MemoryDb.init` 里单独 try/catch 调 `init()`——
 * **建表失败只停用外部同步(全部方法退化为 no-op),绝不传染主库降级**。
 *
 * 派生态总则(承 md 账本三条口径):删掉这三张表最坏是"下次全量重对一遍账",
 * 不丢任何记忆——所以它们**不进快照哈希投影**(T0.10 守卫钉死)、不需要迁移。
 *
 * 三表分工:
 * - `ext_drivers`:驱动注册行(配置是事实源,这里只是运行态镜像 + 健康缓存位);
 * - `ext_shadow`:本地记录 ↔ 外部条目的映射与四象限指纹——同步判据的唯一载体。
 *   身份锚是 `ext_key`(跨 record_id 稳定),`record_id` 只是当前指向的线索
 *   (merge 会换新 id,影子靠 ext_key 重挂,不随合并断链);
 * - `ext_outbox`:出站意图队列。写路径只入队(同步、本地、零网络),网络动作
 *   全部发生在后台泵里——"本地先行落库、同步状态挂 pending"是写侧唯一的
 *   不阻塞形态。`(driver,space,record,intent)` 的 pending 唯一索引让重复点火
 *   天然合并成一条。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryLogger } from '../types.js';
export declare const EXT_SYNC_DDL_VERSION = 2;
/** sync_state 九值(计划 spec 影子层节;`unforgettable`=远端根本没有删除口,如 byterover)。 */
export declare const EXT_SHADOW_STATES: readonly ["clean", "local_dirty", "remote_dirty", "both_dirty", "awaiting_settle", "orphan", "linked_remote_missing", "unforgettable", "dead"];
export type ExtShadowState = (typeof EXT_SHADOW_STATES)[number];
/** 出站意图。retire+appendNew 同 extKey 的折叠在 pusher 侧做,这里只存原始意图。 */
export declare const EXT_OUTBOX_INTENTS: readonly ["add", "update", "forget", "relink"];
export type ExtOutboxIntent = (typeof EXT_OUTBOX_INTENTS)[number];
export declare const EXT_OUTBOX_STATUSES: readonly ["pending", "running", "awaiting_settle", "done", "dead"];
export type ExtOutboxStatus = (typeof EXT_OUTBOX_STATUSES)[number];
export declare const EXT_SYNC_SCHEMA = "\nCREATE TABLE IF NOT EXISTS ext_drivers (\n  driver_id     TEXT PRIMARY KEY,\n  type_id       TEXT NOT NULL,\n  enabled       INTEGER NOT NULL DEFAULT 1,\n  capabilities_json TEXT NOT NULL DEFAULT '{}',\n  score_semantics   TEXT NOT NULL DEFAULT 'none',\n  conn_json     TEXT NOT NULL DEFAULT '{}',\n  secret_refs   TEXT NOT NULL DEFAULT '',\n  status        TEXT NOT NULL DEFAULT 'active',\n  healthy       INTEGER NOT NULL DEFAULT 0,\n  last_probe_at INTEGER NOT NULL DEFAULT 0,\n  last_error    TEXT NOT NULL DEFAULT '',\n  created_time  TEXT NOT NULL DEFAULT (datetime('now')),\n  updated_time  TEXT NOT NULL DEFAULT (datetime('now'))\n);\n\nCREATE TABLE IF NOT EXISTS ext_shadow (\n  shadow_id     TEXT PRIMARY KEY,\n  driver_id     TEXT NOT NULL,\n  space_id      TEXT NOT NULL,\n  record_id     TEXT NOT NULL,\n  ext_key       TEXT NOT NULL DEFAULT '',\n  external_id   TEXT NOT NULL DEFAULT '',\n  alias_of      TEXT NOT NULL DEFAULT '',\n  ext_uri       TEXT NOT NULL DEFAULT '',\n  db_digest     TEXT NOT NULL DEFAULT '',\n  ext_digest    TEXT NOT NULL DEFAULT '',\n  content_norm  TEXT NOT NULL DEFAULT '',\n  sync_state    TEXT NOT NULL DEFAULT 'clean',\n  pending_op    TEXT NOT NULL DEFAULT '',\n  settle_deadline INTEGER NOT NULL DEFAULT 0,\n  last_synced_at INTEGER NOT NULL DEFAULT 0,\n  created_time  TEXT NOT NULL DEFAULT (datetime('now')),\n  updated_time  TEXT NOT NULL DEFAULT (datetime('now'))\n);\nCREATE UNIQUE INDEX IF NOT EXISTS ext_shadow_rec_uidx\n  ON ext_shadow(driver_id, space_id, record_id);\nCREATE UNIQUE INDEX IF NOT EXISTS ext_shadow_extid_uidx\n  ON ext_shadow(driver_id, space_id, external_id) WHERE external_id <> '';\nCREATE INDEX IF NOT EXISTS ext_shadow_state_idx\n  ON ext_shadow(sync_state, updated_time);\nCREATE INDEX IF NOT EXISTS ext_shadow_extkey_idx\n  ON ext_shadow(driver_id, ext_key);\n\nCREATE TABLE IF NOT EXISTS ext_outbox (\n  job_id          TEXT PRIMARY KEY,\n  driver_id       TEXT NOT NULL,\n  space_id        TEXT NOT NULL,\n  record_id       TEXT NOT NULL,\n  intent          TEXT NOT NULL,\n  payload_digest  TEXT NOT NULL DEFAULT '',\n  priority        INTEGER NOT NULL DEFAULT 0,\n  status          TEXT NOT NULL DEFAULT 'pending',\n  attempts        INTEGER NOT NULL DEFAULT 0,\n  next_attempt_at INTEGER NOT NULL DEFAULT 0,\n  error           TEXT NOT NULL DEFAULT '',\n  created_time    TEXT NOT NULL DEFAULT (datetime('now')),\n  updated_time    TEXT NOT NULL DEFAULT (datetime('now'))\n);\nCREATE INDEX IF NOT EXISTS ext_outbox_pick_idx\n  ON ext_outbox(status, priority, next_attempt_at);\nCREATE UNIQUE INDEX IF NOT EXISTS ext_outbox_dedup_uidx\n  ON ext_outbox(driver_id, space_id, record_id, intent)\n  WHERE status IN ('pending','running','awaiting_settle');\n\nCREATE TABLE IF NOT EXISTS ext_conflicts (\n  conflict_id   TEXT PRIMARY KEY,\n  driver_id     TEXT NOT NULL,\n  space_id      TEXT NOT NULL,\n  record_id     TEXT NOT NULL,\n  external_id   TEXT NOT NULL DEFAULT '',\n  kind          TEXT NOT NULL,\n  db_digest     TEXT NOT NULL DEFAULT '',\n  ext_digest    TEXT NOT NULL DEFAULT '',\n  detail_json   TEXT NOT NULL DEFAULT '{}',\n  status        TEXT NOT NULL DEFAULT 'open',\n  resolution    TEXT NOT NULL DEFAULT '',\n  created_time  TEXT NOT NULL DEFAULT (datetime('now')),\n  updated_time  TEXT NOT NULL DEFAULT (datetime('now'))\n);\nCREATE UNIQUE INDEX IF NOT EXISTS ext_conflicts_open_uidx\n  ON ext_conflicts(driver_id, space_id, record_id, external_id, kind) WHERE status = 'open';\nCREATE INDEX IF NOT EXISTS ext_conflicts_status_idx\n  ON ext_conflicts(status, updated_time);\n\nCREATE TABLE IF NOT EXISTS ext_cursor (\n  driver_id     TEXT NOT NULL,\n  space_id      TEXT NOT NULL,\n  cursor_json   TEXT NOT NULL DEFAULT '{}',\n  updated_time  TEXT NOT NULL DEFAULT (datetime('now')),\n  PRIMARY KEY (driver_id, space_id)\n);\n\n/*\n * \u5BFC\u5165\u65AD\u70B9\u4E0E\u7ED3\u679C\uFF08\u8BA1\u5212 ext-to-l1-import\uFF09\u3002\n *\n * \u4E0D\u590D\u7528 ext_cursor\uFF1A\u90A3\u5F20\u8868\u5B58\u7684\u662F\u201C\u5BF9\u8D26\u6E38\u6807\u201D\uFF08\u9A71\u52A8\u81EA\u5B9A\u4E49\u7684\u589E\u91CF\u8BED\u4E49\uFF09\uFF0C\u8FD9\u5F20\u5B58\u7684\u662F\n * \u201C\u5BFC\u5165\u7FFB\u9875\u5230\u54EA\u513F\u4E86\u201D\u3002\u4E24\u8005\u8BED\u4E49\u4E92\u65A5\u2014\u2014\u5BF9\u8D26\u63A8\u8FDB\u6E38\u6807\u4F1A\u76F4\u63A5\u6BC1\u6389\u5BFC\u5165\u65AD\u70B9\uFF0C\n * \u5408\u5728\u4E00\u5F20\u8868\u91CC\u5C31\u662F\u201C\u4E00\u4E2A\u52A8\u4F5C\u9759\u9ED8\u62B9\u6389\u53E6\u4E00\u4E2A\u52A8\u4F5C\u7684\u8FDB\u5EA6\u201D\u3002\n */\nCREATE TABLE IF NOT EXISTS ext_import (\n  driver_id     TEXT NOT NULL,\n  space_id      TEXT NOT NULL,\n  offset_rows   INTEGER NOT NULL DEFAULT 0,\n  imported      INTEGER NOT NULL DEFAULT 0,\n  skipped       INTEGER NOT NULL DEFAULT 0,\n  state         TEXT NOT NULL DEFAULT 'idle',\n  updated_time  TEXT NOT NULL DEFAULT (datetime('now')),\n  PRIMARY KEY (driver_id, space_id)\n);\n";
export interface ExtDriverRow {
    driverId: string;
    typeId: string;
    enabled: boolean;
    capabilitiesJson: string;
    scoreSemantics: string;
    connJson: string;
    secretRefs: string;
    status: string;
    healthy: boolean;
    lastProbeAt: number;
    lastError: string;
}
export interface ExtShadowRow {
    shadowId: string;
    driverId: string;
    spaceId: string;
    recordId: string;
    extKey: string;
    externalId: string;
    aliasOf: string;
    extUri: string;
    dbDigest: string;
    extDigest: string;
    contentNorm: string;
    syncState: ExtShadowState;
    pendingOp: string;
    settleDeadline: number;
    lastSyncedAt: number;
}
export interface ExtOutboxRow {
    jobId: string;
    driverId: string;
    spaceId: string;
    recordId: string;
    intent: ExtOutboxIntent;
    payloadDigest: string;
    priority: number;
    status: ExtOutboxStatus;
    attempts: number;
    nextAttemptAt: number;
    error: string;
}
/** 冲突账(kind 三族):both_dirty=两边都变挂账;orphan=远端寻不到影;unforgettable=远端无删除口。 */
export declare const EXT_CONFLICT_KINDS: readonly ["both_dirty", "orphan", "unforgettable"];
export type ExtConflictKind = (typeof EXT_CONFLICT_KINDS)[number];
export interface ExtConflictRow {
    conflictId: string;
    driverId: string;
    spaceId: string;
    recordId: string;
    externalId: string;
    kind: ExtConflictKind;
    dbDigest: string;
    extDigest: string;
    detailJson: string;
    status: string;
    resolution: string;
}
export declare class ExtSyncStore {
    private db;
    private logger;
    /** 建表(幂等)。自带 try/catch:失败则本 store 保持未注入态,全部方法 no-op,
     *  不传染主库降级(与 GraphStore.init 同纪律,调用方无需再包一层)。 */
    init(db: DatabaseSync, logger?: MemoryLogger): void;
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
    private migrateConflictUniq;
    close(): void;
    get ready(): boolean;
    upsertDriver(row: {
        driverId: string;
        typeId: string;
        enabled: boolean;
        capabilitiesJson?: string;
        scoreSemantics?: string;
        connJson?: string;
        secretRefs?: string;
    }): void;
    /** 健康探测缓存位写入(探测级 60s 缓存的消费方在 Phase 1 lane 侧)。 */
    recordProbe(driverId: string, healthy: boolean, error?: string): void;
    listDrivers(): ExtDriverRow[];
    /** 影子行 upsert(按 driver+space+record 唯一位)。shadowId 由调用方给定(稳定派生)。 */
    upsertShadow(row: {
        shadowId: string;
        driverId: string;
        spaceId: string;
        recordId: string;
        extKey?: string;
        externalId?: string;
        aliasOf?: string;
        extUri?: string;
        dbDigest?: string;
        extDigest?: string;
        contentNorm?: string;
        syncState?: ExtShadowState;
        pendingOp?: string;
        settleDeadline?: number;
        lastSyncedAt?: number;
    }): void;
    getShadowByRecord(driverId: string, spaceId: string, recordId: string): ExtShadowRow | undefined;
    getShadowByExternal(driverId: string, spaceId: string, externalId: string): ExtShadowRow | undefined;
    /** 映射了结(外部 forget 确认后删行):历史流水在 outbox(status=done 行)里,影子表只活在账。 */
    deleteShadow(shadowId: string): void;
    /**
     * 冲突挂账(可重复调):同 (driver,space,record,external,kind) 的 open 行幂等——
     * 重复冲突只刷新 detail/指纹与 updated_time,**不堆行**（面板一屏一条）。
     *
     * 去重键必须含 external_id，与 `ext_conflicts_open_uidx` 逐项对齐：
     * “无本地记录”的 unforgettable 挂账 record_id 恒为空串，不拿 external_id 区分时
     * 第二条会直接 UPDATE 掉第一条（stats.conflicts 报 N、表里只存 1），
     * 其余条目既不入库也不在任何待办里——静默丢失。
     */
    upsertConflict(row: {
        conflictId: string;
        driverId: string;
        spaceId: string;
        recordId: string;
        externalId?: string;
        kind: ExtConflictKind;
        dbDigest?: string;
        extDigest?: string;
        detail?: Record<string, unknown>;
    }): void;
    listConflicts(opts?: {
        status?: string;
        kind?: ExtConflictKind;
        limit?: number;
        offset?: number;
    }): ExtConflictRow[];
    countConflicts(): {
        open: number;
        byKind: Record<string, number>;
    };
    /** 裁决/忽略;同键再冲突时 upsertConflict 会重新挂 open(可重开,不封死)。 */
    resolveConflict(conflictId: string, resolution: string): boolean;
    dismissConflict(conflictId: string): boolean;
    /** 增量拉取游标(cursor 家的 sincePull 断点;json 不透明,由驱动自解)。 */
    getCursor(driverId: string, spaceId: string): Record<string, string | number>;
    setCursor(driverId: string, spaceId: string, cursor: Record<string, unknown>): void;
    /**
     * 导入断点落盘（每页提交后调一次）。写失败不阻断导入——断点丢只造成重复翻页，
     * ext_key 幂等会兜住；而因断点写不进就中断导入，会把一个存储问题放大成功能故障。
     */
    upsertImport(prog: {
        driverId: string;
        spaceId: string;
        offset: number;
        imported: number;
        skipped: number;
        state: string;
    }): void;
    /** 导入断点（无记录 = null，调用方按“从头开始”处理）。 */
    getImport(driverId: string, spaceId: string): {
        offset: number;
        imported: number;
        skipped: number;
        state: string;
    } | null;
    /** 清断点（导入完成/用户主动重置）；下一次从头来。 */
    clearImport(driverId: string, spaceId: string): void;
    /** 最早一个待派发任务的到票时刻(ms;无待办 = 0)——推送泵的一次性重臂定时器用它。 */
    earliestPendingWake(): number;
    /** 按驱动计影子条数(面板删除/编辑前的"已有账本"提醒)。 */
    countShadowsByDriver(driverId: string): number;
    /** 某记录的全部影子跨驱动列举(三侧裁决的 remote 输入面,T4.1)。 */
    listShadowsByRecord(recordId: string): ExtShadowRow[];
    /** merge 换 id 后的重挂位:按 ext_key 找影子(身份在 key 上,不在 record_id 上)。 */
    findShadowsByExtKey(driverId: string, extKey: string): ExtShadowRow[];
    /**
     * merge 重挂(冲突解决⑥ 身份漂移的落盘动作):把指向 (oldRecordId) 的影子行
     * 改指 newRecordId——**移动**而非新插,因为 (driver,space,external_id) 唯一索引
     * 决定了同一外部条目只能有一条在账影子;新插同 externalId 会被约束拒绝。
     * 不动 ext_key(它才是认人锚),刷 updated_time。
     */
    repointShadowRecord(driverId: string, spaceId: string, oldRecordId: string, newRecordId: string): boolean;
    /** 按状态列(面板计数/回捞扫描共用;limit 封顶防大账本拖死 RPC)。 */
    listShadowsByState(state: ExtShadowState, limit?: number): ExtShadowRow[];
    countShadows(): Record<ExtShadowState, number>;
    /**
     * 意图入队(同步写、零网络)。重复点火被 pending 唯一索引吃掉(INSERT OR IGNORE)
     * ——写侧的幂等来自**索引**而不是调用方自觉,与 conflictPairId 同一手法。
     * @returns true = 新增了一条待办;false = 同四元组的在途任务已存在(或降级 no-op)。
     */
    enqueueOutbox(row: {
        jobId: string;
        driverId: string;
        spaceId: string;
        recordId: string;
        intent: ExtOutboxIntent;
        payloadDigest?: string;
        priority?: number;
        nextAttemptAt?: number;
    }): boolean;
    /** 取到期待办(priority 高者先、同优先级按入队序;驱动级串行由 pusher 自己保证)。 */
    pickDueOutbox(nowMs: number, limit: number): ExtOutboxRow[];
    setOutboxStatus(jobId: string, status: ExtOutboxStatus, opts?: {
        error?: string;
        nextAttemptAt?: number;
        attempts?: number;
    }): void;
    bumpOutboxAttempt(jobId: string, nextAttemptAt: number, error: string): void;
    countOutbox(): {
        pending: number;
        dead: number;
    };
    /** 单驱动在途待同步数(面板驱动卡用;not ready = 0)。 */
    outboxPendingByDriver(driverId: string): number;
}
