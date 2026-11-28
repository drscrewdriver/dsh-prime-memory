/**
 * L0 捕获清洗的人格区块剥离（persona-leak-guardrails C1）。
 *
 * 为什么放在 L0 而不只放 L1 输出侧：人格区自 v0.13.7 起进系统提示，v0.13.6 及以前
 * 可能经粘贴/转发混进用户消息——那时它已经是 L0 原文，L1 再拦就已经晚了一站。
 *
 * 只剥**连续的方括号人设行块**（`[角色]` 起头那几行），不碰正文里的普通方括号
 * （markdown 链接文本、`[TODO]` 之类的标签必须原样保留）。
 */
import { sanitizeText } from '../util/sanitize.js';
/** 人设块：以 `[角色]` 起头，后接同族方括号行（允许 `[昵称] 主人这样叫我：…` 形态）。 */
const PERSONA_BLOCK_RE = /^[ \t]*\[(?:角色|自称|昵称|语气|看重|不会做|主人的背景\(同步\))\][^\n]*(?:\n|$)(?:^[ \t]*\[(?:自称|昵称|语气|看重|不会做|主人的背景\(同步\))\][^\n]*(?:\n|$))*/gmu;
/** 剥离人格区块（纯函数，可单测）。 */
export function stripPersonaBlocks(text) {
    return text.replace(PERSONA_BLOCK_RE, '');
}
/** 在既有 sanitizeText 之上补一层人格块剥离（幂等：先剥块再走原链）。 */
export function sanitizeTextWithPersona(text) {
    return sanitizeText(stripPersonaBlocks(text));
}
