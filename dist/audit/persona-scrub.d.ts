/**
 * 去人格化（蒸馏输出侧拦截）。
 *
 * 裁决①：**去掉人格特征再记录即可**，不是整条丢弃——「本鱼已核实 X」里的事实部分
 * 仍然有效，丢掉它等于用"内容完整"换"没有污染"，那笔账不划算。
 *
 * 纪律：纯确定性字符串处理。不改写润色、不调模型、不换语序——只做四件事：
 *  1. 删行首方括号人设行（整行）
 *  2. 自称词 → 空串（句子其余保留）
 *  3. 角色名 → 空串
 *  4. 称呼位昵称词 → 删该片段
 * 摘完折叠 `，。` 连排与多余空格；剩空（或只剩标点）才丢。
 */
import type { PersonaLeakTerms } from './persona-terms.js';
/** 中性主语替换表：空串 = 直接删（这些词本身不承载事实）。 */
export declare const PERSONA_NEUTRAL_MAP: Record<string, string>;
/** 文本是否"实质为空"（只剩空白/标点）。 */
export declare function isEffectivelyEmpty(text: string): boolean;
/**
 * 摘掉人格特征，保留有效内容。
 *
 * @param text 蒸馏产物正文
 * @param terms 词表（读不到时传空词表 = 只剥人设行）
 * @returns 净化后的文本；**实质为空**时返回 `''`（调用方据此丢弃整条）
 */
export declare function scrubPersonaArtifacts(text: string, terms: PersonaLeakTerms): string;
