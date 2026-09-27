/**
 * §C 载荷脱敏(memorax-absorb Wave 2 / task_14)——捕获边界的密钥擦除。
 *
 * 用户在对话里贴入的密钥(PEM/Bearer/JWT/Cookie/厂商 API key/邮箱/长号/高熵 ID)
 * 若原样进 L0/L1,会被逐轮召回注入上下文并在 UI 展示。本模块在捕获单点把它们
 * 替换为类型化占位符 `[REDACTED:<KIND>]`——占位符保留类别语义,关键词检索仍可命中。
 *
 * 词表/正则/allowlist/span 合并算法以 memorax `payload-redaction.ts` 为基准逐条移植
 * (全文快照见计划 evidence/payload-redaction-snapshot.ts;findings.md 有等价内联)。
 *
 * 契约(sanitize 同款,tests/redact.test.ts 钉住):
 * - 纯函数,零 I/O 零时钟零随机;输入原样返回(未命中)= 引用不变无关紧要,字符串不可变;
 * - **幂等**:已是 `[REDACTED:KIND]` 的值不会被二次匹配;
 * - 安全值 allowlist 命中不脱(`example`/`change-me`/`$VAR`/`${{…}}` 等);
 * - 本函数**永不抛错**的保证由调用方 try/catch 兜底(capture 接线层,§C 红线:失败放行原文)。
 */
export type RedactionKind = 'PRIVATE_KEY' | 'AUTH_TOKEN' | 'COOKIE' | 'API_KEY' | 'CREDENTIAL' | 'EMAIL' | 'LONG_NUMBER' | 'OPAQUE_ID';
export interface RedactionResult {
    text: string;
    counts: Partial<Record<RedactionKind, number>>;
    redacted: boolean;
}
/**
 * 对文本执行 8 类脱敏。规则各自扫描 → 收集值级 span → 合并重叠 → 重拼插入占位符。
 * 同一位置被多条规则命中时取更长/更高优先级的 span。
 */
export declare function redactSecrets(text: string): RedactionResult;
