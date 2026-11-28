/**
 * L0 捕获清洗的人格区块剥离（persona-leak-guardrails C1）。
 *
 * 为什么放在 L0 而不只放 L1 输出侧：人格区自 v0.13.7 起进系统提示，v0.13.6 及以前
 * 可能经粘贴/转发混进用户消息——那时它已经是 L0 原文，L1 再拦就已经晚了一站。
 *
 * 只剥**连续的方括号人设行块**（`[角色]` 起头那几行），不碰正文里的普通方括号
 * （markdown 链接文本、`[TODO]` 之类的标签必须原样保留）。
 */
/** 剥离人格区块（纯函数，可单测）。 */
export declare function stripPersonaBlocks(text: string): string;
/** 在既有 sanitizeText 之上补一层人格块剥离（幂等：先剥块再走原链）。 */
export declare function sanitizeTextWithPersona(text: string): string;
