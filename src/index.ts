/**
 * dsh-memory-plugin — L0~L3 分层蒸馏记忆插件(持久组合插件)。
 *
 * 装配职责:数据目录与文件日志 → live 开关 → 会话档位 → 嵌入源三态解析 →
 * 检索引擎(memory.db)与分族存储 → 蒸馏 runner/重建控制器 → 捕获/召回钩子 →
 * 工具/RPC/bench 控制面 → 停机顺序。
 *
 * 存储架构(JSONL 事实源 + memory.db 主检索):见 README 与 store 层模块注释。
 * 降级铁律:存储初始化失败只停用捕获/蒸馏,绝不拖垮宿主启动。
 */
import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { memorySchema, resolveDataDir, readExtMemory, type MemoryConfig } from './config.js';
import { registerBenchControl } from './bench-control.js';
import { registerCapture } from './hooks/capture.js';
import { registerRecall } from './hooks/recall.js';
import { SessionRecalledStore } from './store/session-recalled.js';
import { MemoryRunner } from './pipeline/runner.js';
import { RebuildController } from './pipeline/rebuild.js';
import { RuminateController } from './pipeline/ruminate.js';
import { registerMemoryRpc, PLUGIN_VERSION } from './stats.js';
import { readStartupTrustedHosts } from './trusted-hosts.js';
import { buildExtAssembly } from './ext-memory/assembly.js';
import { makeExtPusher } from './ext-memory/pusher.js';
import { makeExtPuller } from './ext-memory/puller.js';
import { DatabaseSync } from 'node:sqlite';
import { registerMemoryCommand } from './tui-command.js';
import { makeExtImporter } from './ext-memory/importer.js';
import { makeExtGraphHints } from './ext-memory/graph-bridge.js';
import { createSecretStore } from './ext-memory/secrets.js';
import { scrubSecretsForLog } from './ext-memory/redact-gate.js';
import { normCsv, normCsvNumbers, sha256Hex } from './ext-memory/util.js';
import { applyCoexistGate } from './ext-memory/types.js';
import { readTombstones, type TombstoneSet } from './store/retire-journal.js';
import { applyBootMode, registerLiveSettings, suppressAutoSettingsForm } from './settings.js';
import { BootModeStore } from './store/boot-mode.js';
import { NoopEmbeddingService, type EmbeddingProviderInfo } from './store/embedding.js';
import {
  EmbeddingManager,
  EmbeddingSourceStore,
  makeLocalServiceFactory,
  resolveInitialEmbedding,
  type InitialEmbedding,
} from './store/embedding-source.js';
import { LocalEmbeddingService } from './store/local-embedding.js';
import { ModelDownloadQueue } from './store/download-queue.js';
import { PINNED_TRANSFORMERS_VERSION, RuntimeInstaller } from './store/runtime-installer.js';
import { cleanupOrphanTmp, ensureDir } from './util/io.js';
import { L0Store } from './store/l0.js';
import { L1Store, type GraphLaneProvider } from './store/l1.js';
import { PersonaStore } from './store/persona.js';
import { MemoryDb, type StoreInitResult } from './store/sqlite.js';
import { InProcMemoryBackend, type MemoryBackend } from './store/memory-backend.js';
import { createMemoryBackend } from './store/memory-backend-worker.js';
import { SceneStore } from './store/scenes.js';
import { SessionModeStore } from './store/session-modes.js';
import { StateStore } from './store/state.js';
import { SlotStore } from './store/slots.js';
import { RouteHealthStore, routeHealthPathFor } from './store/route-health.js';
import { registerMemoryTools } from './tools/index.js';
import { registerSlotTools } from './tools/slots.js';
import { registerSlotRecall } from './hooks/slot-recall.js';
import { registerObsoleteNotice } from './hooks/obsolete-notice.js';
import { RoomRegistryStore } from './store/rooms-registry.js';
import { MemorySourceStore } from './store/memory-sources.js';
import { SkillStore } from './store/skill-store.js';
import { createSkillProducer, type SkillProducer } from './skills/producer.js';
import { registerSkillRecall } from './hooks/skill-recall.js';
import { registerSkillTools } from './tools/skills.js';
import { RecallUsageStore } from './store/recall-usage.js';
import { RecallFeedbackStore } from './store/recall-feedback.js';
import { MdLedgerStore } from './store/memory-md-ledger.js';
import { makeFileSyncHook } from './store/memory-md-sync.js';
import { ObsoleteNoticeStore } from './store/obsolete-notices.js';
import { registerSlotsProjection } from './projection/slots.js';
import { registerRecallProjection } from './projection/recall.js';
import { DrscClient } from './clients/drsc.js';
import { readWebServerOrigin } from './clients/web-server-origin.js';
import type { MemoryLogger } from './types.js';
import { errDetail, withFileLog } from './util/filelog.js';
import { buildRouteChain, resolveModelRoute, invalidateEffortCache } from './llm.js';
import { effectiveCfg } from './pipeline/runner.js';
import { pendingPathFor } from './store/pending.js';
import { initTokenCost, resetTokenCost } from './token-cost.js';
import { initTraceStore } from './store/trace.js';

export const name = 'dsh-memory-plugin';

// issue #20:DrscClient 的第三档兜底。取数逻辑已抽到 clients/web-server-origin.ts
// (两条取数路径 + 三个抛错入口,需要被单测钉住而不是靠人肉真机核对),此处只接线。

/**
 * 硬依赖:蒸馏要用 llm,工具注册要用 tools,召回注入要用 systemPrompt。
 * 0.1.5 起 connection.rpc.handle() 把 /rpc 路由登记到 webServer 时按**调用方
 * fiber** 校验 inject 授权(0.1.1/0.1.2 由 connection 服务自己持有 webServer,
 * 调用方无需声明)——缺失即 `cannot get property "webServer" without inject`
 * 致命失败。故声明 connection + webServer;两者在 0.1.1~0.1.5 均存在,
 * 额外授权在旧版无害(声明式注入只会等这两个服务就绪,不改装配顺序)。
 */
export const inject = ['llm', 'tools', 'systemPrompt', 'connection', 'webServer'];

/**
 * 插件配置 schema。导出名必须是 `Config`——cordis 运行时只读 plugin.Config
 * (Standard Schema 接口)做校验与默认值填充;导出 `schema` 会被静默忽略,
 * 导致 config 里嵌套对象为 undefined、apply 抛错、fiber FAILED 拖垮宿主启动。
 */
export const Config = memorySchema;

export async function apply(ctx: Context, config: MemoryConfig): Promise<void> {
  let logger: MemoryLogger = {
    debug: (m) => ctx.logger.debug(m),
    info: (m) => ctx.logger.info(m),
    warn: (m) => ctx.logger.warn(m),
    error: (m) => ctx.logger.error(m),
  };

  const dataDir = resolveDataDir(config);
  // dsh 宿主无持久化日志,镜像 info+ 到数据目录 memory.log 供蒸馏问题诊断
  const fileLogger = withFileLog(dataDir, logger);
  logger = fileLogger;

  // 供应商拓扑变化(增删/改配置)→ 思考档位能力缓存失效,下次调用重新探询
  ctx.on('llm/adapters-updated', () => invalidateEffortCache());

  // 存储初始化失败只降级(禁用捕获/蒸馏),绝不拖垮宿主——
  // 记忆是增强能力,数据目录不可写时 dsh 本体必须照常启动。
  let storageOk = true;
  try {
    await ensureDir(dataDir);
  } catch (err) {
    storageOk = false;
    logger.error(
      `[memory] 数据目录不可写,记忆功能停用: ${dataDir} (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // 孤儿 tmp 扫描:进程被 kill -9 / 断电时原子写会留下 tmp(写失败路径已 unlink,
  // 只在硬中断下残留)。放在 store 载入之前——此刻还没有任何写者,清不掉"正在写"的文件。
  // 清理失败绝不影响启动(残留 tmp 不参与任何读路径)。
  if (storageOk) {
    try {
      await cleanupOrphanTmp(dataDir, logger);
    } catch (err) {
      logger.warn(
        `[memory] 孤儿临时文件扫描失败(忽略): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 记忆模式运行时开关(0.1.7 声明式:Config 的 live volatile 节;缺失时恒开) ──
  // 启动挡位另存插件自有文件（宿主 forms.update 不持久化新增的 bootMode 键，
  // 见 store/boot-mode.ts）；数据目录不可写时不建 store，挡位回落 volatile/默认。
  const bootStore = storageOk ? new BootModeStore(dataDir, logger) : undefined;
  const live = registerLiveSettings(ctx, config, logger, bootStore);
  // 启动挡位（三态 on/off/last）：on/off 把初值写回 enabled，last 保持持久值。
  // 异步写、失败不阻断启动（写面缺席的老宿主保持持久值）；0.27.9 起带诊断日志
  // 与竞态门（磁盘×运行时对照，不一致等一次 volatile 广播后重读）。
  void applyBootMode(live, logger);
  // 自带自定义设置页(client 半 settings.section「记忆」分节)→ 关掉宿主按
  // volatile 字段自动生成的表单页,避免同一插件出现两份设置入口。
  suppressAutoSettingsForm(ctx);

  /** 插件停机标志:置位后不再发起后台 embeddings 调用(dispose 序最先设置)。 */
  let disposed = false;

  // ── 会话档位存储(sessionId → auto/chat/work/off;默认档 = config.family) ──
  const modes = new SessionModeStore(dataDir, config.family, logger);
  if (storageOk) {
    try {
      await modes.init();
    } catch (err) {
      logger.warn(`[memory] 会话档位载入失败(降级为默认档内存态): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 嵌入源三态(远程/本地/关闭)——状态文件优先于静态配置 ──
  const sourceStore = new EmbeddingSourceStore(dataDir, logger);
  const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, { logger });
  const downloader = new ModelDownloadQueue(dataDir, {
    mirror: config.embedding.mirror,
    logger,
    proxy: config.embedding.proxy,
  });
  const makeLocalService = makeLocalServiceFactory(
    installer,
    downloader,
    logger,
    config.embedding.maxInputChars,
    undefined,
    config.embedding.maxInputTokens,
    config.embedding.respawnOnCrash,
  );
  let initial: InitialEmbedding = { svc: new NoopEmbeddingService(), dims: 0 };
  /** 管理器引用:启动重嵌链/backfill 闭包在运行期解引用(声明早于创建避免 TDZ)。 */
  // eslint-disable-next-line prefer-const -- 声明早于创建,后续单点赋值(TS 不允许 const 无初值)
  let embedManagerRef: EmbeddingManager | undefined;
  if (storageOk) {
    try {
      await sourceStore.init();
      initial = await resolveInitialEmbedding(config, sourceStore, downloader, makeLocalService, logger);
    } catch (err) {
      logger.warn(`[memory] 嵌入源初始解析失败(降级纯 FTS): ${errDetail(err)}`);
    }
  }
  /** meta 写入永远用当前目标(杜绝启动期闭包里的陈旧 providerInfo 腐蚀 embedding_meta)。 */
  const currentProviderInfo = (): EmbeddingProviderInfo | undefined =>
    embedManagerRef?.currentProviderInfo() ?? initial.providerInfo;

  // ── 检索引擎(memory.db)与向量服务 ──
  const embed = initial.svc;
  const memoryDbPath = path.join(dataDir, 'memory.db');
  const db = new MemoryDb(memoryDbPath, initial.dims, logger);
  initTokenCost(db, config.tokenCost.retentionDays);
  // §F 追踪(trace.enabled=false 时保持未初始化,埋点零副作用)
  if (config.trace?.enabled) initTraceStore(dataDir, { retentionDays: config.trace.retentionDays });
  // 插件卸载时关闭连接(WAL 落盘),注册一次即可
  ctx.effect(() => () => db.close());

  // ── dsh-tui 终端面：`/memory` ─────────────────────────────────────
  // TUI 不加载 11 个 tab（Graph/Records/Rooms/Scenes/Conflicts/…）→ 记忆库不可见。
  // 命令层只读：另开一条 readOnly 连接查计数/最近记录，不碰插件自己的写链。
  ;(ctx as unknown as {
    inject?: (deps: string[], cb: (scope: Context) => void) => void
  }).inject?.(['commands'], (scope) => {
    let ro: DatabaseSync | null = null
    const reader = (): DatabaseSync | null => {
      if (ro !== null) return ro
      try {
        ro = new DatabaseSync(memoryDbPath, { readOnly: true })
      } catch { ro = null }
      return ro
    }
    const count = (sql: string): number => {
      try {
        const row = reader()?.prepare(sql).get() as { c?: number } | undefined
        return typeof row?.c === 'number' ? row.c : 0
      } catch { return 0 }
    }
    const rows = (sql: string, limit: number): Array<Record<string, unknown>> => {
      try { return (reader()?.prepare(sql).all(limit) ?? []) as Array<Record<string, unknown>> } catch { return [] }
    }
    registerMemoryCommand(scope, {
      status: () => ({
        dbPath: memoryDbPath,
        dims: initial.dims,
        l0: count('SELECT COUNT(*) AS c FROM l0_conversations'),
        l1: count('SELECT COUNT(*) AS c FROM l1_records'),
        receipts: count('SELECT COUNT(*) AS c FROM l1_receipts'),
        conflicts: count('SELECT COUNT(*) AS c FROM conflict_pending'),
      }),
      records: (limit) => rows(
        'SELECT record_id, content, type, priority, scene_name, updated_time, family FROM l1_records ORDER BY updated_time DESC LIMIT ?',
        limit,
      ) as never,
      conflicts: (limit) => rows(
        'SELECT record_id, content FROM conflict_pending ORDER BY rowid DESC LIMIT ?',
        limit,
      ) as never,
      // 外部记忆驱动：配置是事实源（ext_drivers 表只是运行态镜像）。
      ext: () => {
        const value = readExtMemory(config.extMemory) as
          | { enabled?: boolean; syncMode?: string; drivers?: Array<{ id?: string }> }
          | undefined
        return {
          enabled: value?.enabled === true,
          syncMode: String(value?.syncMode ?? 'shadow-read'),
          drivers: (value?.drivers ?? []).map((driver) => String(driver?.id ?? '')).filter(Boolean),
        }
      },
      // Room 注册表（roomRegistry 在本作用域稍后创建；闭包在命令执行时才读）。
      rooms: () => roomRegistry.list().map((room) => ({ slug: room.slug, label: room.label, status: room.status })),
      // L2/L3 分族场景文件（chat / work 各自目录）。
      scenes: async () => {
        const chat = await stores.scenes.chat.listFiles()
        const work = await stores.scenes.work.listFiles()
        return { chat: chat.length, work: work.length, sample: [...chat, ...work].slice(0, 10) }
      },
      // 开关现值（live.get 投影 + 部署上限；与 settings-get 的 ceilings 同口径）。
      switches: () => {
        const s = live.get()
        return {
          enabled: s.enabled,
          capture: s.capture,
          distill: s.distill,
          recall: s.recall,
          injectBootMode: s.injectBootMode,
          extractBootMode: s.extractBootMode,
          memoryMutate: s.memoryMutate,
          ceilings: { capture: config.capture.enabled, distill: config.extract.enabled, recall: config.recall.enabled },
        }
      },
      // 命令层唯一写操作：总闸已退役，/memory on|off 同时拨两轴（recall + capture + distill），
      // 写后回读 recall 作生效代理（宿主可能拒写 → applied=false；回读不符 → drift）。
      setEnabled: async (next) => {
        try {
          await live.update({ recall: next, capture: next, distill: next })
          const eff = live.get().recall
          return { applied: true, effective: eff, drift: eff !== next }
        } catch {
          return { applied: false, effective: live.get().recall, drift: false }
        }
      },
      // 本会话已注入集：store 取 id 与取代/路归因，readOnly 联查 l1_records 取正文。
      recalled: (sessionId, n) => {
        const ids = (stores.recalled?.list(sessionId) ?? []).slice(0, n)
        if (ids.length === 0) return []
        const sup = stores.recalled?.supersededOf(sessionId)
        const lanes = stores.recalled?.lanesOf(sessionId)
        const place = ids.map(() => '?').join(',')
        const byId = new Map<string, Record<string, unknown>>()
        try {
          const rs = (reader()?.prepare(
            `SELECT record_id, content, type, family, scene_name FROM l1_records WHERE record_id IN (${place})`,
          ).all(...ids) ?? []) as Array<Record<string, unknown>>
          for (const r of rs) byId.set(String(r.record_id ?? ''), r)
        } catch { /* 查不到正文则仅列 id */ }
        return ids.map((id) => {
          const r = byId.get(id) ?? {}
          return {
            id,
            content: typeof r.content === 'string' ? r.content : undefined,
            type: typeof r.type === 'string' ? r.type : undefined,
            family: typeof r.family === 'string' ? r.family : undefined,
            scene_name: typeof r.scene_name === 'string' ? r.scene_name : undefined,
            superseded: sup?.has(id) ?? false,
            lane: lanes?.get(id),
          }
        })
      },
      // 最近有注入记录的会话（--last / 无参提示用；闭包运行时才读，同 rooms 先例）。
      recentSessions: () => stores.recalled?.recent(8) ?? [],
    })
  })

  let dbInit: StoreInitResult = { needsReindex: false };
  if (storageOk) {
    try {
      dbInit = db.init(initial.providerInfo);
      // #22 口径留痕:库里向量是在哪个 token 帽下嵌出来的,事后必须可查
      // (providerInfo 判据不含预算——未来调档若无声,这行是唯一证据)
      if (initial.providerInfo?.provider === 'local' && embed instanceof LocalEmbeddingService) {
        db.recordEmbeddingTokenBudget(embed.getTokenBudget());
      }
      if (db.isDegraded()) {
        storageOk = false;
        logger.error('[memory] 检索库初始化失败(schema/FTS 不可用),记忆功能停用');
      }
    } catch (err) {
      storageOk = false;
      logger.error(
        `[memory] 检索库打开失败,记忆功能停用: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // §D 第 3 路装配(回链 + 路内向量种子 + 1-hop,见 graph-store.searchLaneRecords):
  // embed 查询惰性接 stores.l1.embedText(嵌入源运行时活切换不被钉死在启动 service 上,
  // 且复用其超时/失败吞并语义——未就绪/失败 = undefined = 纯词法路,与旧 searchNodes
  // 表达式逐位一致)。图谱不可用时 searchLaneRecords 自带空返回,不影响双路。
  // eslint-disable-next-line prefer-const -- 声明早于创建,后续单点赋值(与 embedManagerRef 同款惰性缝;TS 不允许 const 无初值)
  let laneEmbedQuery: ((q: string) => Promise<Float32Array | undefined>) | undefined;
  const graphLaneProvider: GraphLaneProvider = async (query, limit, family, vecHint) => {
    // vecHint：l1.search 已算好的同一查询向量（省二次嵌入）；未给时维持旧行为自己算。
    const vec = vecHint !== undefined ? vecHint : (laneEmbedQuery ? await laneEmbedQuery(query).catch(() => undefined) : undefined);
    return db.graphStore.searchLaneRecords(query, vec, limit, family ? [family] : undefined);
  };

  // 外部记忆装配(计划 Phase 1):cfg.extMemory → registry + 第 5 路 provider。
  // **总闸关(默认)时 extAssembly.extLane 为 undefined** → L1Store 第 5 路结构性
  // 不存在、零驱动零网络——既有 hybrid 融合分逐位不变(零漂移)。
  // 凭据库(T3.5):Windows 用户级 DPAPI 优先,apiKey 可写 `secret://ref`;日志 sink
  // 统一包裹脱敏——外部链路的日志文本一律先过词表再出境(与推送闸门同词表)。
  const extSecrets = createSecretStore({ dataDir, logger });
  // extMemory 节已标 volatile(真机实测：宿主拒写未标节，`Config field "extMemory" is not volatile`)，
  // 读侧统一经 readExtMemory 兼容两形(新线给引用、老线给冻结值)。现取现用：
  // 面板写入后下一轮就能读到新值(装配仍只在启动跑，所以写后需重载)。
  const extSection = () => readExtMemory(config.extMemory);
  // 共存门控(T4.2):md 投射 × 外部 two-way 同开 → 降 shadow-read + 明说原因(不静默降能力)。
  // 档位热覆盖:live.extSyncMode 非空则优先(面板三档单选),空 = 跟随部署配置。
  const syncGate = applyCoexistGate({
    extMemoryEnabled: extSection()?.enabled === true,
    syncMode: live.get().extSyncMode || (extSection()?.syncMode ?? 'shadow-read'),
    memExportEnabled: config.memExport?.enabled === true,
  });
  if (syncGate.notice !== undefined) logger.warn(`[memory] ${syncGate.notice}`);
  const extLogger = {
    info: (m: string) => logger.info(scrubSecretsForLog(m)),
    warn: (m: string) => logger.warn(scrubSecretsForLog(m)),
    error: (m: string) => logger.error(scrubSecretsForLog(m)),
    debug: (m: string) => logger.debug?.(scrubSecretsForLog(m)),
  };
  const extAssembly = await buildExtAssembly({ cfg: config, logger: extLogger, secretStore: extSecrets, syncModeOverride: syncGate.syncMode });

  const stores = {
    usage: undefined as RecallUsageStore | undefined, // 装配于下方(依赖 dataDir 就绪)
    routeHealth: undefined as RouteHealthStore | undefined, // R9 路由健康学习，装配于下方
    // 轨2 技能结晶生产者（issue #15 的缺失环节）：装配于下方（依赖 skillStore 就绪）。
    skills: undefined as SkillProducer | undefined,
    // DRSC 客户端(T8.4 读切):蒸馏背景窗 + conversation_search 工具面的历史供给。
    // 硬依赖无本地回退(l0 表退役);trustedHosts 与宿主 origin 均惰性读取(两者可能晚于本插件就绪)。
    drsc: new DrscClient({
      trustedHosts: () => readStartupTrustedHosts(ctx),
      origin: () => readWebServerOrigin(ctx),
    }),
    l0: new L0Store(db),
    l1: new L1Store(
      dataDir,
      db,
      embed,
      config.recall.strategy,
      logger,
      config.recall.decayHalfLifeDays,
      // §D 第 3 路:图谱回链(声明于 stores 之前,embed 查询在下方接线)。
      graphLaneProvider,
      // 投射开着才给没名字的新记录起名（“关时零动作”这条承诺不改）。
      // 传函数而不是布尔：读的是当前配置对象，不把启动那一刻的值钉进 store。
      () => config.memExport?.enabled === true,
      // 第 5 路(外部记忆,Phase 1):未开启 = undefined = 该路不存在(零漂移)。
      extAssembly.extLane,
    ),
    // L2/L3 分族隔离:各自目录与文件(scenes/chat|work、persona-chat|work.md)
    scenes: {
      chat: new SceneStore(dataDir, 'chat', logger),
      work: new SceneStore(dataDir, 'work', logger),
    },
    persona: {
      chat: new PersonaStore(dataDir, 'chat', logger),
      work: new PersonaStore(dataDir, 'work', logger),
    },
    state: new StateStore(StateStore.pathFor(dataDir), logger),
    // 会话“活召回集”（G-live）：sessionKey → 本会话已注入未压缩的记录 id；持久化，旧会话重开载回。
    recalled: new SessionRecalledStore(dataDir, logger),
    // 召回相关度反馈与过时播报队列（装配于下方，需 await init）。
    feedback: undefined as RecallFeedbackStore | undefined,
    notices: undefined as ObsoleteNoticeStore | undefined,
    // md 投射指纹账本（N9；装配于下方，需 await init）。
    mdLedger: undefined as MdLedgerStore | undefined,
    // 激活槽位(active slot):独立 slots.json,高频小改不拖累 checkpoint 原子写
    slots: new SlotStore(
      SlotStore.pathFor(dataDir),
      logger,
      {
        maxSlots: config.slots.maxSlots,
        maxBodyChars: config.slots.maxBodyChars,
        maxTitleChars: 60,
      },
    ),
    // 图谱存储(MemoryDb 内自治:初始化失败仅图谱 no-op,不影响主链路)
    graph: db.graphStore,
    // 后台记忆后端:初始化完成后填充(worker 隔离,失败则进程内)
    backend: undefined as MemoryBackend | undefined,
  };
  // 惰性缝接线:provider 在检索时才解引用(l1 已就绪);声明序上的"先声明后赋值"
  // 只影响装配期,而装配期不会有检索在飞(启动未完就没有 agent 回合)。
  laneEmbedQuery = (q) => stores.l1.embedText(q);
  if (storageOk) {
    try {
      await Promise.all([
        stores.l1.init(),
        stores.scenes.chat.init(),
        stores.scenes.work.init(),
        stores.persona.chat.init(),
        stores.persona.work.init(),
        stores.slots.load(),
      ]);
    } catch (err) {
      storageOk = false;
      logger.error(
        `[memory] 存储初始化失败,记忆功能停用: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 检索能力与策略说明(能力位由降级结果决定)
  const caps = db.getCapabilities();
  if (storageOk && config.recall.strategy !== 'keyword' && !caps.vectorSearch) {
    logger.warn(
      `[memory] 检索策略 ${config.recall.strategy} 需要向量能力(embedding 未启用/不可用),本次运行按 keyword(FTS5 BM25)检索`,
    );
  }
  logger.info(
    `[memory] 数据目录: ${dataDir}(v${PLUGIN_VERSION},默认档=${config.family},检索: FTS=${caps.ftsSearch} 向量=${caps.vectorSearch}${storageOk ? '' : ',存储不可用已停用捕获/蒸馏'})`,
  );
  // 蒸馏模型路由:启动期解析一次并记录(路由错误是最难事后排查的问题之一);
  // 用运行时调参视图解析——用户已用 UI 覆盖蒸馏模型时,日志反映实际路由
  try {
    const cfgView = effectiveCfg(config, live);
    const route = await resolveModelRoute(ctx, cfgView);
    // 链长度按同一解析口径计(相同条目会被去重),排障时无需 --dump-config 即可确认回退链生效
    const chain = buildRouteChain(route, cfgView.llm.fallbacks, cfgView.llm.reasoningEffort);
    logger.info(
      `[memory] 蒸馏模型路由: ${route.provider}/${route.model}${chain.length > 1 ? `(+${chain.length - 1} 回退)` : ''}`,
    );
  } catch (err) {
    logger.warn(`[memory] 蒸馏模型路由解析失败: ${errDetail(err)}`);
  }

  // embedding 配置变化 → 后台全量重嵌入(不阻塞启动)。
  // meta 标记条件 = 失败为 0 且缺失复查为 0(服务未就绪的空转不算成功)。
  if (storageOk && initial.providerInfo && !db.isDegraded()) {
    const info = initial.providerInfo;
    if (dbInit.needsReindex) {
      if (caps.vectorSearch) {
        void (async () => {
          try {
            if (disposed || embedManagerRef?.isBusy()) return;
            // 增量:配置变化路径向量表已被 drop,全部记录均"缺失",等效全量;
            // 活切换发起时让路(swap 会 drop 表,并发跑只是白烧嵌入调用)
            const shouldCancel = () => disposed || !!embedManagerRef?.isBusy();
            // T8.4:l0 向量腿随写停退役(表清空后无缺失,无需重建)
            const r1 = await stores.l1.reindex({ shouldCancel });
            // missing 复查:嵌入服务未就绪时 reindex 短路 0/0/0——那是"没跑"不是"成功",
            // 不得标记 meta(否则启动链不再补,补齐被无限推迟到 backfill)
            const missingAfter = db.countL1VecMissing(db.getVecSkipSet('l1'));
            if (r1.failed === 0 && missingAfter === 0) {
              db.markEmbeddingSynced(currentProviderInfo() ?? info);
              const skipNote = r1.skipped > 0 ? `,跳过不可嵌入 ${r1.skipped} 条` : '';
              logger.info(
                `[memory] 向量重建完成:L1 ${r1.written} 条${skipNote}(原因:${dbInit.reason ?? '配置变化'})`,
              );
            } else {
              logger.warn(
                `[memory] 向量重建未完成(L1 失败 ${r1.failed},剩缺 ${Math.max(missingAfter, 0)} 条),下次启动/补齐周期重试`,
              );
            }
          } catch (err) {
            logger.warn(`[memory] 向量重建失败: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            embedManagerRef?.invalidateVecCache();
          }
        })();
      }
    } else {
      // meta 已匹配或空库(initSchema 已写入),幂等重写一次
      db.markEmbeddingSynced(currentProviderInfo() ?? info);
    }

    // 周期性向量补齐:嵌入失败的批次/漏网记录自动补上(30 分钟一次)。
    // 判据 = 排除 skip 集后的缺失数(增量语义):缺 1 条只补 1 条,
    // 零向量记录进 skip 集后不再触发——否则补齐永不收敛、每 30 分钟全量重嵌。
    // 注册不依赖启动期 caps/providerInfo(off 起步后活切回旧源也要能补),
    // 执行期动态查当前目标与能力位。
    {
      const backfill = (): void => {
        void (async () => {
          try {
            if (disposed) return;
            const infoNow = currentProviderInfo();
            const capsNow = db.getCapabilities();
            if (!infoNow || !capsNow.vectorSearch) return;
            // 活切换链(安装/下载/重嵌)进行中让路——增量 reindex 天然幂等,
            // 但并发跑只是白烧一次嵌入调用
            if (embedManagerRef?.isBusy()) return;
            const l1Missing = db.countL1VecMissing(db.getVecSkipSet('l1')) > 0;
            if (!l1Missing) return;
            const shouldCancel = () => disposed || !!embedManagerRef?.isBusy();
            // T8.4:l0 向量腿随写停退役
            const r1 = await stores.l1.reindex({ shouldCancel });
            const missingAfter = db.countL1VecMissing(db.getVecSkipSet('l1'));
            if (r1.failed === 0 && missingAfter === 0) {
              db.markEmbeddingSynced(infoNow);
              logger.info(
                `[memory] 向量补齐完成:L1 ${r1.written} 条(跳过不可嵌入 ${r1.skipped} 条)`,
              );
            } else if (r1.failed > 0) {
              logger.warn(`[memory] 向量补齐未完成(L1 失败 ${r1.failed}),下个周期重试`);
            } else if (missingAfter < 0) {
              // 计数失败时 sqlite 层给 -1(它自己已 warn);本侧**不得**把「数不出」当「无缺失」
              // 而滑进下方的停摆告警,更不能标 synced。
              logger.warn('[memory] 向量补齐:缺失数统计失败,本轮不判定完成');
            } else {
              // 本轮未写入且仍有缺失:典型形态是本地嵌入转入 failed 后 reindex 首行早退
              // (`if (!vectorReady()) return 0/0/0`),与「本轮无事可做」在日志里原本不可区分。
              logger.warn(
                `[memory] 向量补齐停摆:本轮未写入且仍差 ${missingAfter} 条` +
                  `(本地嵌入可能处于 failed 态,见上一条带 signal 的退出记录)`,
              );
            }
          } catch (err) {
            logger.warn(`[memory] 向量补齐失败: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            // 补齐走了 store 层写路径,管理器的计数缓存拿不到回调 → 显式失效
            embedManagerRef?.invalidateVecCache();
          }
        })();
      };
      ctx.effect(() => {
        const timer = setInterval(backfill, 30 * 60_000);
        const first = setTimeout(backfill, 60_000);
        return () => {
          clearInterval(timer);
          clearTimeout(first);
        };
      });
    }
  }

  // 嵌入管理器(活切换/下载/运行时安装;存储降级时不建——RPC 走 supported=false)
  const embedManager =
    storageOk && !db.isDegraded()
      ? new EmbeddingManager({
          dataDir,
          cfg: config,
          db,
          l1: stores.l1,
          sourceStore,
          installer,
          downloader,
          initial,
          logger,
          makeLocal: makeLocalService,
        })
      : undefined;
  embedManagerRef = embedManager;

  // 外部图提示桥(T3.6):三家外部图 → 投影 prompt 的关系线索(60s 缓存,不落库)
  const extGraphHints = makeExtGraphHints({
    registry: extAssembly.registry,
    spacesOf: (driverId: string) => {
      const entry = (extSection()?.drivers ?? []).find((d) => d.id === driverId);
      const externalId = entry !== undefined && entry.space !== '' ? entry.space : 'main';
      return [{ spaceId: `${driverId}:${externalId}`, driverId, externalId, name: externalId, description: '' }];
    },
    cfg: () => ({
      maxLinesPerDriver: 12,
      timeoutMs: extSection()?.requestTimeoutMs ?? 15_000,
      cacheMs: 60_000,
    }),
    logger: extLogger,
  });
  const runner = new MemoryRunner(ctx, config, stores, logger, live, modes, extGraphHints);
  await runner.init();
  // 档位切换同步(ADR-0003):切走按捕获档位落袋 / 切 off 挂起 / 切回清挂起
  modes.setModeChangeHandler((sessionId, oldMode, newMode) => runner.onModeChange(sessionId, oldMode, newMode));
  // 闲置兜底:静默达标会话的未蒸馏切片自动落袋(idleSeconds=0 关闭)
  runner.startIdleTimer();
  // 图谱周期补投影（开关在 tick 内判：部署 graph.enabled 或面板 live.graphEnabled；30 分钟一次低速收敛）
  runner.startGraphBackfillTimer();
  // 时效标注存量回填(expiry-tiering task_6.3:tieringEnabled 门控,低频、让位蒸馏)
  runner.startValidityBackfillTimer();

  // 重建控制器(存储降级时不建——RPC 端点走 supported=false 分支)
  const rebuild =
    storageOk && !db.isDegraded()
      ? new RebuildController(ctx, config, stores, db, runner, logger, live)
      : undefined;

  // 反刍控制器(与重建共用数据,但更轻量;存储降级时不建)
  const ruminateFile = storageOk ? pendingPathFor(resolveDataDir(config)) : '';

  // 后台记忆后端:优先 worker 线程隔离(后台批处理的同步 SQL 不再占主事件循环),
  // 起不来就退回进程内(功能不受影响,只留一条 warn)。
  let backend: MemoryBackend = new InProcMemoryBackend(stores.l1);
  if (storageOk && !db.isDegraded()) {
    backend = await createMemoryBackend(
      { dbPath: path.join(dataDir, 'memory.db'), dimensions: initial.dims, logger },
      backend,
    );
  }
  stores.backend = backend;

  // Room 注册表(分类管理 beta.4;损坏降级为纯自生长目录)
  const roomRegistry = new RoomRegistryStore(dataDir, logger);
  await roomRegistry.init();
  // 外部记忆来源注册表（轨3 Connect；默认由 cfg.memport.enabled 关门控，sidecar 本身无条件加载）
  const memorySources = new MemorySourceStore(dataDir, logger);
  await memorySources.init();
  // 外部记忆驱动(计划 ext-mem-drivers-sync T0.8 装配面):配置登记项单向镜像进
  // ext_drivers——**配置是事实源,表只是面板与后续 pusher 的运行态镜像**。总闸关时
  // 什么都不写(默认关部署零旁路行为);apiKey 不入表(secrets 只落键名位)。
  // Phase 0 **不创建活实例**(驱动装配/探活在 Phase 1),镜像仅供面板列得出登记态。
  if (extSection()?.enabled === true) {
    for (const d of extSection()!.drivers) {
      if (!d.id || !d.type) {
        logger.warn('[memory] ext_memory.drivers 有缺 id/type 的条目,已跳过镜像');
        continue;
      }
      stores.l1.ext.upsertDriver({
        driverId: d.id,
        typeId: d.type,
        enabled: d.enabled,
        connJson: JSON.stringify({ endpoint: d.endpoint, space: d.space, extra: d.extra }),
        secretRefs: d.apiKey ? 'apiKey' : '',
      });
    }
  }
  // 技能存储（轨2；sidecar 无条件加载，但工具/注入均由 cfg.skills.enabled 默认关自 no-op）
  const skillStore = new SkillStore(dataDir, logger);
  await skillStore.init();
  // 技能结晶生产者：稳态由 runner 在每轮 L2 之后喂（`stores.skills`），历史存量走
  // 面板「立即检测历史」/`skills-detect` RPC。cfg 用函数取：面板改阈值下一轮即生效。
  stores.skills = createSkillProducer({
    skills: skillStore,
    l1: stores.l1,
    cfg: () => effectiveCfg(config, live).skills,
    logger,
  });
  // 诚实化（issue #15 建议 3）：开关已开但 sidecar 从来没被写过，就是“无生产者”的
  // 历史现场。以前这里静默为 0、界面看不出异常，用户只能猜是自己操作错了。
  if (skillStore.wasAbsentAtBoot() && (config.skills.enabled || live.get().skillsEnabled)) {
    logger.warn('[memory] 技能开关已开但 skills.json 尚不存在：将在首轮结晶后生成（存量可在技能页点「立即检测历史」回灌）');
  }
  const ruminate =
    storageOk && !db.isDegraded() && ruminateFile
      ? new RuminateController(ctx, config, runner, stores, logger, live, ruminateFile, roomRegistry)
      : undefined;

  let flushL0: (() => Promise<void>) | undefined;
  if (storageOk) {
    flushL0 = registerCapture(ctx, config, runner, db.l0Watermark, logger, live, modes);
  }
  // 召回使用统计(进 topN 才算 used;热路径只碰内存,去抖落盘)
  const recallUsage = new RecallUsageStore(dataDir, logger);
  await recallUsage.init();
  stores.usage = recallUsage;
  // R9 路由健康学习：跨进程留存"退避后跑通的最小块长"，供 runExtraction 收紧 perChunk。
  const routeHealth = new RouteHealthStore(routeHealthPathFor(dataDir));
  await routeHealth.load();
  stores.routeHealth = routeHealth;
  // 召回相关度反馈（人在召回卡上打 -1..5）与「已声明过时」待播报队列。
  // 两个都是低频用户动作 → 立即落盘；sidecar 缺席/损坏只降级为只读，不阻断任何读路径。
  const recallFeedback = new RecallFeedbackStore(dataDir, logger);
  await recallFeedback.init();
  stores.feedback = recallFeedback;
  const obsoleteNotices = new ObsoleteNoticeStore(dataDir, logger);
  await obsoleteNotices.init();
  stores.notices = obsoleteNotices;
  // md 投射指纹账本（N9）：派生态，缺席/损坏只降级为只读，不弄挂任何读路径。
  // 它与 feedback/notices 同属“库外 sidecar”，不进快照哈希投影。
  const mdLedger = new MdLedgerStore(dataDir, logger);
  await mdLedger.init();
  stores.mdLedger = mdLedger;
  // 库→文件投射的跟随钩子：**收口在 `L1Store` 的四个汇流口**（appendNew / retire / restore / rename），
  // 不在这里往调用方分发。不变式本体在 `store/memory-md-sync.ts`。
  // 为什么只能装配层建：工具面/冲突裁决各自看不到 cfg + ledger + dataDir 的完整视野。
  const fileSync = makeFileSyncHook({
    getByIds: (list) => stores.l1.getByIds([...list]),
    // 现读生效配置（volatile 热更后不必重启）：与 RPC 分发用同一个 `effectiveCfg` 口径。
    exportCfg: () => {
      const exp = effectiveCfg(config, live).memExport;
      return {
        enabled: exp?.enabled === true,
        root: exp?.root,
        maxRecords: exp?.maxRecords ?? 2000,
        timeBudgetMs: exp?.timeBudgetMs ?? 120_000,
      };
    },
    dataDir,
    ledger: () => stores.mdLedger,
    logger,
  });
  // 晚绑定：`stores.l1` 在 md 账本之前就建好了，这里只把钩子接上去。
  stores.l1.setFileSyncHook(fileSync);
  // ── 外部记忆推送泵(计划 Phase 2)──────────────────────────────
  // 双闸(装配 enabled && push.enabled)+ syncMode 闸在 pusher 内部判;这里只管接线
  // 与调度:hook 入队 → wake 单飞投 runner 'ext-sync' 任务(永远让位 live/graph);
  // 退避中的到票时刻用一次性定时器重臂(不建常驻轮询——"不新建定时器"的底线是
  // 不拿 interval 空转,未来到票只能靠 one-shot 唤醒)。
  let extPumpQueued = false;
  let extWakeTimer: ReturnType<typeof setTimeout> | null = null;
  const extWakeArm = (): void => {
    if (extWakeTimer !== null) clearTimeout(extWakeTimer);
    const due = stores.l1.ext.earliestPendingWake();
    if (due <= 0) return;
    const delay = Math.min(Math.max(due - Date.now(), 1_000), 15 * 60_000);
    extWakeTimer = setTimeout(() => {
      extWakeTimer = null;
      extWake();
    }, delay);
  };
  const extSpacesOf = (driverId: string): Array<{ spaceId: string; driverId: string; externalId: string; name: string; description: string }> => {
    const entry = (extSection()?.drivers ?? []).find((d: { id: string }) => d.id === driverId);
    const externalId = entry !== undefined && entry.space !== '' ? entry.space : 'main';
    return [{ spaceId: `${driverId}:${externalId}`, driverId, externalId, name: externalId, description: '' }];
  };
  const extPusher = makeExtPusher({
    registry: extAssembly.registry,
    spacesOf: extSpacesOf,
    ext: stores.l1.ext,
    l1: stores.l1,
    cfg: () => {
      const p = extSection()?.push;
      return {
        masterEnabled: extAssembly.enabled,
        // 运行时热阀与部署配置**取或**(仓库既定约定:graphEnabled/keywordEnabled 同款)——
        // 面板开关是“显式追加开闸”,部署 YAML 是安装面默认;两者任一开即开。
        enabled: p?.enabled === true || live.get().extPushEnabled,
        syncMode: syncGate.syncMode,
        families: normCsv(p?.families),
        maxItems: p?.maxItems ?? 200,
        timeBudgetMs: p?.timeBudgetMs ?? 120_000,
        settleTimeoutMs: p?.settleTimeoutMs ?? 180_000,
        maxAttempts: p?.maxAttempts ?? 3,
        backoffMs: normCsvNumbers(p?.backoffMs, [1000, 3000, 10000]),
        // 不可逆远端删的运行时热阀:与部署配置取或(面板上带警示文案)
        allowHardDelete: p?.allowHardDelete === true || live.get().extAllowHardDelete,
        settleScanLimit: p?.settleScanLimit ?? 100,
      };
    },
    wake: extWake,
    logger: extLogger,
  });
  function extWake(): void {
    if (extPumpQueued) return;
    extPumpQueued = true;
    runner.enqueueExtSyncTask(async () => {
      try {
        await extPusher.runBatch();
      } finally {
        extPumpQueued = false;
        extWakeArm();
      }
    });
  }
  stores.l1.setExtSyncHook(extPusher.hook);

  // ── 外部记忆拉取泵(计划 T3.1)──────────────────────────────
  // 墓碑硬闸:每轮拉取前重读一次退场台账(读文件 async、判据 sync → 这里缓存)。
  let tombstones: TombstoneSet = { reasonFor: () => undefined, size: 0 };
  const extPuller = makeExtPuller({
    registry: extAssembly.registry,
    spacesOf: extSpacesOf,
    ext: stores.l1.ext,
    l1: stores.l1,
    isTombstoned: (norm) => tombstones.size > 0 && tombstones.reasonFor(sha256Hex(norm)) !== undefined,
    beforeBatch: async () => {
      tombstones = await readTombstones(dataDir, logger);
    },
    cfg: () => {
      const p = extSection()?.pull;
      return {
        masterEnabled: extAssembly.enabled,
        enabled: p?.enabled === true || live.get().extPullEnabled,
        syncMode: syncGate.syncMode,
        maxItems: p?.maxItems ?? 2000,
        timeBudgetMs: p?.timeBudgetMs ?? 120_000,
        families: normCsv(p?.families),
      };
    },
    logger: extLogger,
  });
  // 外源导入任务编排（计划 ext-to-l1-import）：面板“导入到本地库”的后台任务层。
  // 护栏默认沿用 pull 那一对（maxItems / timeBudgetMs）：不另建一套旋钮，
  // 否则“对账一轮拉多少”与“导入一次拉多少”会变成两个各自演化、互相说不清的数字。
  const extImporter = makeExtImporter({
    puller: extPuller,
    ext: stores.l1.ext,
    logger: extLogger,
    l1Total: () => stores.l1.list({ limit: 1, offset: 0 }).total,
    cfg: () => {
      const p = extSection()?.pull;
      return { maxItems: p?.maxItems ?? 2000, timeBudgetMs: p?.timeBudgetMs ?? 120_000 };
    },
  });
  let extPullQueued = false;
  const extPullOnce = (): void => {
    if (extPullQueued) return;
    extPullQueued = true;
    runner.enqueueExtSyncTask(async () => {
      try {
        await extPuller.runBatch();
      } finally {
        extPullQueued = false;
      }
    });
  };
  // interval 轮询是显式配置的入站节奏(默认 15min;0/关闸不建定时器)
  const pullNow = extSection()?.pull;
  const pullIntervalMs = pullNow?.enabled === true ? (pullNow.intervalMs ?? 0) : 0;
  if (extAssembly.enabled && pullIntervalMs > 0) {
    const timer = setInterval(extPullOnce, pullIntervalMs);
    ctx.effect(() => () => clearInterval(timer));
  }
  const recall = registerRecall(ctx, config, stores, logger, live, modes, dataDir, recallUsage);
  runner.setAfterRun(recall.invalidateProfile);
  const toolSeals = registerMemoryTools(ctx, config, stores, logger, modes, live, ruminate, storageOk ? roomRegistry : undefined, {
    // 确定性写面钩子(graph-write-plane R2/R3):runner 公开方法直连,工具三路径与
    // distill 分支共用同一个入队实现,不存在第二套优先级/去重逻辑。
    enqueueGraph: (ids) => runner.enqueueGraphFor(ids),
    reprojectGraph: (ids) => runner.reprojectGraph(ids),
    rebuildGraph: () => runner.rebuildGraph(),
    sweepGraph: (dryRun) => runner.sweepGraph(dryRun),
  });
  // 激活槽位(active slot):工具面 + 常驻注入 + 服务端投影(均走 ctx.effect,可撤销)
  registerSlotTools(ctx, config, stores.slots, logger, modes, live, stores.l1);
  const slotRecall = registerSlotRecall(ctx, config, stores.slots, logger, live);
  // 轨2 技能：工具面经宿主封印机制(seals)登记，与常驻注入分离（默认关时自 no-op，零表面积）。
  registerSkillTools(ctx, skillStore, logger, live, toolSeals);
  registerSkillRecall(ctx, config, skillStore, logger, live);
  // memorySlots 投影：常驻槽位（手动 pin 的约定）的展示契约，消费方是 dsh-brief-sidebar。
  // 宿主契约（dsh-session-projection/lib/index.js）：插件不注册时 key 从快照消失、
  // 客户端读作 capability absence（不会毒化历史加载），所以“摘注册”技术上可行；
  // 但那是把跨插件展示契约直接抽掉，旧版 brief-sidebar 会默默丢分区——隐藏请走它自己的
  // 「记忆槽位分区」开关。本包另提供一个会话感知的 memoryRecall 投影。
  registerSlotsProjection(ctx, stores.slots, stores.l1);
  // memoryRecall 投影：本会话“已注入且未被压缩覆盖”的召回集（会话感知，init 取 header.id），
  // 与常驻槽位是两条轴：那个是手动 pin 的硬注入约定，这个是非常驻的相关性浮现结果。
  // 带上反馈面：条目要显示人已经打过的那一笔（rating）。
  registerRecallProjection(ctx, stores.recalled, stores.l1, recallFeedback, logger);
  // 人打 -1 声明过时后，下一轮向模型一次性播报“这条已退场、别再依据它作答”。
  registerObsoleteNotice(ctx, config, obsoleteNotices, logger);
  void slotRecall;
  registerMemoryRpc(
    ctx,
    config,
    stores,
    logger,
    {
      degraded: () => !storageOk || db.isDegraded(),
      pending: () => runner.pendingCount,
    },
    live,
    modes,
    dataDir,
    rebuild,
    embedManager,
    // 悬浮卡信息区数据源(session-stats 热路径端点;全部内存读 + 索引 COUNT,零文件 I/O)
    {
      recallStats: (sid) => recall.stats(sid),
      memoryOccupancy: (sid) => recall.occupancy(sid),
      profileEstimate: (sid) => recall.estimateProfileTokens(sid),
      recallEstimate: (sid) => recall.estimateRecallTokens(sid),
      runnerView: (sid, mode) => runner.sessionView(sid, mode),
      l0Count: (sid) => stores.l0.countBySession(sid),
      capabilities: () => db.getCapabilities(),
    },
    ruminate,
    storageOk ? roomRegistry : undefined,
    storageOk ? memorySources : undefined,
    skillStore,
    // 技能生产者：面板「立即检测历史」与 producer 健康态的数据源。
    stores.skills,
    // 外部记忆装配体(Phase 1):ext-* 面板端点读实驱动态/真探活。
    extAssembly,
    // 外源导入任务编排（计划 ext-to-l1-import）：ext-import-* 三端点的数据源。
    extImporter,
  );

  // bench 控制服务(config.benchControl 门控,默认关):仅基准/调试部署注册,
  // 供同进程的 bench-runner lifecycle 赛道触发 rebuild / 设置会话档位
  // (宿主侧 RPC 无 call(),见 bench-control.ts)
  if (config.benchControl && rebuild) {
    const disposeBench = registerBenchControl(ctx, rebuild, modes, logger);
    ctx.effect(() => () => disposeBench());
  }

  logger.info(
    `[memory] L0~L3 分层蒸馏记忆插件就绪(L1 记忆 ${storageOk ? stores.l1.size : 0} 条 | 捕获=${
      storageOk && config.capture.enabled
    } | 蒸馏=${storageOk && config.extract.enabled} | 召回=${config.recall.enabled})`,
  );
  // 读路缓存预热（2026-11-09 召回延迟修复；issue #39 重构）：不再在 apply() 同步段起跑——
  // 默认延迟 graphWarmupDelayMs(3000ms) 等宿主 loader.await 与首会话恢复走完后才后台预热，
  // timer unref 防拖停机，dispose 时 clearTimeout + disposed 旗标双保险。warmSearchCache 入口
  // 自带宏任务让出（store 层不变量），delayMs=0 也不抢跑；分片按 16ms 时间预算动态截止
  //（改前固定 128 节点/片长尾单片 1,050ms）、片间 setTimeout 让宿主事件穿插。
  // 首条消息若在预热完成前到达，turn→step 最多排队一个预算片（≤~16ms 级，改前 2.5–3.1s）；
  // warm 只填缓存，不改检索语义。
  let graphWarmupTimer: ReturnType<typeof setTimeout> | null = null;
  if (storageOk && config.recall.enabled && db.graphStore.ready) {
    graphWarmupTimer = setTimeout(() => {
      void (async () => {
        const t0 = Date.now();
        try {
          const warmed = await db.graphStore.warmSearchCache(() => disposed || !db.graphStore.ready);
          if (!disposed)
            logger.info(`[memory] 图谱读路缓存预热完成(${warmed.nodes} 节点 / ${warmed.edges} 边, ${Date.now() - t0}ms)`);
        } catch (err) {
          logger.warn(`[memory] 图谱读路缓存预热失败(不影响检索,冷路径照常分词): ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }, config.recall.graphWarmupDelayMs);
    graphWarmupTimer.unref?.();
  }

  // 停机顺序:置停机标志(后台 embeddings 不再发起)→ 停蒸馏取新任务 →
  // 冲刷 L0 串行链(排队消息先落盘)→ 关库。cordis disposer 为 LIFO 逐个 await,
  // 本 effect 晚注册故先执行;apply 中途失败时由上方早注册的 db.close 兜底(双关安全)。
  ctx.effect(() => () => {
    disposed = true;
    // 图谱预热延迟 timer:不留孤儿回调(到期后会去碰已关的 db/no-op,脏)——与 extWakeTimer 同范式。
    if (graphWarmupTimer !== null) clearTimeout(graphWarmupTimer);
    runner.stop();
    embedManager?.dispose();
    downloader.dispose();
    // 后台记忆后端:worker 实现要 terminate 线程,否则宿主关不掉(process 挂住)。
    // 必须在 db.close() **之前**——worker 还持有自己的连接。
    void stores.backend?.dispose();
    // 外部驱动:关 fetch/终止子进程(registry.disposeAll);不关 db,与主链拆除互不依赖。
    void extAssembly.dispose();
    // 推送泵重臂定时器:不留孤儿回调(到期后会去碰已关的 ext 账本,no-op 但脏)。
    if (extWakeTimer !== null) clearTimeout(extWakeTimer);
    return (async () => {
      await flushL0?.();
      db.close();
      db.graphStore.close();
      resetTokenCost();
    })();
  });
}
