import type { MemoryFamily, MemoryLogger } from '../types.js';
export declare const SKILL_STORE_FILE_VERSION: 1;
export type SkillStatus = 'candidate' | 'active' | 'archived';
export type InjectionTier = 'full' | 'excerpt' | 'hint';
export interface SkillTrigger {
    /** 归属 wing/hall（粗分类）；缺省 = 不参与按域过滤。 */
    hall?: string;
    sceneName?: string;
    keywords: string[];
    workspaceId?: string;
}
export interface Skill {
    id: string;
    title: string;
    /** 人可编辑正文；进 preserve 白名单，重建不覆盖。 */
    body: string;
    /** 机器聚合的 checklist 步骤；重建投影可覆盖。 */
    steps: string[];
    trigger: SkillTrigger;
    injectionTier: InjectionTier;
    status: SkillStatus;
    pinned: boolean;
    confidence: number;
    family: MemoryFamily;
    scope: 'global' | 'workspace';
    /** 支撑该技能的证据记录 id（指向 l1_records.record_id，仅作溯源，不强约束外键）。 */
    evidenceRecordIds: string[];
    createdAt: string;
    updatedAt: string;
    lastUsedAt: string;
    archivedReason?: string;
}
export interface SkillEvidence {
    skillId: string;
    runId: string;
    recordId: string;
    sessionId: string;
    at: string;
    kind: string;
}
export interface NewSkillInput {
    id?: string;
    title: string;
    body?: string;
    steps?: string[];
    trigger?: Partial<SkillTrigger>;
    injectionTier?: InjectionTier;
    status?: SkillStatus;
    family?: MemoryFamily;
    scope?: 'global' | 'workspace';
    evidenceRecordIds?: string[];
}
export declare class SkillStore {
    private readonly logger?;
    private readonly file;
    private skills;
    private evidence;
    private rev;
    private loaded;
    private fileAbsentAtBoot;
    private degraded;
    private degradedLogged;
    private writeChain;
    private seq;
    constructor(dataDir: string, logger?: MemoryLogger | undefined);
    init(): Promise<void>;
    private ensureLoaded;
    list(): Skill[];
    /** active 技能（注入候选）。 */
    listActive(): Skill[];
    get(id: string): Skill | undefined;
    private newId;
    /** 新建技能（幂等：显式传 id 且已存在 → 走 updateBody 语义由调用方决定，这里仅拒绝重复 id）。 */
    create(input: NewSkillInput): Promise<Skill>;
    /** 编辑人可读正文（body/title/steps/injectionTier/pinned）；只动提供的字段。 */
    update(id: string, patch: Partial<Pick<Skill, 'title' | 'body' | 'steps' | 'injectionTier' | 'pinned'>>): Promise<boolean>;
    /** 追加一条证据（只追加）；返回该技能当前的 distinct-session 数。 */
    appendEvidence(ev: SkillEvidence): Promise<number>;
    /**
     * 启动时 `skills.json` 是否不存在（缺文件是合法空表，但供诚实化诊断用）。
     * 取的是 **boot 快照**，不随本轮写入变化——开关开了但文件一直没生出来，
     * 就是"无生产者"的历史现场，启动日志据此提 warning。
     */
    wasAbsentAtBoot(): boolean;
    /**
     * 该技能是否已收录过这条证据三元组 (skill, session, record)。
     *
     * 存在的必要：`appendEvidence` 是**纯追加**，而 `evidence` 数组触顶
     * （`EVIDENCE_CAP`）时会 `splice` 掉最老的行。backfill 与增量轮次对同一证据
     * 重复投，会把真实历史挤出去——所以投前必过这道门（producer 两条路径同源）。
     *
     * 为何是三元组而不是 (skill, record)：backfill 下一条历史记录可经
     * `metadata.dsh_source_anchors` 映射到**多个**会话，按二元组去重会抹掉
     * 第 2、3 个会话，而 distinct-session 正是晋升判据。
     */
    hasEvidence(skillId: string, sessionId: string, recordId: string): boolean;
    /** 某技能的证据总条数（`minEvidence` 的度量；与 `sessionCount` 的 distinct 语义不同）。 */
    evidenceCount(skillId: string): number;
    /** 某技能的 distinct session 计数（晋升判据的唯一来源，与 LLM 判断解耦）。 */
    sessionCount(skillId: string): number;
    /**
     * 批量追加证据：**整批一次持久化**，返回实际入库条数。
     *
     * 为何需要：`appendEvidence` 每条都 `await persist()`，而 persist 是全文件重写。
     * 真机量测（1197 条 L1 / 380 条 work_method）下首轮回灌要投 379 条证据，
     * 逐条写 = 379 次全量落盘（对已长到几百 KB 的 sidecar 是百 MB 级写放大）。
     * 生产者改走本入口；逐条版保留给单次工具调用。
     */
    appendEvidenceBatch(rows: readonly SkillEvidence[]): Promise<number>;
    /**
     * 晋升：candidate→active，仅当功能开且该技能 distinct-session ≥ minSessions。
     * 返回是否发生晋升。不批量、不依赖 LLM（可解释性结构保证，同 conflictFreeze"不自动裁决"哲学）。
     */
    tryPromote(skillId: string, minSessions: number, opts: {
        allowPromote: boolean;
    }): Promise<boolean>;
    /** 记一次使用（刷新 lastUsedAt，供闲置归档与"只用才强化"）。 */
    touchUsed(skillId: string, at: string): Promise<boolean>;
    /** 归档（active/candidate→archived）；记录原因。走本表独立生命周期，不触碰 l1_records 退场。 */
    archive(skillId: string, reason: string): Promise<boolean>;
    /**
     * 闲置归档：active 且未 pinned 且（now - lastUsedAt）> idleDays 的技能自动归档。
     * 机械比较、0 LLM、不引入 timer（对齐 slots.expireDue 范式）。返回归档条数。
     */
    archiveDue(now: number, idleDays: number): Promise<number>;
    private patchOne;
    /** 写穿持久化（串行链；失败降级内存态并告警一次，绝不抛出阻塞调用方）。 */
    private persist;
}
