/**
 * 认知 hall(MemPalace 五层里的 Hall 层):按记忆的**认知类型**分类——
 * facts / events / discoveries / preferences / advice。
 *
 * 与 Wing(生活域,metadata.hall,磁盘兼容键)正交:Wing 编码"属于哪个领域",
 * 认知 hall 编码"记住的是什么样的东西"。来源是**静态映射**(零 schema 变更、
 * 零 LLM 成本):L1 的 type 轴已经编码了认知类型,映射即可派生,不需要模型再判一次。
 *
 * 反刍的重标定阶段(pipeline/relabel.ts)据此做机械校验:可派生而未写/不一致 → 补写修正。
 */
export declare const COGNITIVE_HALLS: readonly ["facts", "events", "discoveries", "preferences", "advice"];
export type CognitiveHall = (typeof COGNITIVE_HALLS)[number];
/** 派生记录的认知 hall;type 不可判定(未收录)返回 undefined —— 不猜。 */
export declare function cognitiveHallOf(type: unknown): CognitiveHall | undefined;
/** 严格校验:只认五个枚举值。 */
export declare function isCognitiveHall(v: unknown): v is CognitiveHall;
/** 认知 hall 的 metadata 键名(新增键,不与磁盘兼容键 `hall` 冲突)。 */
export declare const COG_HALL_METADATA_KEY = "cogHall";
