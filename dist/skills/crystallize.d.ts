/**
 * 技能结晶检测（轨2，纯规则 0 token 0 IO）。
 *
 * 从 `work_method` 记忆**派生技能候选**——技能不是 memory `type`（不碰 ADD_TYPES/prompt 词表，
 * S1/S2/S3 不触发），而是对"跨会话重复出现的工作方法"的聚合投影（对齐 ADR-0007 可重建投影）。
 *
 * 本轮定位：**只提供确定性检测函数**，不自动挂进 runner 每轮热路径
 * （接入 runner 会给每轮蒸馏加活儿，且需与攒批/层链协调）。
 * 生产者在 `producer.ts`：稳态挂 L2 攒批轮次（`ingestRound`）+ 一次性历史回灌
 * （`backfill`），两者共用本文件的 `groupKey`/`fnv1a` 以保证候选 id 同源。
 * 检测是纯规则：按 (hall, scene) 分组，够 distinct-session 且够条数才成候选；
 * 候选默认 `status:'candidate'`，晋升仍由 SkillStore.tryPromote（且 cfg.skills.allowPromote
 * 默认关）单独把关——检测与晋升解耦，和 conflictFreeze"不自动裁决"同哲学。
 */
export interface MethodRecord {
    id: string;
    content: string;
    sessionId: string;
    hall?: string;
    sceneName?: string;
}
export interface CandidateProposal {
    /** 稳定派生 id：`skx-` + groupKey 哈希前缀，便于幂等（同组重复检测得同 id）。 */
    id: string;
    title: string;
    body: string;
    steps: string[];
    hall?: string;
    sceneName?: string;
    evidenceRecordIds: string[];
    sessions: string[];
}
export interface DetectOptions {
    minSessions: number;
    minEvidence: number;
    /** 每候选最多收录的步骤数（防单组爆炸）。 */
    maxSteps?: number;
}
/**
 * 分组键：hall + scene（缺省归 'general'）；决定"同一类工作流"的判定粒度。
 *
 * 导出给 `producer.ts` 复用：增量路径与 backfill 路径必须算出**同一个** key，
 * 否则同一组会结晶出两个不同 id 的候选，幂等直接崩。改这里等于改存量技能 id。
 */
export declare function groupKey(r: MethodRecord): string;
/**
 * 稳定短哈希（FNV-1a 32bit，零依赖、确定性），用于派生候选 id。
 *
 * 同 `groupKey`：单点导出供 producer 共用，禁止另写一份。
 */
export declare function fnv1a(s: string): string;
/**
 * 检测候选：按 groupKey 聚合 work_method 记录，distinct-session ≥ minSessions 且
 * 去重后内容条数 ≥ minEvidence 的组，产出一条 candidate 提案（按 groupKey 排序，确定性）。
 */
export declare function detectCandidates(records: MethodRecord[], opts: DetectOptions): CandidateProposal[];
