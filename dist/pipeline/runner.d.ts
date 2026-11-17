/**
 * 管线 Runner:串行执行 L0 → L1 → L2 → L3。
 * 所有阶段失败只记日志,绝不向 Agent 循环抛错(失败兜底)。
 *
 * 会话档位:enqueue 带 mode(off 在捕获侧已被拦截);L1 待重试缓冲按档分桶;
 * L2/L3 按记录族各自跑各自的场景/画像存储与阈值计数(分族隔离不变量)。
 *
 * 调度:内部是带优先级的任务列表——正常对话轮次(live)优先于重建分块(rebuild),
 * 重建期间用户照常聊天,新轮次的蒸馏最多等一个重建块。任务串行,同一时刻至多一个在跑。
 *
 * 未蒸馏缓冲:pending 三桶持久化在 pending.json,进程重启不丢;init 恢复后延迟补跑一次
 * (受 live 开关与 minMessages 阈值约束,失败维持"等下一轮同档对话"的现状语义)。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type MemoryConfig } from '../config.js';
import type { LiveSettingsHandle } from '../settings.js';
import type { DrscClient } from '../clients/drsc.js';
import type { GraphStore } from '../store/graph-store.js';
import type { GraphSweepReport } from '../graph/sweep.js';
import { graphFeatureOn } from '../graph/gate.js';
import type { L1Store } from '../store/l1.js';
import type { PersonaStore } from '../store/persona.js';
import type { SceneStore } from '../store/scenes.js';
import type { StateStore } from '../store/state.js';
import type { ConversationMessage, ExtractMode, MemoryFamily, MemoryLogger } from '../types.js';
import type { FamilyStates } from './l1.js';
import type { RouteHealthStore } from '../store/route-health.js';
import type { SkillProducer } from '../skills/producer.js';
export interface MemoryStores {
    /**
     * DRSC 客户端(T8.4 读切):蒸馏背景窗的历史供给面(op=session&tail&redact=1)。
     * 缺席(测试缝/未装配)时背景窗为空数组;拉取失败空窗降级,不抛穿管线。
     */
    drsc?: DrscClient;
    l1: L1Store;
    scenes: Record<MemoryFamily, SceneStore>;
    persona: Record<MemoryFamily, PersonaStore>;
    state: StateStore;
    /** 图谱存储(可选:测试缝/未装配时图谱泵整体停用;GraphStore 自带降级 no-op)。 */
    graph?: GraphStore;
    /**
     * 派生数据搬运面（P0-d）：merge 后把使用史与人工标注搬到新 id。
     * 只声明用到的那个方法（不拉整个类入参）——未装配时不搬，行为与改动前一致。
     */
    usage?: {
        rekey(oldId: string, newId: string): boolean;
    };
    feedback?: {
        rekey(oldId: string, newId: string): boolean;
    };
    /** R9 路由健康学习（可选）：未传则 runExtraction 不启用自适应块长学习。 */
    routeHealth?: RouteHealthStore;
    /**
     * 轨2 技能结晶的生产者（可选）：未装配时蒸馏轮次完全不做结晶，行为与改动前一致。
     *
     * 挂在 L2 之后而不是每轮开头：复用既有攒批节奏、不新增 timer，且失败只记日志
     * （技能结晶不该把蒸馏轮次带崩）。
     */
    skills?: SkillProducer;
}
/** 管线任务(优先级调度:live > graph > ext-sync > rebuild)。 */
export interface PipelineTask {
    kind: 'live' | 'rebuild' | 'graph' | 'ext-sync';
    run: () => Promise<unknown>;
    /** 任务跑完后的回调(携带 run 的产出)——供反刍统计真实产出记录数。 */
    onDone?: (result: unknown) => void;
}
/**
 * 选取下一个要执行的任务下标:最早的 live 优先,其次 graph(图谱投影单批短、
 * 让位用户轮次但优先于重建分块),再次 ext-sync(外部推送单批有界、同样让位
 * 重建分块之上的短任务),否则队首(重建分块)。
 */
export declare function pickNextTaskIndex(tasks: PipelineTask[]): number;
/**
 * 运行时调参视图:设置页运行时链(distillChain)与旧单路由/档位键、分层输出预算、
 * 蒸馏通道覆盖、远程嵌入覆盖可临时覆盖静态 config。浅拷贝只覆盖 llm/embedding
 * 相关键,其余键与原 cfg 共享只读引用;pipeline 全链继续收 cfg,无需感知。
 *
 * 优先级表(自上而下):
 * - 蒸馏模型:部署静态 pin(provider+model 双字段齐)> 运行时统一链 distillChain
 *   [0]> 旧单路由键(distillProvider+distillModel 成对)> agentDefaultModel;
 *   pinned 时链与旧键一并失效(部署锁定路由)。
 * - 思考档位:有 settings 服务时运行时值整体接管('' = 自动);链模式主路由档位走
 *   primaryEffort;非链模式旧键对静态回退条目盖章接管(存量兼容)。
 * - 输出预算/输入预算/通道覆盖/远程嵌入覆盖:非零/非空运行时值直接注入对应子树。
 */
export { graphFeatureOn };
export declare function effectiveCfg(cfg: MemoryConfig, live?: LiveSettingsHandle): MemoryConfig;
export declare class MemoryRunner {
    private readonly ctx;
    private readonly cfg;
    private readonly stores;
    private readonly logger;
    private readonly live;
    /** 会话档位只读句柄(闲置扫描跳过 off 档会话;挂起语义)。 */
    private readonly modes?;
    /** 外部图提示缝(计划 T3.6;缺席 = 外部图不参与投影,零行为差)。 */
    private readonly extGraphHints?;
    private tasks;
    private draining;
    /** 停止标志(dispose 序置位):不再取新任务;进行中任务自然收尾。 */
    private stopped;
    private pending;
    /** pending.json 的只读降级原因(undefined = 正常):非空时不再回写缓冲。 */
    private pendingDegraded;
    private pendingDegradedLogged;
    /** 各档位桶渐进阈值(1 起步翻倍至稳态毕业;随 pending.json 持久化)。 */
    private warmup;
    /** 每会话最后活动时间(闲置兜底判定用)。 */
    private lastActivity;
    /** 每会话累计产出 L1 条数与最近蒸馏时间(session-stats 数据源;LRU 上限防泄漏)。 */
    private sessionProduced;
    /** 抽取连续失败退避(瞬态,不持久化:重启后允许首试再退避)。 */
    private extractFailures;
    /** 图谱泵在队列中的占位标志(同一时刻至多一个 graph 任务;护栏四件套之一)。 */
    private graphPumpQueued;
    /** R7：已入队、尚未消费的 force-flush 键集（`session:mode`），同键不重复入队（治积压刷屏）。 */
    private flushQueued;
    private readonly pendingFile;
    /** 分族 checkpoint(init 后可用;重建收尾也从这里读活引用)。 */
    states: FamilyStates;
    private afterRun;
    constructor(ctx: Context, cfg: MemoryConfig, stores: MemoryStores, logger: MemoryLogger, live: LiveSettingsHandle, 
    /** 会话档位只读句柄(闲置扫描跳过 off 档会话;挂起语义)。 */
    modes?: {
        get(sessionId: string): string;
    } | undefined, 
    /** 外部图提示缝(计划 T3.6;缺席 = 外部图不参与投影,零行为差)。 */
    extGraphHints?: (() => Promise<string[]>) | undefined);
    init(): Promise<void>;
    /** 启动补跑:对每个非空桶的每个会话切片入队一次蒸馏尝试(受 live 开关与
     *  生效阈值约束;不足阈值的消息等用户继续或闲置兜底,失败不无限重试)。 */
    private scheduleStartupRetry;
    /** L1 抽取待重试的消息条数(状态面板用)。 */
    get pendingCount(): number;
    /**
     * 会话级蒸馏视图(session-stats 端点数据源;纯内存读,零 I/O)。
     * pendingSlice = 当前档位桶中该会话的攒批切片条数(threshold 为生效阈值,含 warmup 爬坡);
     * parkedSlices = 其余档位桶中的残留切片(换档遗留 / off 档挂起)。
     */
    sessionView(sessionId: string, mode: string): {
        pendingSlice: number;
        parkedSlices: number;
        threshold: number | null;
        producedRecords: number;
        lastDistillAt: number | null;
    };
    /** 会话产出记账(切片成功消费时调用;LRU 淘汰最久未蒸馏会话防 Map 无界增长)。 */
    private noteSessionDistill;
    /** 管线跑完一轮后的回调(用于召回缓存失效)。 */
    setAfterRun(fn: () => void): void;
    /** 一轮对话结束后入队(L0 落盘由 capture 在 turn/end 即时完成,不排蒸馏队列)。
     *  onTurnDone 在该任务真正跑完后回调,携带本轮新增记录数(供反刍统计真实产出)。 */
    enqueue(sessionId: string, messages: ConversationMessage[], mode: ExtractMode, opts?: {
        force?: boolean;
        bypassBackoff?: boolean;
        onTurnDone?: (records: number) => void;
    }): void;
    /** 重建任务入队(低优先级:让位于正常轮次;由 RebuildController 分块驱动)。 */
    enqueueRebuildTask(run: () => Promise<unknown>): void;
    /** 外部同步泵入队(计划 Phase 2;优先级在 graph 后 rebuild 前,单飞由调用方的占位标志保证)。 */
    enqueueExtSyncTask(run: () => Promise<unknown>): void;
    /** 重建蒸馏轮:统一 auto 档,全量强制蒸馏(不受阈值约束)、不受缓冲 200 上限。 */
    runRebuildTurn(sessionId: string, messages: ConversationMessage[]): Promise<number>;
    /** 停止取新任务(插件 dispose 序调用;进行中任务照常跑完但不 await)。 */
    stop(): void;
    /** 启动闲置兜底定时器(index.ts 装配;idleSeconds=0 关闭)。 */
    startIdleTimer(): void;
    /** 闲置扫描:静默达标且有切片的会话按捕获档位落袋(off 档会话挂起跳过)。 */
    private flushIdleSlices;
    /** 把某会话在各桶中的切片按捕获档位逐个入队强制蒸馏(闲置兜底 / 档位切换共用)。 */
    private enqueueSessionSlices;
    /**
     * 档位切换同步(session-modes 的 set() 回调,ADR-0003):
     * 非 off 间切换 → 该会话切片立即按捕获档位蒸馏(新档位从空切片起步);
     * 切到 off → 挂起(切片留存,闲置扫描跳过);从 off 切回 → 挂起片按捕获档位落袋。
     */
    onModeChange(sessionId: string, oldMode: string, newMode: string): void;
    private pushTask;
    /**
     * 图谱泵任务入队(护栏四件套,见 maybeQueueGraphTask;成功投影后有积压则续排,
     * 每轮 drain 至多消费一个 graph 任务且永远让位 live)。
     */
    startGraphBackfillTimer(): void;
    /**
     * validity 标注存量回填的接线(task_6.3):低频、让位于蒸馏——启动 3 分钟后首轮,
     * 之后每 6h 一次(首轮收敛后多数轮是纯扫描 no-op;defer 的部分自动续上)。
     * 门控跟灰度闸走:tieringEnabled(部署 ∨ 面板)关时不进任务——功能关着时
     * 存量 metadata 逐字不变(零漂移,与 keyword-backfill 的门控同法)。
     */
    startValidityBackfillTimer(): void;
    private runValidityBackfillTick;
    /**
     * 确定性写面的公共入队钩子(graph-write-plane R2):非蒸馏写入路径
     * (`memory_add`/`memory_import`/`memory_update`)落库成功后把涉及记录投进
     * 投影队——与 distill 分支同源同优先级,闭合"只有蒸馏才投影"的旁路缺口
     * (用户手加记录长期 projected=None 的真根因)。部署未开图谱时 no-op,
     * 用户后续开启由启动/周期补投影兜底(与 distill 分支同一口径)。
     */
    enqueueGraphFor(recordIds: readonly string[]): void;
    /**
     * 强制重投的写面入口(graph-write-plane R3):把上游 R10 的内部
     * `forceReprojectRecord` 接到泵上——删凭证、高优入队、拉泵;幂等由
     * 在途 mapping 的 PK 去重保证。图谱未启用时直接回零(不开"投了永不泵"
     * 的陈旧队列口子,纠正通道的语义前提是图谱通路存在)。
     */
    reprojectGraph(recordIds: readonly string[]): {
        queued: number;
        jobIds: string[];
    };
    /**
     * 图谱级重建(v0.26.58 A 刀,spec §G「图谱可 drop 重造」的操作化):
     * 作废全部派生投影(六张图谱域表 + 两张向量表)→ 全量重新入队 → 拉泵。
     *
     * 为什么这条链路不含任何一次手写图数据:
     * - 清理只删派生行与凭证,L1 事实源一字不动;
     * - 入队复用既有 {@link GraphStore.queueMissing}——凭证清零后它的 NOT EXISTS
     *   判据天然命中全部存活记录,不需要另取 id 清单(口径与启动补投影完全同源);
     * - 落库仍逐 job 走 claim → LLM 提案 → applyGraphProjection 硬校验 → 写回,
     *   于是 v2 的入口闸门(path place / 裸角色 / 概念独立表 / key 归一)第一次真正
     *   作用在**全量**存量上。这是增量重投做不到的事(闸门只拦新提案,不回写旧行)。
     *
     * 幂等与代价:在途 job 随凭证一起作废;重投期间图谱逐条长回来(读侧可用,
     * 只是暂时不全)。全程零 LLM 在本方法内(泵内异步),不违反「LLM 不进事务」。
     *
     * @returns 清理前各表行数 + 新入队作业数;图谱未启用时全零并给出原因。
     */
    rebuildGraph(): {
        cleared: {
            nodes: number;
            edges: number;
            concepts: number;
            jobs: number;
            projected: number;
        };
        queued: number;
        notice?: string;
    };
    /**
     * 存量清扫(v0.26.58 B 刀):不花一次 LLM,用投影侧同一批纯判据反扫存量图,
     * 收敛裸角色/path place/脏别名/fact key。dryRun 默认开(先看规模再落库),
     * 落库走 GraphStore.sweepStock 的单事务缝 + 归档节点的向量清理。
     *
     * @param dryRun - true(缺省)= 只报告不改;false = 实际写回。
     */
    sweepGraph(dryRun?: boolean): GraphSweepReport;
    /**
     * 图谱投影泵入队判定:
     * - 双门:`graphFeatureOn`（部署 cfg.graph.enabled **或** 面板 live.graphEnabled）
     *   + 运行时 live.enabled/distill,任一为假不入队;
     * - 占位:同一时刻至多一个 graph 任务在队列(靠 graphPumpQueued 标志),永不与
     *   live 抢位(pickNextTaskIndex 保证 live > graph);
     * - 退避/attempts 封顶:由 GraphStore.claimNext 的 WHERE 过滤与 fail 转 dead 承接,
     *   退避窗口内的 claim 是廉价空转,不在此重复实现。
     */
    private maybeQueueGraphTask;
    private drain;
    /** 该会话是否处于抽取退避窗口内。 */
    private inExtractBackoff;
    /** 缓冲落盘(每次蒸馏尝试后调用;失败只告警不阻断管线)。
     *  非重建轮持久化前按桶截断到上限:重建取消后的大桶不至于在后续每次
     *  蒸馏尝试时反复整量序列化落盘(多 MB 级 IO);重建轮豁免维持。 */
    private persistPending;
    private runTurn;
    /**
     * 蒸馏背景窗(T8.4 读切,task_19):DRSC 会话尾窗(redact 臂)→ ConversationMessage。
     * - 形状映射:segment 行 → 消息(drscRowToConversationMessage;非 user/assistant 段跳过);
     * - 坐标剔除:切片自身轮次整轮剔除(尾窗在 DRS 30s interval 同步后会含刚捕获
     *   的 turn——旧 l0 读面按消息 id 剔除,跨系统 id 不同构,按坐标等价替身);
     * - 报错口径:collector 缺席/超时 → warn 后空窗降级,**不抛穿蒸馏管线**
     *   (工具面 conversation_search 的显式报错口径在 tools 层分清,spec R7)。
     */
    private drscBackground;
    /**
     * 抽取并消费一个会话切片:成功才把切片移出桶并推进爬坡阈值;失败保留切片待重试。
     * 调用方已保证切片达到生效阈值(或 force)。背景参考按会话从 DRSC 尾窗现查并
     * 剔除切片自身轮次(ADR-0003:会话间互不污染、重启不丢背景)。
     */
    private extractSessionSlice;
}
