/**
 * Wing 严格校验:只认 8 域 + general 兜底。
 *
 * 注意与认知 hall 的**值域不相交**:`isWingId('facts')` 必须为 false —— 认知 hall 的值
 * 若被误当 Wing 写入 `metadata.hall`,会污染生活域轴。
 *
 * 刻意声明为 `boolean` 而非类型守卫 `v is WingValue`:词表的事实源是**运行期**的
 * `WING_ID_SET`,而 `WingId` 类型因 `WING_CATALOG` 标注为 `WingDef[]`(`id: string`)
 * 实际退化为 `string` ——守卫会变成 `v is string`,使 `!isWingId(x)` 的否定分支把
 * 已是 string 的变量收窄成 `never`(该分支内无法再 `.slice`,已在 wing-backfill 踩过)。
 */
export declare function isWingId(v: unknown): boolean;
/** 同为布尔谓词(理由见 isWingId 注释)。 */
export declare function isTag(v: unknown): boolean;
/**
 * 标签归一 + 校验 + 去重 + 上限。**所有 tags 写回点都必须过这里**——
 * 无论标签来自真实 LLM 还是注入桩,归一化都不能只靠调用方自觉。
 */
export declare function normTags(v: unknown, max?: number): string[];
export { isCognitiveHall, COGNITIVE_HALLS, type CognitiveHall } from './cognitive-hall.js';
