/**
 * SQLite 主检索引擎(单机裁剪版)。
 *
 * 双写架构:JSONL 追加文件是备份/恢复的事实源,本库承担全部检索——L0/L1 的
 * 检索不再扫文件、不再全量载入内存。
 *
 * - l1_records / l0_conversations:结构化元数据表;
 * - l1_fts / l0_fts:FTS5 BM25 全文索引(content 列存分词结果,其余列 UNINDEXED 随行携带);
 * - l1_vec / l0_vec:sqlite-vec vec0 余弦向量表(仅 embedding 启用且维度 > 0 时创建)。
 *
 * 降级规则(degrade-don't-crash):
 * - sqlite-vec 加载失败 → 纯 FTS 模式,能力位 vectorSearch=false;
 * - FTS5 建表失败 → ftsSearch=false;
 * - 任何一步 schema 初始化失败 → degraded=true,全部读写变为安全 no-op,
 *   由上层走 storageOk=false 降级链路,绝不拖垮宿主启动。
 *
 * DDL/行格式是磁盘契约:建表语句、列名、timestamp_str 逗号连接 ISO 格式、
 * embedding_meta 的 kv 约定一律不可更动,否则老用户的库不可读。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EmbeddingProviderInfo } from './embedding.js';
import type { L0MessageRecord, MemoryFamily, MemoryLogger, MemoryRecord } from '../types.js';
import { familyForType, isScopeVisible, normPersistence, normScope } from '../types.js';
import { isZeroVector, vecToBuffer } from './vec-utils.js';
import { normalizeWorkspacePath } from '../workspace.js';
import { bm25RankToScore, buildFtsQuery, tokenizeForFts } from './search-utils.js';
import { describeTokenizer, ensureTokenizer, tokenizerStamp } from '../util/tokenizer.js';

const require = createRequire(import.meta.url);

const TAG = '[memory][sqlite]';

export interface StoreInitResult {
  /** embedding 配置(provider/model/维度)变化,需要后台全量重嵌入。 */
  needsReindex: boolean;
  reason?: string;
}

export interface StoreCapabilities {
  ftsSearch: boolean;
  vectorSearch: boolean;
}

// 成本账本(token_cost 表族)独立职责,此处 re-export 不断裂既有引用;
// MemoryDb 的四个公开方法为一行委托。
import { CostLedger } from './cost-ledger.js';
import type { BucketRow, CostAggregate, CostByLayer } from './cost-ledger.js';
export type { BucketRow, CostAggregate, CostByLayer } from './cost-ledger.js';
import type { CostByModel } from '../contract.js';
// 图谱存储(graph_* 表族)同为独立职责类;init 失败仅图谱 no-op,不传染主库降级
import { GraphStore } from './graph-store.js';
import { RECEIPTS_MAX_RUNS, RECEIPTS_QUERY_LIMIT_MAX } from './receipts.js';
import type { L1Receipt, ReceiptQuery, ReceiptRetentionOptions } from './receipts.js';
import type { ConflictPair, ConflictResolution } from './conflicts.js';
import { isRetired, readSupersedeMarker, stripSupersedeMarker, withSupersedeMarker, type SupersedeInfo } from './supersede.js';

/** L1 检索命中(含 BM25/余弦归一分数)。 */
export interface L1SearchHit {
  id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  score: number;
  family: MemoryFamily;
}

/** L0 检索命中。 */
export interface L0SearchHit extends L0MessageRecord {
  score: number;
}

interface EmbeddingMeta {
  provider: string;
  model: string;
  dimensions: number;
}

interface StatementLike {
  run(...params: unknown[]): { changes: number | bigint };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

/** vec0 KNN 对遗留零向量的补偿缓冲。 */
const ZERO_VEC_BUFFER = 10;

/** IN 查询/删除的分块大小(保守避开 SQLite 变量数上限:现代构建 32766,老版 999)。 */
const IN_CHUNK = 900;

/** 零向量 skip 集上限(≤ IN_CHUNK:notInClause 不分块,占位符数即集合大小)。 */
const VEC_SKIP_CAP = 900;

/** 把 id 列表切成 ≤IN_CHUNK 的块(分块执行后合并语义等价于单次 IN)。 */
function chunkIds(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(ids.slice(i, i + IN_CHUNK));
  return out;
}

export class MemoryDb {
  private db!: DatabaseSync;
  private degraded = false;
  private ftsAvailable = false;
  private vecLoaded = false;
  private vecLoadWarned = false;
  /** 向量维度:活切换嵌入源时会变——vec0 表随维度重建。 */
  private dimensions: number;
  private readonly logger?: MemoryLogger;

  private stmtUpsertL1!: StatementLike;
  private stmtGetL1!: StatementLike;
  /** 主表存在性点查(防御性 FTS 删除的前置判断,走主键索引)。 */
  private stmtL1Exists!: StatementLike;
  private stmtDeleteL1Meta!: StatementLike;
  private stmtDeleteL1Vec?: StatementLike;
  private stmtInsertL1Vec?: StatementLike;
  private stmtSearchL1Vec?: StatementLike;
  private stmtL1FtsInsert!: StatementLike;
  private stmtL1FtsDelete!: StatementLike;
  private stmtL1FtsSearch!: StatementLike;
  private stmtL1FtsSearchFamily!: StatementLike;
  /** 成本账本(token_cost 表族;init 内初始化,未就绪时方法返回零值)。 */
  readonly costLedger = new CostLedger();
  /** 图谱存储(graph_* 表族;init 独立 try/catch,失败仅图谱 no-op)。 */
  readonly graphStore = new GraphStore();

  private stmtUpsertL0!: StatementLike;
  private stmtGetL0!: StatementLike;
  private stmtL0Exists!: StatementLike;
  private stmtDeleteL0Vec?: StatementLike;
  private stmtInsertL0Vec?: StatementLike;
  private stmtSearchL0Vec?: StatementLike;
  private stmtL0FtsInsert!: StatementLike;
  private stmtL0FtsDelete!: StatementLike;
  private stmtL0FtsSearch!: StatementLike;

  /** 按块缓存的 IN 语句(表名/动作/尺寸 → 预编译语句):热路径不再每次动态 prepare。 */
  private readonly inStmts = new Map<string, StatementLike>();

  constructor(dbPath: string, dimensions: number, logger?: MemoryLogger) {
    this.dimensions = dimensions;
    this.logger = logger;

    // 构造永不抛出(storage-degrade 不变量):开库/PRAGMA 任一失败 → 降级模式,
    // 全部读写变为安全 no-op,宿主照常启动。
    try {
      const dbDir = path.dirname(dbPath);
      if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

      const { DatabaseSync: DbSync } = require('node:sqlite') as typeof import('node:sqlite');
      this.db = new DbSync(dbPath, { allowExtension: true });

      // 并发读优化 + 有界内存;synchronous NORMAL 是 WAL 下的官方推荐——批量写从
      // "每事务一次 fsync"降为"每 checkpoint 一次",重嵌入/导入提速明显;
      // 代价仅是断电时丢最后若干已提交事务(只丢不损,无损坏风险)
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA cache_size = -65536');
      this.db.exec('PRAGMA mmap_size = 134217728');
      this.db.exec('PRAGMA wal_autocheckpoint = 1000');
    } catch (err) {
      this.degraded = true;
      this.logger?.error(
        `${TAG} 数据库打开失败,存储进入降级模式(记忆读写停用): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): StoreCapabilities {
    return {
      ftsSearch: this.ftsAvailable && !this.degraded,
      vectorSearch: this.vecLoaded && this.dimensions > 0 && !this.degraded,
    };
  }

  /** 统一事务边界:fn 抛出即 ROLLBACK 并把错误上抛(替代散落的手写 BEGIN/COMMIT/ROLLBACK)。 */
  private withTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /**
   * 加载 sqlite-vec 扩展并建 schema。构造后必须调用一次。
   * providerInfo 变化(provider/model/维度)时 drop 向量表并返回 needsReindex。
   */
  init(providerInfo?: EmbeddingProviderInfo): StoreInitResult {
    // 构造期已降级(开库失败)→ 直接短路
    if (this.degraded) return { needsReindex: false, reason: 'database open failed' };
    // dimensions=0 是合法的"纯 FTS 模式",不能因 sqlite-vec 缺失而降级;
    // 后续活切换本地嵌入(维度 > 0)时由 swapProvider 补加载
    this.ensureVecLoaded();
    // 分词器在首次 FTS 写入(迁移回灌)前定死模式:jieba 就绪 info / 回退 warn 一次
    ensureTokenizer();
    this.logger?.info(`${TAG} 分词器:${describeTokenizer()}`);
    try {
      return this.initSchema(providerInfo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(`${TAG} schema 初始化失败,存储进入降级模式: ${message}`);
      this.degraded = true;
      return { needsReindex: false, reason: `schema init failed: ${message}` };
    }
  }

  /** 惰性加载 sqlite-vec(纯 FTS 起步后切本地嵌入时补加载);失败只停用向量能力并告警一次。 */
  private ensureVecLoaded(): void {
    if (this.vecLoaded || this.dimensions <= 0) return;
    try {
      const sqliteVec = require('sqlite-vec') as { load(db: unknown): void };
      this.db.enableLoadExtension(true);
      try {
        sqliteVec.load(this.db);
        this.vecLoaded = true;
      } finally {
        // 加载失败也必须复位扩展开关,不留常开的扩展加载面
        this.db.enableLoadExtension(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.vecLoadWarned) {
        this.vecLoadWarned = true;
        this.logger?.warn(`${TAG} sqlite-vec 加载失败,向量检索停用(降级为纯 FTS): ${message}`);
      }
    }
  }

  /**
   * 活切换嵌入源:provider/model/维度任一变化 → drop 向量表按新维度重建,
   * 返回 needsReindex=true(调用方后台重嵌,全部成功后 markEmbeddingSynced);
   * 配置未变化 → false(切回同一模型不重嵌)。
   * 新维度 > 0 但 sqlite-vec 不可用 → ok=false(调用方向用户说明,维持 FTS)。
   */
  swapProvider(info: EmbeddingProviderInfo): { ok: boolean; needsReindex: boolean; error?: string } {
    if (this.degraded) return { ok: false, needsReindex: false, error: '数据库降级模式' };
    if (info.dimensions <= 0) {
      // 关闭档不走此路径(只换服务实例);防御性兜底:不动表,无需重嵌
      this.dimensions = 0;
      return { ok: true, needsReindex: false };
    }
    // 先置新维度再懒加载(ensureVecLoaded 以 dimensions>0 为门)——0 维起步的库
    // 在首次活切本地/远程嵌入时此处补加载 sqlite-vec
    this.dimensions = info.dimensions;
    this.ensureVecLoaded();
    if (!this.vecLoaded) {
      return { ok: false, needsReindex: false, error: 'sqlite-vec 扩展不可用,无法启用向量检索' };
    }
    // unchanged 判据不能只信 embedding_meta:取消/崩溃路径可能留下"meta=旧 provider、
    // 物理表=新维度"的错位(切换已 drop 并按新维度重建,但重嵌取消/失败没写 meta)。
    // 只比对 meta 会在切回旧源时跳过 drop → 旧维度服务往新维度表写向量 → vec0 抛错
    // → upsert 整体回滚 → 记录从检索库静默消失。必须同时校验物理表的真实维度。
    const saved = this.readEmbeddingMeta();
    const physical = this.physicalVecDims();
    const unchanged =
      saved &&
      saved.provider === info.provider &&
      saved.model === info.model &&
      saved.dimensions === info.dimensions &&
      physical === info.dimensions;
    if (unchanged) return { ok: true, needsReindex: false };
    this.dropVectorTables();
    return { ok: true, needsReindex: true };
  }

  /** l1_vec 物理表的向量维度(建表 DDL 里的 float[N]);无表返回 null。 */
  private physicalVecDims(): number | null {
    try {
      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'l1_vec'")
        .get() as { sql?: string } | undefined;
      if (!row?.sql) return null;
      const m = /float\[(\d+)\]/.exec(row.sql);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  private initSchema(providerInfo?: EmbeddingProviderInfo): StoreInitResult {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // ── embedding 配置变化检测 → 重建向量表 ──
    let needsReindex = false;
    let reason: string | undefined;
    const savedMeta = this.readEmbeddingMeta();
    if (providerInfo) {
      if (savedMeta) {
        const providerChanged = savedMeta.provider !== providerInfo.provider;
        const modelChanged = savedMeta.model !== providerInfo.model;
        const dimsChanged = savedMeta.dimensions !== this.dimensions;
        if (providerChanged || modelChanged || dimsChanged) {
          const reasons: string[] = [];
          if (providerChanged) reasons.push(`provider: ${savedMeta.provider} → ${providerInfo.provider}`);
          if (modelChanged) reasons.push(`model: ${savedMeta.model} → ${providerInfo.model}`);
          if (dimsChanged) reasons.push(`dimensions: ${savedMeta.dimensions} → ${this.dimensions}`);
          reason = reasons.join(', ');
          this.logger?.info(`${TAG} embedding 配置变化(${reason}),重建向量表`);
          this.dropVectorTables();
          needsReindex = true;
        }
      } else if (this.countL1() > 0 || this.countL0() > 0) {
        // 已有数据但无 meta 记录(首次启用 embedding)→ 需要全量重嵌入
        this.dropVectorTables();
        needsReindex = true;
        reason = 'embedding 首次启用,已有数据需要重嵌入';
      }
    }

    // ── L1 schema(DDL 为磁盘契约,逐字节不可变) ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l1_records (
        record_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50,
        scene_name TEXT DEFAULT '',
        session_id TEXT DEFAULT 'default',
        version INTEGER NOT NULL DEFAULT 0,
        timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}',
        family TEXT NOT NULL DEFAULT 'chat',
        scope TEXT NOT NULL DEFAULT 'global',
        workspace_id TEXT NOT NULL DEFAULT ''
      )
    `);
    // 旧库缺 family 列 → ALTER 补列,并按 type 前缀回填(幂等:已正确的行不再命中)
    if (!this.hasColumn('l1_records', 'family')) {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN family TEXT NOT NULL DEFAULT 'chat'");
      this.logger?.info(`${TAG} l1_records 补 family 列(旧数据按 type 前缀回填)`);
    }
    // §E 可见范围(ADR-0008 条 3:向后兼容是硬要求)。**既有数据零搬运**——
    // 补列的 DEFAULT 本身就把存量行标成 `global`,不需要 UPDATE 扫描,
    // 也不删除任何行:"标注归属"而非"搬运/重建",免得拿事实源冒险换配置项的美观。
    if (!this.hasColumn('l1_records', 'scope')) {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'");
      this.db.exec("ALTER TABLE l1_records ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''");
      this.logger?.info(`${TAG} l1_records 补 scope/workspace_id 列(存量数据默认归 global)`);
    }
    const backfilled = this.db
      .prepare("UPDATE l1_records SET family = 'work' WHERE type LIKE 'work\\_%' ESCAPE '\\' AND family != 'work'")
      .run().changes;
    if (backfilled > 0) this.logger?.info(`${TAG} family 回填 ${backfilled} 条 work 记录`);
    this.ensureTemporalColumns();
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l1_type ON l1_records(type)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l1_scene ON l1_records(scene_name)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l1_ts_start ON l1_records(timestamp_start)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l1_updated ON l1_records(updated_time)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l1_family ON l1_records(family)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l1_valid_from ON l1_records(valid_from)');
    // §E:workspace 过滤的唯一命中路径就是本列(scope='global' 的行走 OR 短路,不依赖索引)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l1_workspace ON l1_records(workspace_id)');

    // ── §B L1 决策凭证(DDL 同为磁盘契约) ──
    // 每条 L1 记录的 store/update/merge/skip 决策留一条凭证:决策当时看到的候选池
    // 摘要(input_digest)+ 结论(kind)。凭证必须在事件**之前**存在——输入快照
    // 无法事后补录,故本表先于任何消费方落地(findings.md §9)。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l1_receipts (
        receipt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL DEFAULT '',
        record_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT '',
        input_digest TEXT NOT NULL DEFAULT '',
        decided_at TEXT NOT NULL DEFAULT ''
      )
    `);
    // 双维回溯(task_19):按批(run_id)看一轮蒸馏的全部决策;按记录(record_id 看单条记忆的完整判定史
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l1_receipts_run ON l1_receipts(run_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l1_receipts_record ON l1_receipts(record_id)');

    // ── §C 矛盾冻结:(DDL 同为磁盘契约) ──
    // 冻结**不是"拦住写入"**:新记忆照常入 l1_records,与冲突的旧记忆作为**一对**
    // 停放在本表,双方内容都不被改写,直到人工裁决。LLM 给的 winner_id 只表示
    // "进入待裁决对时的排序位",**不代表最终结论**——最终结论落在 resolution。
    // resolved_at 用 '' 而非 NULL 表示未裁决,与 l1_receipts 的约定一致,
    // 避免 `= ''` 与 `IS NULL` 两套判据并存。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conflict_pending (
        pair_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL DEFAULT '',
        winner_id TEXT NOT NULL DEFAULT '',
        loser_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        resolved_at TEXT NOT NULL DEFAULT '',
        resolution TEXT NOT NULL DEFAULT ''
      )
    `);
    // 未裁决索引:队列上限(task_24,取最旧的未裁决行)与裁决工具(task_25,取单条未裁决对)
    // 都只关心未裁决行——"查未裁决"须走索引。偏索引同时覆盖 created_at 排序。
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_conflict_pending_unresolved
         ON conflict_pending(created_at) WHERE resolved_at = ''`,
    );

    this.stmtUpsertL1 = this.db.prepare(`
      INSERT INTO l1_records (
        record_id, content, type, priority, scene_name, session_id, version,
        timestamp_str, timestamp_start, timestamp_end, created_time, updated_time, metadata_json, family,
        valid_from, valid_to, persistence, scope, workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        content=excluded.content,
        type=excluded.type,
        priority=excluded.priority,
        scene_name=excluded.scene_name,
        version=excluded.version,
        timestamp_str=excluded.timestamp_str,
        timestamp_start=excluded.timestamp_start,
        timestamp_end=excluded.timestamp_end,
        updated_time=excluded.updated_time,
        metadata_json=excluded.metadata_json,
        family=excluded.family,
        valid_from=excluded.valid_from,
        valid_to=excluded.valid_to,
        persistence=excluded.persistence,
        scope=excluded.scope,
        workspace_id=excluded.workspace_id
    `);
    this.stmtGetL1 = this.db.prepare(`
      SELECT record_id, content, type, priority, scene_name, version, timestamp_str,
             timestamp_start, timestamp_end, created_time, updated_time, metadata_json, family,
             valid_from, valid_to, persistence, scope, workspace_id
      FROM l1_records WHERE record_id = ?
    `);
    this.stmtL1Exists = this.db.prepare('SELECT 1 FROM l1_records WHERE record_id = ?');
    this.stmtDeleteL1Meta = this.db.prepare('DELETE FROM l1_records WHERE record_id = ?');
    this.prepareL1VecStatements();

    // ── L0 schema ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l0_conversations (
        record_id TEXT PRIMARY KEY,
        session_id TEXT DEFAULT 'default',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0
      )
    `);
    // R7(2026-09-17):补 turn/step 两列,给 L1 锚点提供**可落库的坐标**。
    // 加列不改语义;旧行留 NULL ⇒ 读侧一律视作「无锚点」,不伪造回填。
    // 沿用本文件既有的 hasColumn 幂等补列范式(family / scope / workspace_id 同款)。
    if (!this.hasColumn('l0_conversations', 'turn')) {
      this.db.exec('ALTER TABLE l0_conversations ADD COLUMN turn INTEGER');
      this.logger?.info(`${TAG} l0_conversations 补 turn 列(旧行留空=无锚点)`);
    }
    if (!this.hasColumn('l0_conversations', 'step')) {
      this.db.exec('ALTER TABLE l0_conversations ADD COLUMN step INTEGER');
      this.logger?.info(`${TAG} l0_conversations 补 step 列(旧行留空=无锚点)`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l0_session_id ON l0_conversations(session_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l0_recorded ON l0_conversations(recorded_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_l0_timestamp ON l0_conversations(timestamp)');
    // 锚点定位的唯一命中路径是 (session_id, turn[, step]) —— 无索引时按锚点取消息要全扫。
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_l0_session_turn ON l0_conversations(session_id, turn)',
    );

    // turn/step 用 ON CONFLICT **保留旧值**:老写路径(不带锚点)覆盖同一 record_id 时
    // 不得把已落库的坐标抹成 NULL —— 坐标丢了就再也补不回来。
    this.stmtUpsertL0 = this.db.prepare(`
      INSERT INTO l0_conversations (record_id, session_id, role, message_text, recorded_at, timestamp, turn, step)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        session_id=excluded.session_id,
        role=excluded.role,
        message_text=excluded.message_text,
        recorded_at=excluded.recorded_at,
        timestamp=excluded.timestamp,
        turn=COALESCE(excluded.turn, l0_conversations.turn),
        step=COALESCE(excluded.step, l0_conversations.step)
    `);
    this.stmtGetL0 = this.db.prepare(
      'SELECT session_id, role, message_text, recorded_at, timestamp, turn, step FROM l0_conversations WHERE record_id = ?',
    );
    this.stmtL0Exists = this.db.prepare('SELECT 1 FROM l0_conversations WHERE record_id = ?');
    this.prepareL0VecStatements();
    // ── token_cost:蒸馏成本明细表(成本账本自治) ──
    this.costLedger.init(this.db, this.logger);
    // ── graph_*:知识图谱投影表族(GraphStore.init 自带 try/catch,失败仅图谱 no-op) ──
    // §F 节点向量列的维度**复用既有探测结果**（`vecLoaded` / `dimensions` 由
    // `prepareL1VecStatements` 之前的探测决定），不新增一套能力探测。探测未通过 →
    // 不传 → 图谱向量路结构性不存在（不建表、不告警、不抛）。
    this.graphStore.init(this.db, this.logger, this.vecLoaded && this.dimensions > 0 ? { dimensions: this.dimensions } : undefined);

    // ── FTS5 全文索引(建表失败仅停用 FTS,不降级整个库) ──
    try {
      // 索引重建判据(FTS5 无法 ALTER,只能 drop 后从源表全量回灌):
      // a) 旧 l1_fts 无 family 列;b) FTS 分词器版本戳 ≠ 当前生效分词器
      //    (无戳 = jieba 引入前的二元组索引;切换后旧 token 形态不再匹配,须重建)。
      const wantStamp = tokenizerStamp();
      const savedStamp = this.readMetaString('fts_tokenizer') ?? 'bigram-v1';
      const tokenizerChanged = savedStamp !== wantStamp;
      let ftsRebuilt = false;
      if (this.tableExists('l1_fts') && (!this.hasColumn('l1_fts', 'family') || !this.hasColumn('l1_fts', 'scope') || tokenizerChanged)) {
        this.db.exec('DROP TABLE l1_fts');
        ftsRebuilt = true;
        this.logger?.info(`${TAG} l1_fts 缺 family/scope 列或分词器已变更(${savedStamp} → ${wantStamp}),重建全文索引`);
      }
      let l0FtsRebuilt = false;
      if (this.tableExists('l0_fts') && tokenizerChanged) {
        this.db.exec('DROP TABLE l0_fts');
        l0FtsRebuilt = true;
        this.logger?.info(`${TAG} l0_fts 分词器已变更(${savedStamp} → ${wantStamp}),重建全文索引`);
      }
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
          content,
          content_original UNINDEXED,
          record_id UNINDEXED,
          type UNINDEXED,
          priority UNINDEXED,
          scene_name UNINDEXED,
          session_id UNINDEXED,
          version UNINDEXED,
          timestamp_str UNINDEXED,
          timestamp_start UNINDEXED,
          timestamp_end UNINDEXED,
          metadata_json UNINDEXED,
          family UNINDEXED,
          scope UNINDEXED,
          workspace_id UNINDEXED
        )
      `);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_fts USING fts5(
          message_text,
          message_text_original UNINDEXED,
          record_id UNINDEXED,
          session_id UNINDEXED,
          role UNINDEXED,
          recorded_at UNINDEXED,
          timestamp UNINDEXED
        )
      `);

      this.stmtL1FtsInsert = this.db.prepare(`
        INSERT INTO l1_fts (content, content_original, record_id, type, priority, scene_name,
          session_id, version, timestamp_str, timestamp_start, timestamp_end, metadata_json, family,
          scope, workspace_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtL1FtsDelete = this.db.prepare('DELETE FROM l1_fts WHERE record_id = ?');
      // §E 可见范围过滤的**唯一缝**。设计要点:
      // ① `? = ''` 是"不过滤"的哨兵——检索侧不传工作区标识(即 cfg.scope='global')时
      //    整个条件短路为真,行为与改动前逐字一致(**零漂移不是比对出来的,是构造出来的**);
      // ② 过滤表达式与 family 落在**同一条语句**里(ADR-0008 组合关系:scope 过滤必须与
      //    族隔离同层),否则会产出"看不见但已影响决策"的记忆——去重候选召回也走这里;
      // ③ `scope = 'global'` 分支让跨工作区可见的记忆在任何工作区都能被召回。
      this.stmtL1FtsSearch = this.db.prepare(`
        SELECT record_id, content_original AS content, type, priority, scene_name, version,
               timestamp_str, timestamp_start, timestamp_end, metadata_json, family, scope, workspace_id,
               bm25(l1_fts) AS rank
        FROM l1_fts
        WHERE l1_fts MATCH ? AND (? = '' OR scope = 'global' OR workspace_id = ?)
        ORDER BY rank ASC
        LIMIT ?
      `);
      // 族过滤版(FTS5 UNINDEXED 列可作行级过滤条件)
      this.stmtL1FtsSearchFamily = this.db.prepare(`
        SELECT record_id, content_original AS content, type, priority, scene_name, version,
               timestamp_str, timestamp_start, timestamp_end, metadata_json, family, scope, workspace_id,
               bm25(l1_fts) AS rank
        FROM l1_fts
        WHERE l1_fts MATCH ? AND family = ? AND (? = '' OR scope = 'global' OR workspace_id = ?)
        ORDER BY rank ASC
        LIMIT ?
      `);
      if (ftsRebuilt) this.backfillL1Fts();

      this.stmtL0FtsInsert = this.db.prepare(`
        INSERT INTO l0_fts (message_text, message_text_original, record_id, session_id, role, recorded_at, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtL0FtsDelete = this.db.prepare('DELETE FROM l0_fts WHERE record_id = ?');
      this.stmtL0FtsSearch = this.db.prepare(`
        SELECT record_id, message_text_original AS message_text, session_id, role, recorded_at, timestamp,
               bm25(l0_fts) AS rank
        FROM l0_fts
        WHERE l0_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);
      if (l0FtsRebuilt) this.backfillL0Fts();
      // 戳如实记录"构建当前 FTS 内容的分词器"(含全新空表:后续写入即该分词器)
      try {
        this.writeMetaString('fts_tokenizer', wantStamp);
      } catch {
        /* 戳写失败只影响下次启动多一次重建,不阻断 */
      }
      this.ftsAvailable = true;
    } catch (err) {
      this.ftsAvailable = false;
      this.logger?.warn(
        `${TAG} FTS5 不可用(可能未编译进 SQLite): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (providerInfo && this.countL1() === 0 && this.countL0() === 0) {
      // 空库 + 全新 meta:无历史向量,直接标记同步完成
      this.writeEmbeddingMeta(providerInfo);
    }
    return { needsReindex, reason };
  }

  private prepareL1VecStatements(): void {
    if (this.vecLoaded && this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}] distance_metric=cosine,
          updated_time TEXT DEFAULT ''
        )
      `);
      this.stmtDeleteL1Vec = this.db.prepare('DELETE FROM l1_vec WHERE record_id = ?');
      this.stmtInsertL1Vec = this.db.prepare(
        'INSERT INTO l1_vec (record_id, embedding, updated_time) VALUES (?, ?, ?)',
      );
      this.stmtSearchL1Vec = this.db.prepare(`
        SELECT record_id, distance
        FROM l1_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    } else {
      this.stmtDeleteL1Vec = undefined;
      this.stmtInsertL1Vec = undefined;
      this.stmtSearchL1Vec = undefined;
    }
  }

  private prepareL0VecStatements(): void {
    if (this.vecLoaded && this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}] distance_metric=cosine,
          recorded_at TEXT DEFAULT ''
        )
      `);
      this.stmtDeleteL0Vec = this.db.prepare('DELETE FROM l0_vec WHERE record_id = ?');
      this.stmtInsertL0Vec = this.db.prepare(
        'INSERT INTO l0_vec (record_id, embedding, recorded_at) VALUES (?, ?, ?)',
      );
      this.stmtSearchL0Vec = this.db.prepare(`
        SELECT record_id, distance
        FROM l0_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    } else {
      this.stmtDeleteL0Vec = undefined;
      this.stmtInsertL0Vec = undefined;
      this.stmtSearchL0Vec = undefined;
    }
  }

  private dropVectorTables(): void {
    this.db.exec('DROP TABLE IF EXISTS l1_vec');
    this.db.exec('DROP TABLE IF EXISTS l0_vec');
    // 表已重建:作废按块缓存的 IN 语句(旧语句指向已删表,不能依赖引擎自动重编译兜底)
    this.inStmts.clear();
    // provider/model/维度已变:旧的"不可嵌入"判定作废(新 provider 可能嵌入得了),skip 集清空
    this.clearVecSkipIds('l1');
    this.clearVecSkipIds('l0');
    this.prepareL1VecStatements();
    this.prepareL0VecStatements();
  }

  private tableExists(table: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(table) as { name: string } | undefined;
    return row !== undefined;
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  }

  /**
   * 时间增强列:valid_from / valid_to / persistence。
   *
   * 与 family 列同款增量迁移——DDL 契约不改,只在缺列时补,幂等。
   * 存储形态与 created_time/updated_time 一致(ISO-8601 UTC 的 TEXT),
   * 于是区间比较既可按字典序,也能沿用 idx_l1_updated 的既有用法。
   *
   * 存量数据的 metadata.activity_start_time/activity_end_time 是这两列的前身,不回填:
   * 图谱时间锚仍读 metadata,列由新写入路径填充。
   */
  private ensureTemporalColumns(): void {
    for (const column of ['valid_from', 'valid_to', 'persistence'] as const) {
      if (this.hasColumn('l1_records', column)) continue;
      this.db.exec(`ALTER TABLE l1_records ADD COLUMN ${column} TEXT DEFAULT ''`);
      this.logger?.info(`${TAG} l1_records 补 ${column} 列(时间增强)`);
    }
  }

  /**
   * 重建后的 l1_fts 从 l1_records 全量回灌(仅在 drop 重建时调用;iterate 流式防大库内存峰值)。
   *
   * ⚠️ 本函数的参数列表**必须与 `stmtL1FtsInsert` 逐位对齐**。不对齐时 node:sqlite 会在这里抛错,
   * 而下面的 `catch` 是**逐行吞掉**的——症状是 `count` 停在 0、索引静默变空,
   * 全库记录从此全文检索不可见却没有任何错误日志。§E 加列时正是这个位置最容易漏
   * (三处列清单:DDL / insert 语句 / 本函数),故在此留下警示。
   */
  private backfillL1Fts(): void {
    let count = 0;
    const stmt = this.db
      .prepare(
        `SELECT record_id, content, type, priority, scene_name, session_id, version,
                timestamp_str, timestamp_start, timestamp_end, metadata_json, family,
                scope, workspace_id FROM l1_records`,
      );
    for (const r of stmt.iterate() as Iterable<Record<string, unknown>>) {
      try {
        this.stmtL1FtsInsert.run(
          tokenizeForFts(String(r.content ?? '')),
          String(r.content ?? ''),
          String(r.record_id ?? ''),
          String(r.type ?? ''),
          Number(r.priority ?? 50),
          String(r.scene_name ?? ''),
          String(r.session_id ?? 'default'),
          Number(r.version ?? 0),
          String(r.timestamp_str ?? ''),
          String(r.timestamp_start ?? ''),
          String(r.timestamp_end ?? ''),
          String(r.metadata_json ?? '{}'),
          String(r.family ?? 'chat'),
          // §E:回灌必须带上可见范围——漏掉这两列等于**每次 FTS 重建都把隔离抹平**
          // (所有行回落 'global',跨工作区记忆瞬间互相可见),且没有任何报错。
          normScope(r.scope),
          String(r.workspace_id ?? ''),
        );
        count++;
      } catch {
        /* 单行失败跳过(吞+计数:count 与总量比对可发现大面积失败) */
      }
    }
    if (count > 0) this.logger?.info(`${TAG} l1_fts 回灌 ${count} 行`);
  }

  /** 重建后的 l0_fts 从 l0_conversations 全量回灌(仅 drop 重建时调用;iterate 流式)。 */
  private backfillL0Fts(): void {
    let count = 0;
    const stmt = this.db.prepare(
      'SELECT record_id, session_id, role, message_text, recorded_at, timestamp FROM l0_conversations',
    );
    for (const r of stmt.iterate() as Iterable<Record<string, unknown>>) {
      try {
        this.stmtL0FtsInsert.run(
          tokenizeForFts(String(r.message_text ?? '')),
          String(r.message_text ?? ''),
          String(r.record_id ?? ''),
          String(r.session_id ?? 'default'),
          String(r.role ?? ''),
          String(r.recorded_at ?? ''),
          Number(r.timestamp ?? 0),
        );
        count++;
      } catch {
        /* 单行失败跳过 */
      }
    }
    if (count > 0) this.logger?.info(`${TAG} l0_fts 回灌 ${count} 行`);
  }

  private readEmbeddingMeta(): EmbeddingMeta | undefined {
    try {
      const row = this.db
        .prepare('SELECT value FROM embedding_meta WHERE key = ?')
        .get('embedding_provider_info') as { value: string } | undefined;
      if (!row) return undefined;
      const parsed = JSON.parse(row.value) as Partial<EmbeddingMeta>;
      if (typeof parsed.provider !== 'string') return undefined;
      return {
        provider: parsed.provider,
        model: parsed.model ?? '',
        dimensions: parsed.dimensions ?? 0,
      };
    } catch {
      return undefined;
    }
  }

  private writeEmbeddingMeta(info: EmbeddingProviderInfo): void {
    this.db
      .prepare(
        'INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run('embedding_provider_info', JSON.stringify(info));
  }

  /** 通用字符串 kv(embedding_meta 表兼作元数据 kv 存储,如 FTS 分词器版本戳)。 */
  private readMetaString(key: string): string | null {
    try {
      const row = this.db
        .prepare('SELECT value FROM embedding_meta WHERE key = ?')
        .get(key) as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private writeMetaString(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }

  /**
   * 持久化 embedding meta(语义:物理向量表当前对应的 provider/维度)。
   * 活切换在 swapProvider 成功后即写(表已是新维度);启动/补齐链在
   * 缺失向量补齐收敛(missing=0)后写——缺失行补齐判据是行数差,不依赖 meta。
   */
  markEmbeddingSynced(info: EmbeddingProviderInfo): void {
    if (this.degraded) return;
    try {
      this.writeEmbeddingMeta(info);
    } catch (err) {
      this.logger?.warn(`${TAG} embedding meta 写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ============================
  // L1 写入 / 删除 / 读取
  // ============================

  /** upsert 一条 L1(元数据 + FTS 同步;embedding 非零时写向量)。失败返回 false 不抛。 */
  upsertL1(record: MemoryRecord, embedding?: Float32Array): boolean {
    if (this.degraded) return false;
    try {
      this.withTransaction(() => this.upsertL1InTx(record, embedding));
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} L1 upsert 失败(非致命)id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * 批量 upsert L1(单事务;与单条同语义:FTS 失败整批回滚)。
   * 追加/导入热路径用它——逐条开事务在 WAL FULL 下每条一次 fsync。
   * 整批失败时回退逐条写入:好记录照常入库、坏记录只丢自身——否则
   * JSONL 事实源已先行追加,检索库却整批缺失且无自动重导路径(批次空洞)。
   */
  upsertL1Batch(records: MemoryRecord[], embeddings?: Array<Float32Array | undefined>): boolean {
    if (this.degraded || records.length === 0) return false;
    try {
      this.withTransaction(() => {
        for (let i = 0; i < records.length; i++) {
          this.upsertL1InTx(records[i], embeddings?.[i]);
        }
      });
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} L1 批量写入失败,回退逐条写入: ${err instanceof Error ? err.message : String(err)}`,
      );
      const failed: string[] = [];
      for (let i = 0; i < records.length; i++) {
        if (!this.upsertL1(records[i], embeddings?.[i])) failed.push(records[i]?.id ?? `#${i}`);
      }
      if (failed.length > 0) {
        this.logger?.warn(
          `${TAG} 逐条回退后仍失败 ${failed.length}/${records.length} 条: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`,
        );
      }
      return failed.length === 0;
    }
  }

  /** 事务内的单条写入体(upsertL1 / upsertL1Batch 共用;调用方负责事务)。 */
  private upsertL1InTx(record: MemoryRecord, embedding?: Float32Array): void {
    const ts = timestampsToDb(record.timestamps);
    // 绑定层字段兜底(取 schema 列默认):旧版 JSONL 等外部数据缺字段时 undefined
    // 无法绑定(node:sqlite 拒绝绑定),曾致旧版导入逐条全挂、每次启动无限重试。
    // 主表与 FTS 两条语句共用同源归一化值;type 归一化后 familyForType 也不再收到 undefined。
    const type = record.type ?? '';
    const priority = record.priority ?? 50;
    const sceneName = record.scene_name ?? '';
    const family = record.family ?? familyForType(type);
    // §E 写入侧兜底归一,并维持一条**不变量**:`scope='global'` 的记录 `workspace_id` 恒为空串。
    // 不维持它就会出现"标着 global 却带着工作区归属"的行——语义含糊,且日后改判定时
    // 无法区分"全局可见但顺带记了个 id"与"其实属于某工作区"。写入侧算好归属
    // (pipeline 用 `resolveRecordScope`),这里只保证不变量,不重新决策。
    //
    // ⚠️ **形态归一必须在这里做**（不是"顺便"）：检索侧传入的标识经 `workspaceIdOf`
    // 归一（Windows 转小写、resolve 掉 `..`），而写入侧若原样存调用方给的字符串，
    // 同一个工作区会以两种拼写落库 → `isScopeVisible` 的字符串相等判定必然落空
    // → **记忆写进去却再也查不出来**。这一条曾被端到端测试抓出
    // （`tests/scope-tool-wiring.test.ts` 的 `expected 1 to be 2`），
    // 当时的实现只做了"清空"归一而漏了"形态"归一。收在存储层是因为调用方不止一个
    // （pipeline / memory_add / 外部导入），逐个记得归一迟早漏一个。
    const scope = normScope(record.scope);
    const workspaceId = scope === 'workspace' ? (normalizeWorkspacePath(record.workspaceId) ?? '') : '';
    // 防御性 FTS 删除的前置点查(主键索引,微秒级):record_id 在 FTS 表是 UNINDEXED,
    // 按 id DELETE 是 O(N) 全表扫描——导入/重建/重嵌等"全新增"路径曾为每条记录白付一次
    // 全扫(批量写整体 O(N²))。只有主表已有该行(覆盖/合并)才可能有旧 FTS 行需要删。
    // 同批重复 id 也能正确处理:首条插入后,第二条的点查在同一事务内已见新行。
    const ftsExisted = this.ftsAvailable ? this.stmtL1Exists.get(record.id) !== undefined : false;
    // **退场不变量必须在写入漏斗上强制**:已退场的记录(valid_to 闭合或带取代标记)
    // 永不出现在检索面。只靠 `retireL1Batch` 保证是不够的——快照恢复 / 重建 /
    // 旧版导入都会经这里写回记录,若照常重建 FTS/向量行,一条带退场标记的记录
    // 会**悄悄回到检索结果里**(而检索侧刻意不看 valid_to,正是为了零漂移)。
    const retiredNow = record.validTo !== undefined || readSupersedeMarker(record.metadata) !== undefined;
    this.stmtUpsertL1.run(
      record.id,
      record.content,
      type,
      priority,
      sceneName,
      record.sessionId ?? 'default',
      record.version ?? 0,
      ts.str,
      ts.start,
      ts.end,
      toIso(record.createdAt),
      toIso(record.updatedAt),
      JSON.stringify(record.metadata ?? {}),
      family,
      toIso(record.validFrom),
      toIso(record.validTo),
      normPersistence(record.persistence) ?? '',
      scope,
      workspaceId,
    );
    // vec0 不支持 ON CONFLICT → 先删后插;零向量跳过(cosine 未定义)。
    // 已退场则**只删不插**(见上方 retiredNow 的说明)。
    if (this.stmtDeleteL1Vec && this.stmtInsertL1Vec) {
      this.stmtDeleteL1Vec.run(record.id);
      if (!retiredNow && embedding && !isZeroVector(embedding)) {
        this.stmtInsertL1Vec.run(record.id, vecToBuffer(embedding), toIso(record.updatedAt));
      }
    }
    // FTS 删除/插入与元数据同事务:失败必须整体回滚——若只吞 FTS 错误照常 COMMIT,
    // 已执行的 DELETE 会让该 id 的索引行被删未补,记录从此全文检索不可见(静默丢数据)。
    if (this.ftsAvailable) {
      if (ftsExisted || retiredNow) this.stmtL1FtsDelete.run(record.id);
      if (!retiredNow) {
        this.stmtL1FtsInsert.run(
          tokenizeForFts(record.content),
          record.content,
          record.id,
          type,
          priority,
          sceneName,
          record.sessionId ?? 'default',
          record.version ?? 0,
          ts.str,
          ts.start,
          ts.end,
          JSON.stringify(record.metadata ?? {}),
          family,
          scope,
          workspaceId,
        );
      }
    }
  }

  /** 批量删除 L1(元数据 + 向量 + FTS),返回删除条数。IN 按 ≤900 分块(避变量数上限)。
   *  删除成功后触发图谱删除传播(来源全失效的节点/边惰性标 archived;失败不影响删除结果)。 */
  deleteL1Batch(ids: string[]): number {
    if (this.degraded || ids.length === 0) return 0;
    try {
      this.withTransaction(() => {
        for (const chunk of chunkIds(ids)) this.inStatement('l1_records', 'delete', chunk.length).run(...chunk);
        if (this.stmtDeleteL1Vec) {
          for (const chunk of chunkIds(ids)) this.inStatement('l1_vec', 'delete', chunk.length).run(...chunk);
        }
        if (this.ftsAvailable) {
          for (const chunk of chunkIds(ids)) this.inStatement('l1_fts', 'delete', chunk.length).run(...chunk);
        }
      });
      this.graphStore.markSourcesDeleted(ids);
      return ids.length;
    } catch (err) {
      this.logger?.warn(`${TAG} L1 批量删除失败: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /**
   * **软删**(记忆退场):保留主表行,撤出检索面。
   *
   * 与 `deleteL1Batch` 的差别**只有一处**:不动 `l1_records` 行本身。
   * `valid_to` 闭合 + `metadata_json` 写取代标记 → 记录仍能被 `listL1` 列出、
   * 能被 `clearRetireMarker` + upsert 恢复;而 FTS 与向量行照旧删除,于是检索面
   * (含去重候选召回)自然看不到它 —— **检索 SQL 一行都不用改**,活动记录零漂移
   * 因此是构造性的,不是比对出来的。
   *
   * 顺序刻意如此:先打标记(可逆的那一半),再撤检索面,且整体在一个事务里。
   * 反过来先撤索引而打标记失败,记录会落在"检索不到、也没被标记"的状态 ——
   * 既查不出来也恢复不了,是最坏的一种中间态。
   *
   * **幂等**:已退场(`valid_to` 非空或已有标记)的 id 不再重复写标记,
   * 保留首次退场的原因与时刻(「谁先取代了它」不该被后一次调用改写)。
   *
   * **不调** `graphStore.markSourcesDeleted`:那是"来源已物理消失"的传播,
   * 而软删的记录仍活在主表里 —— 图谱侧的退役语义另计(见计划 findings R-a)。
   */
  retireL1Batch(ids: string[], info: SupersedeInfo): number {
    if (this.degraded || ids.length === 0) return 0;
    try {
      const existing = new Map(this.getL1ByIds(ids).map((r) => [r.id, r]));
      const update = this.db.prepare('UPDATE l1_records SET valid_to = ?, metadata_json = ? WHERE record_id = ?');
      const retired: string[] = [];
      this.withTransaction(() => {
        for (const id of ids) {
          const rec = existing.get(id);
          // 不存在的 id 静默跳过;已退场的跳过以保幂等
          if (!rec || isRetired(rec)) continue;
          update.run(info.at, JSON.stringify(withSupersedeMarker(rec.metadata, info)), id);
          retired.push(id);
        }
        if (retired.length > 0) this.detachL1FromRetrieval(retired);
      });
      return retired.length;
    } catch (err) {
      this.logger?.warn(`${TAG} L1 软删(退场)失败: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /**
   * 撤出检索面(删 FTS + 向量行,**主表保留**)。
   * 与 `deleteL1Batch` 的删除面同源,只是不动 `l1_records`。
   */
  private detachL1FromRetrieval(ids: string[]): void {
    if (this.stmtDeleteL1Vec) {
      for (const chunk of chunkIds(ids)) this.inStatement('l1_vec', 'delete', chunk.length).run(...chunk);
    }
    if (this.ftsAvailable) {
      for (const chunk of chunkIds(ids)) this.inStatement('l1_fts', 'delete', chunk.length).run(...chunk);
    }
  }

  /**
   * 清掉退场标记(恢复的**前半**)。返回清完标记的记录,供调用方 re-upsert 以重建
   * FTS/向量 —— 那条路径(`upsertL1InTx`)已存在,不在这里重复实现。
   *
   * 只清 `valid_to` 与标记键,**不碰内容**:恢复不该修改记忆本身。
   * 返回的 `validTo` 显式置 `undefined`(而非留着旧 epoch),否则 upsert 会
   * 用 `toIso(旧值)` 把 `valid_to` 又写回去,恢复静默失败。
   */
  clearRetireMarker(ids: string[]): MemoryRecord[] {
    if (this.degraded || ids.length === 0) return [];
    try {
      const existing = this.getL1ByIds(ids);
      const update = this.db.prepare('UPDATE l1_records SET valid_to = ?, metadata_json = ? WHERE record_id = ?');
      const restored: MemoryRecord[] = [];
      this.withTransaction(() => {
        for (const rec of existing) {
          const metadata = stripSupersedeMarker(rec.metadata);
          if (isRetired(rec)) update.run('', JSON.stringify(metadata), rec.id);
          restored.push({ ...rec, metadata, validTo: undefined });
        }
      });
      return restored;
    } catch (err) {
      this.logger?.warn(`${TAG} L1 恢复(清退场标记)失败: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** 已退场记录列表(面板用):`valid_to` 非空即已退场。失败返回空。 */
  listRetiredL1(opts: { limit: number; offset: number }): { items: MemoryRecord[]; total: number } {
    if (this.degraded) return { items: [], total: 0 };
    try {
      const totalRow = this.db
        .prepare("SELECT COUNT(*) AS n FROM l1_records WHERE COALESCE(valid_to, '') <> ''")
        .get() as { n: number | bigint };
      const rows = this.db
        .prepare(
          `SELECT record_id, content, type, priority, scene_name, version, timestamp_str, created_time, updated_time, metadata_json, family, valid_from, valid_to, persistence, scope, workspace_id
           FROM l1_records WHERE COALESCE(valid_to, '') <> '' ORDER BY updated_time DESC LIMIT ? OFFSET ?`,
        )
        .all(opts.limit, opts.offset) as unknown as L1MetaRow[];
      return { items: rows.map(rowToRecord), total: Number(totalRow?.n ?? 0) };
    } catch (err) {
      this.logger?.warn(`${TAG} 已退场列表查询失败(返回空): ${err instanceof Error ? err.message : String(err)}`);
      return { items: [], total: 0 };
    }
  }

  private inStatement(table: 'l1_records' | 'l1_vec' | 'l1_fts', action: 'delete' | 'select', size: number): StatementLike {
    const key = `${table}:${action}:${size}`;
    let stmt = this.inStmts.get(key);
    if (!stmt) {
      const ph = Array.from({ length: size }, () => '?').join(',');
      // 时间增强列只存在于主表;l1_fts / l1_vec 没有这三列,共用列清单会直接报 no such column。
      // 主表自身也按实际形状探测:未迁移的旧库不应因缺列而让按 id 取记录整条路径失败。
      const temporal =
        table === 'l1_records' && this.hasColumn('l1_records', 'valid_from')
          ? ', valid_from, valid_to, persistence'
          : '';
      // §E:同款按形状探测——未迁移的旧库(补列前)不应因缺列让"按 id 取记录"整条路径失败。
      const scopeCols =
        table === 'l1_records' && this.hasColumn('l1_records', 'scope') ? ', scope, workspace_id' : '';
      const metaCols =
        'record_id, content, type, priority, scene_name, version, timestamp_str, created_time, updated_time, metadata_json, family' +
        temporal +
        scopeCols;
      stmt =
        action === 'delete'
          ? this.db.prepare(`DELETE FROM ${table} WHERE record_id IN (${ph})`)
          : this.db.prepare(`SELECT ${metaCols} FROM ${table} WHERE record_id IN (${ph})`);
      this.inStmts.set(key, stmt);
    }
    return stmt;
  }

  /**
   * 清空 L1 检索库全部数据(重建用)。records/FTS 直接 DELETE;
   * 向量表走 DROP + 重建(vec0 的全表 DELETE 语义不可靠,dropVectorTables
   * 会连 l0_vec 一起删——L0 向量必须保留——故此处单独处理 l1_vec)。
   * L0 表与 embedding_meta 不动:backfill 的行数比对天然重新一致。
   * 图谱表族一并清空——图谱是 L1 的可重建投影,记录清空即投影作废(B2)。
   */
  clearL1(): boolean {
    if (this.degraded) return false;
    try {
      this.withTransaction(() => {
        this.db.exec('DELETE FROM l1_records');
        if (this.ftsAvailable) this.db.exec('DELETE FROM l1_fts');
      });
      this.graphStore.resetAll();
      // vec0 全表 DELETE 语义不可靠 → DROP + 重建空表;放事务外(vtab DDL 事务性弱)。
      // 中间态:向量行短暂孤儿——检索侧对缺 meta 的向量本就跳过(searchL1Vector 回查过滤)。
      if (this.stmtDeleteL1Vec) {
        this.db.exec('DROP TABLE IF EXISTS l1_vec');
        this.prepareL1VecStatements();
        this.inStmts.clear();
      }
      // 重建后 L1 id 全新,旧 skip 集是死数据,清空让新记录获得一次嵌入机会
      this.clearVecSkipIds('l1');
      this.logger?.info(`${TAG} L1 检索库已清空(重建)`);
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} L1 清空失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  countL1(): number {
    if (this.degraded) return 0;
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM l1_records').get() as { n: number };
      return row?.n ?? 0;
    } catch {
      // 建表前(init 的 embedding 变更检测)会先调用计数
      return 0;
    }
  }

  /** 全量读取(调试/迁移/重嵌入用;检索请走 FTS/向量)。 */
  getAllL1(): MemoryRecord[] {
    if (this.degraded) return [];
    const rows = this.db
      .prepare(
        'SELECT record_id, content, type, priority, scene_name, version, timestamp_str, created_time, updated_time, metadata_json, family, valid_from, valid_to, persistence, scope, workspace_id FROM l1_records',
      )
      .all() as unknown as L1MetaRow[];
    return rows.map(rowToRecord);
  }

  getL1ByIds(ids: string[]): MemoryRecord[] {
    if (this.degraded || ids.length === 0) return [];
    const rows: L1MetaRow[] = [];
    for (const chunk of chunkIds(ids)) {
      rows.push(...(this.inStatement('l1_records', 'select', chunk.length).all(...chunk) as unknown as L1MetaRow[]));
    }
    return rows.map(rowToRecord);
  }

  /**
   * §B 决策凭证批量落盘。`INSERT OR IGNORE` + 确定性 `receipt_id`
   * (见 `receipts.ts` 的 `receiptIdFor`)→ 同一次 run 重放不产生重复行。
   * 返回实际新增条数(被忽略的重复不计)。
   *
   * 刻意**不开事务**:凭证是旁路观测数据,单条独立、重放幂等,部分写入无害;
   * 为它引入事务只会把失败面扩大。调用方另有 `persistReceiptsSafely` 兜底不抛。
   *
   * 写入后**顺带执行保留策略**(task_18)。把裁剪挂在这里而不是交给调用方,
   * 是为了让"有界"成为**结构性保证**:任何写路径都不可能忘记裁剪,
   * 因而表容量不可能随使用时间无界增长。裁剪自身失败只 warn——
   * 它是省空间的动作,失败了最坏是这次没省下来,绝不能因此弄丢刚落盘的凭证
   * (故裁剪在写入**之后**,且包在 try 里)。
   */
  recordReceipts(rows: readonly L1Receipt[], opts?: ReceiptRetentionOptions): number {
    if (this.degraded || rows.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO l1_receipts (receipt_id, run_id, record_id, kind, input_digest, decided_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    for (const r of rows) {
      n += Number(stmt.run(r.receiptId, r.runId, r.recordId, r.kind, r.inputDigest, r.decidedAt).changes);
    }
    try {
      this.trimReceipts(opts?.maxRuns ?? RECEIPTS_MAX_RUNS);
    } catch (err) {
      this.logger?.warn(
        `${TAG} L1 决策凭证裁剪失败,本次不回收空间(**凭证已正常落盘,记忆与回溯不受影响**): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return n;
  }

  /**
   * §C 矛盾冻结(task_22):落盘待裁决冲突对。
   *
   * `INSERT OR IGNORE`——幂等来自 **pair_id 主键**而非调用方自觉:
   * `conflictPairId(runId, winner, loser)` 对同一三元组恒等,故一轮蒸馏重复落盘
   * 只会得到一行。与 §B 凭证同一手法(那边是 `receipt_id` 主键)。
   *
   * 与凭证不同,这里**不做保留裁剪**:待裁决对是**欠人的债**,不是观测数据。
   * 裁剪它等于把用户还没看的裁决请求悄悄删掉,那是丢工作而不是省空间。
   * 有界性交给 task_24 的队列上限(超限不再停放、回落自动裁决),语义是
   * 「**不收新的**」而非「**偷偷删旧的**」。
   *
   * @returns 实际新插入的行数。
   */
  recordConflictPending(rows: readonly ConflictPair[]): number {
    if (this.degraded || rows.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO conflict_pending
         (pair_id, run_id, winner_id, loser_id, created_at, resolved_at, resolution)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    for (const r of rows) {
      n += Number(
        stmt.run(r.pairId, r.runId, r.winnerId, r.loserId, r.createdAt, r.resolvedAt, r.resolution).changes,
      );
    }
    return n;
  }

  /** §C 冻结:把图谱 `disputed` 状态同步到给定冲突集(薄缝,便于单测替换)。 */
  syncGraphDisputed(disputedRecordIds: readonly string[]): { marked: number; cleared: number } {
    if (this.degraded) return { marked: 0, cleared: 0 };
    return this.graphStore.syncDisputed(disputedRecordIds);
  }

  /**
   * §C 冻结队列的**未裁决**条数(task_24 队列上限判据)。
   * 走 `idx_conflict_pending_unresolved` 偏索引,不是全表扫描。
   */
  countConflictPendingUnresolved(): number {
    if (this.degraded) return 0;
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM conflict_pending WHERE resolved_at = ''`).get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * §C 取未裁决冲突对(task_24 超时扫描 / task_25 裁决工具)。
   *
   * `createdBefore` 为**排他上界**(ISO 串):只取该时刻之前创建的,用于超时判定。
   * 定序 `created_at ASC, pair_id ASC`——先来先服务,且同一毫秒内仍**确定可复现**。
   */
  listConflictPending(opts: { createdBefore?: string; limit?: number } = {}): ConflictPair[] {
    if (this.degraded) return [];
    const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) > 0 ? Math.floor(opts.limit as number) : 500;
    const params: unknown[] = [];
    let where = `resolved_at = ''`;
    if (opts.createdBefore) {
      where += ` AND created_at < ?`;
      params.push(opts.createdBefore);
    }
    const rows = this.db
      .prepare(
        `SELECT pair_id, run_id, winner_id, loser_id, created_at, resolved_at, resolution
           FROM conflict_pending WHERE ${where}
          ORDER BY created_at ASC, pair_id ASC LIMIT ?`,
      )
      .all(...(params as never[]), limit) as Array<Record<string, unknown>>;
    return rows.map(toConflictPair);
  }

  /**
   * §C 打上裁决结论。
   *
   * `WHERE resolved_at = ''` 使**已裁决的不会被覆盖**:裁决是一次性的判定行为,
   * 重复调用不该把第一次的结论改写掉(人工裁决与自动了结的次序因此不可逆)。
   *
   * @returns 受影响行数(0 = 该对被裁决过或不存在)。
   */
  resolveConflictPending(pairId: string, resolution: ConflictResolution, resolvedAt: string): number {
    if (this.degraded) return 0;
    const stmt = this.db.prepare(
      `UPDATE conflict_pending SET resolved_at = ?, resolution = ?
        WHERE pair_id = ? AND resolved_at = ''`,
    );
    return Number(stmt.run(resolvedAt, resolution, pairId).changes);
  }

  /**
   * §B 凭证保留策略(task_18):只保留**最新**的 `maxRuns` 个 run,更老的整批删除。
   * 返回被删除的行数。
   *
   * 两条刻意的约束:
   * - **粒度是 run,不是行**。按行裁剪会切出"半截批次",而 task_19 的按 run 回溯
   *   正是要回答"这一轮蒸馏都判了什么"——一个少了尾巴的批次会给出**看似完整、
   *   实则遗漏**的结论,比查不到更糟。整批留、整批删,回溯的原子性才有保证。
   * - **只碰 `l1_receipts`,绝不碰 `l1_records`**。前者是可再生/可丢弃的观测数据,
   *   后者是用户的事实源。为省几 MB 而波及记忆本体,是把容量优化做成了数据丢失。
   *
   * `maxRuns <= 0` 或非有限值一律**不裁剪**——"传 0 即清空"是个太容易被误触的
   * 语义,宁可把它定义为无效输入。
   *
   * 定序取每 run 的 `MAX(decided_at)`(凭证的 decided_at 在一批内恒定)并以
   * `run_id` 兜底,使同一时刻产生的多个 run 也有**确定**的相对序,裁剪结果可复现。
   */
  trimReceipts(maxRuns: number): number {
    if (this.degraded) return 0;
    if (!Number.isFinite(maxRuns) || maxRuns <= 0) return 0;
    const stmt = this.db.prepare(
      `DELETE FROM l1_receipts WHERE run_id NOT IN (
         SELECT run_id FROM l1_receipts
          GROUP BY run_id
          ORDER BY MAX(decided_at) DESC, run_id DESC
          LIMIT ?
       )`,
    );
    return Number(stmt.run(Math.floor(maxRuns)).changes);
  }

  /**
   * §B 双维回溯(task_19):按 `record_id` / `run_id` 查判定史,两维同给为 **AND**。
   *
   * 两条刻意的行为:
   * - **两维都不给返回空,而不是全表**。「查全部凭证」不是本能力的目标;把缺参
   *   兜成全表,会让一次误调用变成全库判定史导出。调用方本就该先拒绝这种用法
   *   (工具层给提示、端点层直接报错),这里是第二道,方向一致。
   * - **定序确定**:`decided_at DESC, run_id DESC`。回溯的价值在于可复现——
   *   同一问题两次问出不同顺序,核对时就会怀疑是不是数据变了。`run_id` 兜底
   *   同一毫秒内的多批(L1 蒸馏是 LLM 调用,同刻两批罕见但非不可能)。
   *   新的在前,与 `listL1` 的倒序口径一致。
   */
  listReceipts(opts: ReceiptQuery & { limit: number }): L1Receipt[] {
    if (this.degraded) return [];
    const where = receiptWhere(opts);
    if (where === null) return [];
    const limit = Math.min(Math.max(Math.floor(opts.limit) || 1, 1), RECEIPTS_QUERY_LIMIT_MAX);
    const rows = this.db
      .prepare(
        `SELECT receipt_id, run_id, record_id, kind, input_digest, decided_at
           FROM l1_receipts WHERE ${where.sql}
          ORDER BY decided_at DESC, run_id DESC
          LIMIT ?`,
      )
      .all(...where.params, limit) as Array<{
      receipt_id: string;
      run_id: string;
      record_id: string;
      kind: string;
      input_digest: string;
      decided_at: string;
    }>;
    return rows.map((r) => ({
      receiptId: r.receipt_id,
      runId: r.run_id,
      recordId: r.record_id,
      kind: r.kind as L1Receipt['kind'],
      inputDigest: r.input_digest,
      decidedAt: r.decided_at,
    }));
  }

  /** 同维度命中的**总条数**(不受 limit 影响,供"还有多少条没显示"提示)。 */
  countReceipts(opts: ReceiptQuery): number {
    if (this.degraded) return 0;
    const where = receiptWhere(opts);
    if (where === null) return 0;
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM l1_receipts WHERE ${where.sql}`)
      .get(...where.params) as { n: number | bigint };
    return Number(row.n);
  }

  /** 浏览列表(UI 用):按更新时间倒序,支持类型/场景/族/Hall/可见范围过滤与分页。失败返回空。 */
  listL1(opts: { type?: string; scene?: string; family?: string; hall?: string; halls?: readonly string[]; workspaceId?: string; limit: number; offset: number }): { items: MemoryRecord[]; total: number } {
    if (this.degraded) return { items: [], total: 0 };
    try {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (opts.type) {
        where.push('type = ?');
        params.push(opts.type);
      }
      if (opts.scene) {
        where.push('scene_name = ?');
        params.push(opts.scene);
      }
      if (opts.family) {
        where.push('family = ?');
        params.push(opts.family);
      }
      // §E 可见范围(缺省不过滤):global 记录 + 本工作区记录。与检索路径同一条判据。
      if (opts.workspaceId) {
        where.push("(scope = 'global' OR workspace_id = ?)");
        params.push(opts.workspaceId);
      }
      if (opts.hall || (opts.halls && opts.halls.length > 0)) {
        // Hall 存于 metadata_json,用 json_extract 过滤(表小,逐行代价可接受);
        // R13 多值:IN (?,?,…),命中任一即可
        const values = opts.halls && opts.halls.length > 0 ? opts.halls : [opts.hall!];
        where.push(`json_extract(metadata_json, '$.hall') IN (${values.map(() => '?').join(',')})`);
        params.push(...values);
      }
      const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
      const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM l1_records${whereSql}`).get(...params) as { n: number };
      const rows = this.db
        .prepare(
          `SELECT record_id, content, type, priority, scene_name, version, timestamp_str, created_time, updated_time, metadata_json, family, valid_from, valid_to, persistence, scope, workspace_id FROM l1_records${whereSql} ORDER BY updated_time DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, opts.limit, opts.offset) as unknown as L1MetaRow[];
      return { items: rows.map(rowToRecord), total: totalRow?.n ?? 0 };
    } catch (err) {
      this.logger?.warn(`${TAG} L1 浏览列表查询失败(返回空): ${err instanceof Error ? err.message : String(err)}`);
      return { items: [], total: 0 };
    }
  }

  /** 场景名去重列表(UI 筛选器数据源)。失败返回空。 */
  distinctL1Scenes(): string[] {
    if (this.degraded) return [];
    try {
      const rows = this.db
        .prepare('SELECT DISTINCT scene_name FROM l1_records ORDER BY scene_name')
        .all() as Array<{ scene_name: string }>;
      return rows.map((r) => r.scene_name).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Hall 域计数(八边形角数据源):按 metadata.hall 分组计数 + 未打标行数。失败返回空。 */
  hallL1Counts(): { counts: Record<string, number>; unlabeled: number } {
    if (this.degraded) return { counts: {}, unlabeled: 0 };
    try {
      const rows = this.db
        .prepare(
          "SELECT json_extract(metadata_json, '$.hall') AS hall, COUNT(*) AS n FROM l1_records GROUP BY hall",
        )
        .all() as Array<{ hall: string | null; n: number | bigint }>;
      const counts: Record<string, number> = {};
      let unlabeled = 0;
      for (const r of rows) {
        const n = Number(r.n);
        if (typeof r.hall === 'string' && r.hall !== '') counts[r.hall] = n;
        else unlabeled += n;
      }
      return { counts, unlabeled };
    } catch {
      return { counts: {}, unlabeled: 0 };
    }
  }

  // ============================
  // L1 检索
  // ============================

  /** FTS5 BM25 检索(family / workspaceId 缺省不过滤)。失败返回空数组(调用方降级)。 */
  searchL1Fts(query: string, limit: number, family?: string, workspaceId?: string): L1SearchHit[] {
    if (this.degraded || !this.ftsAvailable || limit <= 0) return [];
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    // 哨兵:'' = 不做可见范围过滤(与 SQL 里的 `? = ''` 分支对应)
    const ws = workspaceId ?? '';
    try {
      const rows = (
        family
          ? this.stmtL1FtsSearchFamily.all(ftsQuery, family, ws, ws, limit)
          : this.stmtL1FtsSearch.all(ftsQuery, ws, ws, limit)
      ) as Array<{
        record_id: string;
        content: string;
        type: string;
        priority: number;
        scene_name: string;
        family: string;
        rank: number;
      }>;
      return rows.map((r) => ({
        id: r.record_id,
        content: r.content,
        type: r.type,
        priority: r.priority,
        scene_name: r.scene_name,
        family: normFamily(r.family, r.type),
        score: bm25RankToScore(r.rank),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} L1 FTS 检索失败(返回空): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * vec0 余弦 KNN 检索(score = 1 - cosine distance)。失败返回空数组。
   * family / workspaceId 过滤走**过度召回 + 回查过滤**(vec0 无法 WHERE)。
   * 放大倍数对两条轴**相乘**:两轴各自丢弃行,单独放大任一条都不够。
   */
  searchL1Vector(embedding: Float32Array, topK: number, family?: string, workspaceId?: string): L1SearchHit[] {
    if (this.degraded || !this.stmtSearchL1Vec || topK <= 0) return [];
    try {
      // 过度召回补偿遗留零向量;带过滤时再放大(不命中过滤条件的行会被丢弃)
      const retrieveCount = (topK + ZERO_VEC_BUFFER) * (family ? 3 : 1) * (workspaceId ? 3 : 1);
      const rows = this.stmtSearchL1Vec.all(vecToBuffer(embedding), retrieveCount) as Array<{
        record_id: string;
        distance: number | null;
      }>;
      const hits: L1SearchHit[] = [];
      for (const { record_id, distance } of rows) {
        if (distance == null || Number.isNaN(distance)) continue;
        const meta = this.stmtGetL1.get(record_id) as L1MetaRow | undefined;
        if (!meta) continue;
        if (family && normFamily(meta.family, meta.type) !== family) continue;
        if (workspaceId && !isScopeVisible(meta.scope, meta.workspace_id, workspaceId)) continue;
        hits.push({
          id: record_id,
          content: meta.content,
          type: meta.type,
          priority: meta.priority,
          scene_name: meta.scene_name,
          family: normFamily(meta.family, meta.type),
          score: 1.0 - distance,
        });
      }
      return hits.slice(0, topK);
    } catch (err) {
      this.logger?.warn(`${TAG} L1 向量检索失败(返回空): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ============================
  // L0 写入 / 删除 / 读取
  // ============================

  /** 批量 upsert L0 消息(元数据 + FTS;embeddings 与 records 等长,可省略)。 */
  upsertL0Batch(records: L0MessageRecord[], embeddings?: Array<Float32Array | undefined>): boolean {
    if (this.degraded || records.length === 0) return false;
    try {
      this.withTransaction(() => {
        for (let i = 0; i < records.length; i++) {
          const rec = records[i];
          // 绑定层字段兜底(取 schema 列默认):同 upsertL1InTx——外部数据缺字段时
          // undefined 无法绑定;主表/向量/FTS 共用同源归一化值
          const sessionId = rec.sessionId ?? 'default';
          const role = rec.role ?? '';
          const content = rec.content ?? '';
          const recordedAt = rec.recordedAt ?? '';
          const timestamp = rec.timestamp ?? 0;
          // R7:锚点两列。缺省给 **null**(不是 0)——0 是一个真实的轮次号,
          // 用它冒充"没有坐标"会让读侧以为存在第 0 轮。
          const turn = typeof rec.turn === 'number' && Number.isFinite(rec.turn) ? rec.turn : null;
          const step = typeof rec.step === 'number' && Number.isFinite(rec.step) ? rec.step : null;
          // 同 upsertL1 的点查预判:全新增路径跳过 UNINDEXED 列的 FTS 全扫删除
          const ftsExisted = this.ftsAvailable ? this.stmtL0Exists.get(rec.id) !== undefined : false;
          this.stmtUpsertL0.run(rec.id, sessionId, role, content, recordedAt, timestamp, turn, step);
          if (this.stmtDeleteL0Vec && this.stmtInsertL0Vec) {
            this.stmtDeleteL0Vec.run(rec.id);
            const vec = embeddings?.[i];
            if (vec && !isZeroVector(vec)) {
              this.stmtInsertL0Vec.run(rec.id, vecToBuffer(vec), recordedAt);
            }
          }
          if (this.ftsAvailable) {
            // 同 upsertL1:FTS 失败冒泡触发整批回滚,禁止"删了没补"的索引空洞。
            if (ftsExisted) this.stmtL0FtsDelete.run(rec.id);
            this.stmtL0FtsInsert.run(tokenizeForFts(content), content, rec.id, sessionId, role, recordedAt, timestamp);
          }
        }
      });
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} L0 批量写入失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** 记录一次蒸馏调用成本(委托 cost-ledger;语义见 CostLedger.insertCostCall)。 */
  insertCostCall(
    provider: string,
    model: string,
    layer: string,
    inputChars: number,
    outputTokens: number,
    reasoningTokens: number,
    retentionDays: number,
  ): void {
    this.costLedger.insertCostCall(provider, model, layer, inputChars, outputTokens, reasoningTokens, retentionDays);
  }

  /** 查询 token_cost 单窗口聚合(委托 cost-ledger;降级/异常返回零值)。 */
  aggregateCost(since: number): { total: CostAggregate; byModel: CostByModel[] } {
    return this.costLedger.aggregateCost(since);
  }

  /** 按层级归并聚合(委托 cost-ledger;降级/异常返回空数组)。 */
  aggregateCostByLayer(since: number): CostByLayer[] {
    return this.costLedger.aggregateCostByLayer(since);
  }

  /** 按时间桶 + model 聚合(委托 cost-ledger;趋势图与日均/周均/月均共用)。 */
  aggregateByBucket(bucketMs: number, offsetMs: number, since: number, layer: string): BucketRow[] {
    return this.costLedger.aggregateByBucket(bucketMs, offsetMs, since, layer);
  }

  countL0(): number {
    if (this.degraded) return 0;
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM l0_conversations').get() as { n: number };
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** 统计 recorded_at >= iso 的消息数(状态面板"今日捕获"用)。 */
  countL0Since(iso: string): number {
    if (this.degraded) return 0;
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM l0_conversations WHERE recorded_at >= ?')
        .get(iso) as { n: number };
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** 统计某会话已捕获消息数(session-stats 数据源;idx_l0_session_id 索引点查)。 */
  countL0BySession(sessionId: string): number {
    if (this.degraded) return 0;
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM l0_conversations WHERE session_id = ?')
        .get(sessionId) as { n: number };
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** 按会话取最近消息(时间升序返回;走 idx_l0_session_id 索引)。
   *  蒸馏背景参考专用——按会话现查替代全局内存数组(ADR-0003)。 */
  recentL0BySession(sessionId: string, limit: number): L0MessageRecord[] {
    if (this.degraded || limit <= 0) return [];
    try {
      const rows = this.db
        .prepare(
          'SELECT record_id, session_id, role, message_text, recorded_at, timestamp, turn, step FROM l0_conversations WHERE session_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?',
        )
        .all(sessionId, limit) as Array<{
        record_id: string;
        session_id: string;
        role: string;
        message_text: string;
        recorded_at: string;
        timestamp: number;
        turn: number | null;
        step: number | null;
      }>;
      return rows.map((r) => this.toL0Record(r)).reverse();
    } catch (err) {
      this.logger?.warn(`[memory] L0 按会话取最近消息失败(返回空): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 锚点定向取消息(R7):按 `(session_id, turn[, step])` 取该回合的 L0 消息。
   *
   * 与 `recentL0BySession` 的区别是**按坐标而非按时间**:证据读取器(R2)手上
   * 只有锚点,没有"最近"的概念。`step` 缺省即整轮(不过滤 step)。
   *
   * 返回按 `timestamp, rowid` 升序——同一轮内的原始顺序,供下游拼回回合文本。
   */
  l0ByAnchor(sessionId: string, turn: number, step?: number): L0MessageRecord[] {
    if (this.degraded || !Number.isFinite(turn)) return [];
    try {
      const sql =
        step === undefined
          ? 'SELECT record_id, session_id, role, message_text, recorded_at, timestamp, turn, step FROM l0_conversations WHERE session_id = ? AND turn = ? ORDER BY timestamp ASC, rowid ASC'
          : 'SELECT record_id, session_id, role, message_text, recorded_at, timestamp, turn, step FROM l0_conversations WHERE session_id = ? AND turn = ? AND step = ? ORDER BY timestamp ASC, rowid ASC';
      const stmt = this.db.prepare(sql);
      const rows = (step === undefined ? stmt.all(sessionId, turn) : stmt.all(sessionId, turn, step)) as Array<{
        record_id: string;
        session_id: string;
        role: string;
        message_text: string;
        recorded_at: string;
        timestamp: number;
        turn: number | null;
        step: number | null;
      }>;
      return rows.map((r) => this.toL0Record(r));
    } catch (err) {
      this.logger?.warn(`${TAG} L0 按锚点取消息失败(返回空): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * L0 行 → 记录的统一映射。turn/step 为 NULL(旧行 / 无坐标)时**不写键**,
   * 使"无锚点"与"锚点为空"在类型层就是两件事。
   */
  private toL0Record(r: {
    record_id: string;
    session_id: string;
    role: string;
    message_text: string;
    recorded_at: string;
    timestamp: number;
    turn: number | null;
    step: number | null;
  }): L0MessageRecord {
    const rec: L0MessageRecord = {
      sessionId: r.session_id,
      recordedAt: r.recorded_at,
      id: r.record_id,
      role: r.role as L0MessageRecord['role'],
      content: r.message_text,
      timestamp: r.timestamp ?? 0,
    };
    if (typeof r.turn === 'number') rec.turn = r.turn;
    if (typeof r.step === 'number') rec.step = r.step;
    return rec;
  }

  /** L0 全量列举(重建快照用;按时间升序,事务一致性避开 JSONL 追加竞态)。 */
  listL0All(): L0MessageRecord[] {
    if (this.degraded) return [];
    try {
      const rows = this.db
        .prepare('SELECT record_id, session_id, role, message_text, recorded_at, timestamp, turn, step FROM l0_conversations ORDER BY timestamp ASC')
        .all() as Array<{
        record_id: string;
        session_id: string;
        role: string;
        message_text: string;
        recorded_at: string;
        timestamp: number;
        turn: number | null;
        step: number | null;
      }>;
      return rows.map((r) => this.toL0Record(r));
    } catch (err) {
      this.logger?.warn(`${TAG} L0 全量列举失败(返回空): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** 重建成本预估(一次全表聚合:会话数 / 消息数 / 字符量)。 */
  l0RebuildEstimate(): { sessions: number; messages: number; chars: number } {
    if (this.degraded) return { sessions: 0, messages: 0, chars: 0 };
    try {
      const row = this.db
        .prepare(
          'SELECT COUNT(DISTINCT session_id) AS s, COUNT(*) AS n, COALESCE(SUM(LENGTH(message_text)), 0) AS c FROM l0_conversations',
        )
        .get() as { s: number; n: number; c: number };
      return { sessions: row?.s ?? 0, messages: row?.n ?? 0, chars: row?.c ?? 0 };
    } catch {
      return { sessions: 0, messages: 0, chars: 0 };
    }
  }

  /** 向量表行数(backfill 判据:与元数据行数的差值即缺失向量数;不可用时返回 -1)。 */
  countL1Vec(): number {
    if (this.degraded || !this.stmtSearchL1Vec) return -1;
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM l1_vec').get() as { n: number };
      return row?.n ?? -1;
    } catch {
      return -1;
    }
  }

  countL0Vec(): number {
    if (this.degraded || !this.stmtSearchL0Vec) return -1;
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM l0_vec').get() as { n: number };
      return row?.n ?? -1;
    } catch {
      return -1;
    }
  }

  // ============================
  // L0 检索
  // ============================

  searchL0Fts(query: string, limit: number): L0SearchHit[] {
    if (this.degraded || !this.ftsAvailable || limit <= 0) return [];
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    try {
      const rows = this.stmtL0FtsSearch.all(ftsQuery, limit) as Array<{
        record_id: string;
        message_text: string;
        session_id: string;
        role: string;
        recorded_at: string;
        timestamp: number;
        rank: number;
      }>;
      return rows.map((r) => ({
        sessionId: r.session_id,
        recordedAt: r.recorded_at,
        id: r.record_id,
        role: r.role as L0MessageRecord['role'],
        content: r.message_text,
        timestamp: r.timestamp ?? 0,
        score: bm25RankToScore(r.rank),
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} L0 FTS 检索失败(返回空): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  searchL0Vector(embedding: Float32Array, topK: number): L0SearchHit[] {
    if (this.degraded || !this.stmtSearchL0Vec) return [];
    try {
      const retrieveCount = topK + ZERO_VEC_BUFFER;
      const rows = this.stmtSearchL0Vec.all(vecToBuffer(embedding), retrieveCount) as Array<{
        record_id: string;
        distance: number | null;
      }>;
      const hits: L0SearchHit[] = [];
      for (const { record_id, distance } of rows) {
        if (distance == null || Number.isNaN(distance)) continue;
        const row = this.stmtGetL0.get(record_id) as
          | {
              session_id: string;
              role: string;
              message_text: string;
              recorded_at: string;
              timestamp: number;
              turn: number | null;
              step: number | null;
            }
          | undefined;
        if (!row) continue;
        const hit: L0SearchHit = {
          sessionId: row.session_id,
          recordedAt: row.recorded_at,
          id: record_id,
          role: row.role as L0MessageRecord['role'],
          content: row.message_text,
          timestamp: row.timestamp ?? 0,
          score: 1.0 - distance,
        };
        // R7:坐标随命中一起带出(向量路命中同样需要可回溯)
        if (typeof row.turn === 'number') hit.turn = row.turn;
        if (typeof row.step === 'number') hit.step = row.step;
        hits.push(hit);
      }
      return hits.slice(0, topK);
    } catch (err) {
      this.logger?.warn(`${TAG} L0 向量检索失败(返回空): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ============================
  // 重嵌入(reindexAll 用)
  // ============================

  /** L1 缺失向量的记录数(排除 skip 集后的补齐判据;向量能力不可用返回 -1)。 */
  countL1VecMissing(exclude?: Set<string>): number {
    return this.countVecMissing('l1', exclude);
  }

  /** L0 缺失向量的记录数(同上)。 */
  countL0VecMissing(exclude?: Set<string>): number {
    return this.countVecMissing('l0', exclude);
  }

  private countVecMissing(kind: 'l1' | 'l0', exclude?: Set<string>): number {
    if (this.degraded) return -1;
    const vecTable = kind === 'l1' ? 'l1_vec' : 'l0_vec';
    if (kind === 'l1' ? !this.stmtSearchL1Vec : !this.stmtSearchL0Vec) return -1;
    const srcTable = kind === 'l1' ? 'l1_records' : 'l0_conversations';
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${srcTable} r
           LEFT JOIN ${vecTable} v ON v.record_id = r.record_id
           WHERE v.record_id IS NULL${notInClause('r.record_id', exclude)}`,
        )
        .all(...notInParams(exclude))[0] as { n: number };
      return row?.n ?? 0;
    } catch (err) {
      // -1 会让补齐判据(> 0)按"无缺失"处理——必须留痕,不能静默停摆
      this.logger?.warn(`${TAG} ${kind} 缺失向量计数失败(补齐判据按无缺失处理): ${err instanceof Error ? err.message : String(err)}`);
      return -1;
    }
  }

  /**
   * 待重嵌入的 L1:只取缺失向量的记录(增量),排除 skip 集里已判定
   * "当前 provider 下不可嵌入(零向量)"的 id——缺 1 条不再全量重嵌,
   * 零向量记录也不再反复喂给 embeddings API(死循环双根因)。
   */
  getL1ForReindex(exclude?: Set<string>): Array<{ id: string; content: string }> {
    if (this.degraded) return [];
    try {
      return this.db
        .prepare(
          `SELECT r.record_id AS id, r.content FROM l1_records r
           LEFT JOIN l1_vec v ON v.record_id = r.record_id
           WHERE v.record_id IS NULL${notInClause('r.record_id', exclude)}`,
        )
        .all(...notInParams(exclude)) as Array<{ id: string; content: string }>;
    } catch (err) {
      this.logger?.warn(`${TAG} L1 重嵌入取数失败(返回空,本轮跳过): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** 待重嵌入的 L0(增量 + 排除 skip 集,同 getL1ForReindex)。 */
  getL0ForReindex(exclude?: Set<string>): Array<{ id: string; text: string }> {
    if (this.degraded) return [];
    try {
      return this.db
        .prepare(
          `SELECT r.record_id AS id, r.message_text AS text FROM l0_conversations r
           LEFT JOIN l0_vec v ON v.record_id = r.record_id
           WHERE v.record_id IS NULL${notInClause('r.record_id', exclude)}`,
        )
        .all(...notInParams(exclude)) as Array<{ id: string; text: string }>;
    } catch (err) {
      this.logger?.warn(`${TAG} L0 重嵌入取数失败(返回空,本轮跳过): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── 零向量 skip 集(embedding_meta 持久化;provider 变化时随向量表一起清空) ──

  getVecSkipSet(kind: 'l1' | 'l0'): Set<string> {
    if (this.degraded) return new Set();
    try {
      const row = this.db
        .prepare('SELECT value FROM embedding_meta WHERE key = ?')
        .get(vecSkipKey(kind)) as { value: string } | undefined;
      if (!row) return new Set();
      const parsed = JSON.parse(row.value) as unknown;
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((x): x is string => typeof x === 'string'));
    } catch {
      return new Set();
    }
  }

  addVecSkippedIds(kind: 'l1' | 'l0', ids: string[]): void {
    if (this.degraded || ids.length === 0) return;
    try {
      let merged = [...new Set([...this.getVecSkipSet(kind), ...ids])];
      // 上限防 NOT IN 占位符无界膨胀(老构建变量上限 999);达到上限本身
      // 说明 embedding 服务大面积返回零向量,被挤出的旧 id 只是多一次重试
      if (merged.length > VEC_SKIP_CAP) {
        merged = merged.slice(-VEC_SKIP_CAP);
        this.logger?.warn(`${TAG} skip 集达上限 ${VEC_SKIP_CAP}(零向量记录过多,embedding 服务疑似异常)`);
      }
      this.db
        .prepare('INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(vecSkipKey(kind), JSON.stringify(merged));
    } catch (err) {
      this.logger?.warn(`${TAG} skip 集写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  clearVecSkipIds(kind: 'l1' | 'l0'): void {
    if (this.degraded) return;
    try {
      this.db.prepare('DELETE FROM embedding_meta WHERE key = ?').run(vecSkipKey(kind));
    } catch {
      /* 空集语义,失败无影响 */
    }
  }

  /** 只更新向量行(重嵌入用)。 */
  updateL1Vec(id: string, embedding: Float32Array): boolean {
    if (this.degraded || !this.stmtDeleteL1Vec || !this.stmtInsertL1Vec) return false;
    if (isZeroVector(embedding)) return false;
    try {
      this.stmtDeleteL1Vec.run(id);
      this.stmtInsertL1Vec.run(id, vecToBuffer(embedding), new Date().toISOString());
      return true;
    } catch {
      return false;
    }
  }

  updateL0Vec(id: string, embedding: Float32Array, recordedAt: string): boolean {
    if (this.degraded || !this.stmtDeleteL0Vec || !this.stmtInsertL0Vec) return false;
    if (isZeroVector(embedding)) return false;
    try {
      this.stmtDeleteL0Vec.run(id);
      this.stmtInsertL0Vec.run(id, vecToBuffer(embedding), recordedAt);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 批量更新 L1 向量行(重嵌入热路径):单事务写入整批——逐条每行一次隐式事务,
   * 批量场景(万级记录重嵌)开销集中在 fsync 上。
   * 整批失败回退逐条:好行照常入库,坏行只丢自身(向量行 id 寻址,无顺序依赖)。
   * 返回成功写入的行数(零向量行防御性跳过、不计入)。
   */
  updateL1VecBatch(items: Array<{ id: string; embedding: Float32Array }>): number {
    if (this.degraded || !this.stmtDeleteL1Vec || !this.stmtInsertL1Vec || items.length === 0) return 0;
    const del = this.stmtDeleteL1Vec;
    const ins = this.stmtInsertL1Vec;
    try {
      return this.withTransaction(() => {
        let written = 0;
        for (const it of items) {
          if (isZeroVector(it.embedding)) continue;
          del.run(it.id);
          ins.run(it.id, vecToBuffer(it.embedding), new Date().toISOString());
          written++;
        }
        return written;
      });
    } catch (err) {
      this.logger?.warn(`${TAG} L1 向量批量写入失败,回退逐条: ${err instanceof Error ? err.message : String(err)}`);
      let ok = 0;
      for (const it of items) if (this.updateL1Vec(it.id, it.embedding)) ok++;
      return ok;
    }
  }

  /** L0 版 updateL1VecBatch(语义同:单事务 + 失败回退逐条)。recordedAt 整批统一。 */
  updateL0VecBatch(items: Array<{ id: string; embedding: Float32Array }>, recordedAt: string): number {
    if (this.degraded || !this.stmtDeleteL0Vec || !this.stmtInsertL0Vec || items.length === 0) return 0;
    const del = this.stmtDeleteL0Vec;
    const ins = this.stmtInsertL0Vec;
    try {
      return this.withTransaction(() => {
        let written = 0;
        for (const it of items) {
          if (isZeroVector(it.embedding)) continue;
          del.run(it.id);
          ins.run(it.id, vecToBuffer(it.embedding), recordedAt);
          written++;
        }
        return written;
      });
    } catch (err) {
      this.logger?.warn(`${TAG} L0 向量批量写入失败,回退逐条: ${err instanceof Error ? err.message : String(err)}`);
      let ok = 0;
      for (const it of items) if (this.updateL0Vec(it.id, it.embedding, recordedAt)) ok++;
      return ok;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

// ============================
// 行映射工具
// ============================

interface L1MetaRow {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  version: number;
  timestamp_str: string;
  created_time: string;
  updated_time: string;
  metadata_json: string;
  family?: string;
  /** §E 可见范围列(旧库经 ALTER 补列后存在;补列前建的 FTS 表读取路径上为 undefined)。 */
  scope?: string;
  workspace_id?: string;
  /** 时间增强列(旧库经 ALTER 补列后存在;<0.11 的库与 l1_fts 读取路径上为 undefined)。 */
  valid_from?: string;
  valid_to?: string;
  persistence?: string;
}

function rowToRecord(row: L1MetaRow): MemoryRecord {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata_json || '{}') as Record<string, unknown>;
  } catch {
    /* 坏 JSON 容忍 */
  }
  return {
    id: row.record_id,
    content: row.content,
    type: row.type,
    priority: row.priority,
    scene_name: row.scene_name,
    timestamps: dbToTimestamps(row.timestamp_str),
    createdAt: Date.parse(row.created_time) || 0,
    updatedAt: Date.parse(row.updated_time) || 0,
    version: row.version ?? 0,
    metadata,
    family: normFamily(row.family, row.type),
    // §E:读回时归一(缺列/缺值一律 global)——"读不到归属"等价于"跨工作区可见",
    // 与写入侧 fail-open 同向:宁可退化成全局可见,也不让记忆凭空消失。
    scope: normScope(row.scope),
    workspaceId: row.workspace_id ?? '',
    // 时间轴回读:空串 → undefined(空串表示"未填",不是"时间 0")
    validFrom: row.valid_from ? Date.parse(row.valid_from) || undefined : undefined,
    validTo: row.valid_to ? Date.parse(row.valid_to) || undefined : undefined,
    persistence: normPersistence(row.persistence),
  };
}

/**
 * 双维回溯的 WHERE 构造。返回 `null` 表示**二维皆缺**——调用方据此返回空,
 * 而不是拼出无 WHERE 的全表扫描(那会把误用变成全库导出)。
 * 两维同给时按 `AND` 组合:问的是"这条记录在那一轮里被判成了什么"。
 */
function receiptWhere(q: ReceiptQuery): { sql: string; params: string[] } | null {
  const sql: string[] = [];
  const params: string[] = [];
  if (q.recordId) {
    sql.push('record_id = ?');
    params.push(q.recordId);
  }
  if (q.runId) {
    sql.push('run_id = ?');
    params.push(q.runId);
  }
  return sql.length === 0 ? null : { sql: sql.join(' AND '), params };
}

/** `conflict_pending` 行 → {@link ConflictPair}(snake_case 只活在这一层)。 */
function toConflictPair(r: Record<string, unknown>): ConflictPair {
  return {
    pairId: String(r.pair_id ?? ''),
    runId: String(r.run_id ?? ''),
    winnerId: String(r.winner_id ?? ''),
    loserId: String(r.loser_id ?? ''),
    createdAt: String(r.created_at ?? ''),
    resolvedAt: String(r.resolved_at ?? ''),
    resolution: String(r.resolution ?? ''),
  };
}

/** epoch 数组 → {逗号连接 ISO, 首尾 ISO}(磁盘格式契约:逗号连接、升序、ISO)。 */function timestampsToDb(ts: number[] | undefined): { str: string; start: string; end: string } {
  if (!ts || ts.length === 0) return { str: '', start: '', end: '' };
  const sorted = [...ts].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (sorted.length === 0) return { str: '', start: '', end: '' };
  const isos = sorted.map((t) => new Date(t).toISOString());
  return { str: isos.join(','), start: isos[0], end: isos[isos.length - 1] };
}

function dbToTimestamps(str: string): number[] {
  if (!str) return [];
  return str
    .split(',')
    .map((t) => Date.parse(t))
    .filter((t) => !Number.isNaN(t));
}

function toIso(epochMs: number | undefined): string {
  if (!epochMs || !Number.isFinite(epochMs)) return '';
  return new Date(epochMs).toISOString();
}

/** NOT IN 片段(空集 → 空串;配合 notInParams 使用)。 */
function notInClause(column: string, exclude?: Set<string>): string {
  if (!exclude || exclude.size === 0) return '';
  return ` AND ${column} NOT IN (${[...exclude].map(() => '?').join(',')})`;
}

function notInParams(exclude?: Set<string>): string[] {
  if (!exclude || exclude.size === 0) return [];
  return [...exclude];
}

function vecSkipKey(kind: 'l1' | 'l0'): string {
  return kind === 'l1' ? 'embedding_zero_vec_l1' : 'embedding_zero_vec_l0';
}

/** DB 字符串 → 族(异常值按 type 前缀兜底归一)。 */
function normFamily(raw: string | undefined, type: string): MemoryFamily {
  if (raw === 'work' || raw === 'chat') return raw;
  return familyForType(type);
}

// 向量编码工具的实现已抽到 `vec-utils.ts`（避免 sqlite ↔ graph-store 形成模块环），
// 此处 re-export 保持既有外部导入点不变；文件内部使用走上方 import。
export { isZeroVector, vecToBuffer };
