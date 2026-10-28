/**
 * 技能结晶的生产者（issue #15 的缺失环节）。
 *
 * **为什么需要这个文件**：`crystallize.detectCandidates` 自 0.26.x 起就存在，但全仓
 * 只有测试调用它，`SkillStore.create()` 同样零生产调用点 ⇒ `skills.json` 永远不会被
 * 写入，看板恒为 0。本文件补的就是生产者。
 *
 * **两条路径，一套语义**：
 * - `ingestRound`（稳态）：挂 `runner.runTurn` 的 L2 攒批轮次之后，吃本轮新记录 +
 *   本轮 sessionId。0 全表扫描、0 IO 读、0 LLM。
 * - `backfill`（一次性）：分页扫历史记录，从 `metadata.dsh_source_anchors` 复原会话
 *   归属，让装了很久的老库不必再跨 N 个会话才见第一条技能。
 * 两者共用 `crystallize` 的 `groupKey`/`fnv1a`，保证同一组在两条路径算出**同一个**
 * 候选 id（否则会出现两个重复候选，幂等崩）。
 *
 * **三条不可让步的纪律**：
 * 1. 必须投 `evidence`——`SkillStore.sessionCount` 只数 evidence 行、不看
 *    `Skill.evidenceRecordIds`；只 create 不 appendEvidence 的话，技能永远停在
 *    candidate 且 distinct-session 恒 0，**即使 allowPromote 打开也永不晋升**。
 * 2. 只覆盖 `steps`，绝不传 `body`——`body` 是人编辑区（`skill-store.ts` 头部分列
 *    不变量），机器侧只能重写 checklist 步骤。
 * 3. 不调 `getAllL1()`/`l1.all()`——那两个方法一次性全量同步反序列化含正文，
 *    在事件循环里会阻塞所有 RPC（`sqlite.ts` 里 `getAllL1Lite` 的存在理由注释已写明）。
 *
 * **候选首见即建，但不注入**：`appendEvidence` 要求技能已存在，所以无法"攒够阈再建"；
 * 而 `status:'candidate'` 本身不进召回（`skill-recall` 只注入 active），因此早期建
 * 候选没有注意力税。"是否达阈"由面板按 sessionCount/minSessions 如实显示。
 */
import type { MemoryConfig } from '../config.js';
import type { L1Store } from '../store/l1.js';
import type { SkillStore } from '../store/skill-store.js';
import type { MemoryLogger, MemoryRecord } from '../types.js';
type SkillsConfig = MemoryConfig['skills'];
/** 一次投递的账目。`errors` 只收要人看的失败原因，不抛穿调用方。 */
export interface SkillIngestSummary {
    /** 入参记录总数（含被过滤掉的其它类型）。 */
    scanned: number;
    /** 其中 work_method 且正文非空的条数。 */
    methods: number;
    /** 本轮触及的候选数。 */
    candidatesTouched: number;
    created: number;
    /** 新投的证据条数（去重后）。 */
    appended: number;
    promoted: number;
    /** backfill 专用：因缺锚点而跳过的记录数（增量路径恒 0）。 */
    skippedNoAnchor: number;
    /** 是否因技能数达上限而提前停止。 */
    stoppedAtCap: boolean;
    errors: string[];
}
export interface SkillBackfillSummary extends SkillIngestSummary {
    /** 实际翻页次数（可观测：判断大库回灌成本）。 */
    pages: number;
    /** 是否因扫描上限被截断。 */
    truncated: boolean;
}
/** 生产者健康态：面板三态判定与 `skills-list` 透出的数据源。 */
export interface SkillProducerStatus {
    /** 本版起恒为 true；保留该字段是为了让面板能区分"有生产者"与旧版空盒子。 */
    wired: true;
    lastRoundAt?: string;
    backfilledAt?: string;
}
export interface SkillProducer {
    /** 稳态入口：本轮新记录 + 本轮 sessionId。 */
    ingestRound(records: readonly MemoryRecord[], sessionId: string, runId: string): Promise<SkillIngestSummary>;
    /** 一次性历史回灌（面板「立即检测历史」按钮与 `skills-detect` RPC 的落点）。 */
    backfill(opts?: {
        maxRecords?: number;
        page?: number;
    }): Promise<SkillBackfillSummary>;
    status(): SkillProducerStatus;
}
export interface SkillProducerDeps {
    skills: SkillStore;
    l1: L1Store;
    /** 函数式取配置：面板改阈值后下一轮即生效，不必重启。 */
    cfg: () => SkillsConfig;
    logger?: MemoryLogger;
}
/**
 * 建一个技能生产者。
 *
 * 所有失败都在内部消化成 `summary.errors` + warn 日志，**不抛穿调用方**——
 * 蒸馏轮次不该因为技能结晶失败而丢记忆。
 */
export declare function createSkillProducer(deps: SkillProducerDeps): SkillProducer;
export {};
