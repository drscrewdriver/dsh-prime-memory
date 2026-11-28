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
export const PERSONA_NEUTRAL_MAP: Record<string, string> = {
  本鱼: '',
  我这条鱼: '',
  俏皮同伴: '',
  大肥鱼: '',
  鱼鱼: '',
};

/** 人设行（整行删除）：行首方括号标签 + 行内全部内容。 */
const PERSONA_LINE_RE = /^[ \t]*\[(?:角色|自称|昵称|语气|看重|不会做|主人的背景\(同步\))\][^\n]*\n?/gmu;

/** 中文连排标点折叠：「，。」「，，」只留第一个。 */
function collapsePunctuation(text: string): string {
  return text
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/，\s*[，。；、]/gu, '，')
    .replace(/。\s*[，。；、]/gu, '。')
    .replace(/[，、]{2,}/gu, '，')
    .replace(/。{2,}/gu, '。')
    .replace(/^[\s，。、；：,.;:]+/u, '')
    .replace(/\n{3,}/gu, '\n\n');
}

/** 文本是否"实质为空"（只剩空白/标点）。 */
export function isEffectivelyEmpty(text: string): boolean {
  return text.replace(/[\s，。、；：,.!?！？;:~～\-—_]/gu, '') === '';
}

/** 正则元字符转义（昵称词进 RegExp 前的唯一一处）。 */
function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^$()|[\]{}\\]/gu, '\\$&');
}

/**
 * 摘掉人格特征，保留有效内容。
 *
 * @param text 蒸馏产物正文
 * @param terms 词表（读不到时传空词表 = 只剥人设行）
 * @returns 净化后的文本；**实质为空**时返回 `''`（调用方据此丢弃整条）
 */
export function scrubPersonaArtifacts(text: string, terms: PersonaLeakTerms): string {
  let out = text.replace(PERSONA_LINE_RE, '');
  // ① 自称词与角色名：直接删词（中性表里登记为空串的 + 词表里现读到的）
  const dropWords = new Set<string>([
    ...Object.keys(PERSONA_NEUTRAL_MAP).filter((w) => (PERSONA_NEUTRAL_MAP[w] ?? '') === ''),
    ...terms.selfNames,
    ...(terms.cardName === '' ? [] : [terms.cardName]),
  ]);
  for (const word of dropWords) {
    if (word === '') continue;
    out = out.split(word).join('');
  }
  // ② 称呼位昵称词：`宝，xxx` / `xxx，宝。` / `宝。` —— 只删称呼片段，句子其余保留
  for (const alias of terms.aliases) {
    if (alias === '') continue;
    const w = escapeRegExp(alias);
    out = out.replace(new RegExp('(^|[\\s，。！？、；：])' + w + '[，,][ \\t]*', 'gmu'), '$1');
    out = out.replace(new RegExp('[，,][ \\t]*' + w + '([。！？.!?]|$)', 'gmu'), '$1');
    out = out.replace(new RegExp('(^|[\\s，。！？、；：])' + w + '([。！？.!?]|$)', 'gmu'), '$1$2');
  }
  out = collapsePunctuation(out).trim();
  return isEffectivelyEmpty(out) ? '' : out;
}
