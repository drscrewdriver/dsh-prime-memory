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

export const COGNITIVE_HALLS = ['facts', 'events', 'discoveries', 'preferences', 'advice'] as const;

export type CognitiveHall = (typeof COGNITIVE_HALLS)[number];

const COG_SET = new Set<string>(COGNITIVE_HALLS);

/**
 * type → 认知 hall 映射(单一事实源)。
 *
 * - facts:已确定的事实/决策/产物 —— work_fact / work_artifact / persona(画像事实)
 * - events:事件/会议/里程碑 —— episodic / work_task(进行中的事)
 * - discoveries:方法/洞见/突破 —— work_method
 * - preferences:偏好/习惯/指令约定 —— instruction
 * - advice:建议/推荐/解决方案 —— 暂无独立 type 来源(保留枚举位,LLM 抽取侧
 *   未来若细分 advice 类 type 再接入;不做模糊映射,宁缺勿错)。
 */
const COG_MAP: Readonly<Record<string, CognitiveHall>> = {
  work_fact: 'facts',
  work_artifact: 'facts',
  persona: 'facts',
  episodic: 'events',
  work_task: 'events',
  work_method: 'discoveries',
  instruction: 'preferences',
};

/** 派生记录的认知 hall;type 不可判定(未收录)返回 undefined —— 不猜。 */
export function cognitiveHallOf(type: unknown): CognitiveHall | undefined {
  if (typeof type !== 'string') return undefined;
  return COG_MAP[type];
}

/** 严格校验:只认五个枚举值。 */
export function isCognitiveHall(v: unknown): v is CognitiveHall {
  return typeof v === 'string' && COG_SET.has(v);
}

/** 认知 hall 的 metadata 键名(新增键,不与磁盘兼容键 `hall` 冲突)。 */
export const COG_HALL_METADATA_KEY = 'cogHall';
