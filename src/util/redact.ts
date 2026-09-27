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

export type RedactionKind =
  | 'PRIVATE_KEY'
  | 'AUTH_TOKEN'
  | 'COOKIE'
  | 'API_KEY'
  | 'CREDENTIAL'
  | 'EMAIL'
  | 'LONG_NUMBER'
  | 'OPAQUE_ID';

export interface RedactionResult {
  text: string;
  counts: Partial<Record<RedactionKind, number>>;
  redacted: boolean;
}

interface RedactionSpan {
  start: number;
  end: number;
  kind: RedactionKind;
  priority: number;
}

interface RedactionRule {
  pattern: RegExp;
  kind: RedactionKind;
  priority: number;
  /** 取匹配的第几个分组作为敏感值(缺省 0 = 整个匹配)。 */
  group?: number;
  /** 值级放行判定(返回 false = 不脱)。 */
  accept?: (value: string) => boolean;
}

const PLACEHOLDER_VALUE_PATTERN = /^\[REDACTED:[A-Z_]+\]$/;
const SENSITIVE_KEY_SOURCE = String.raw`(?:[A-Za-z_$][A-Za-z0-9_$-]*)?(?:password|passwd|pwd|client[-_$]?secret|consumer[-_$]?secret|api[-_$]?key|access[-_$]?token|refresh[-_$]?token|auth[-_$]?token|id[-_$]?token|private[-_$]?key|secret[-_$]?access[-_$]?key|secret[-_$]?key|credential|secret|token)`;
const CREDENTIAL_VALUE_SOURCE = String.raw`(?:\[REDACTED:[A-Z_]+\]|\$\{\{[^\r\n]*?\}\}|\{\{[^\r\n]*?\}\}|\$\{[^}\r\n]+\}|\$[A-Za-z_][A-Za-z0-9_]*|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^,;#}\]\)\r\n]+)`;
/** 安全值 allowlist:命中即放行(示例/占位/环境变量引用/类型名等,脱了只会毁记忆)。 */
const SAFE_CREDENTIAL_VALUE_PATTERN =
  /^(?:\[REDACTED:[A-Z_]+\]|\$\{\{[^\r\n]*\}\}|\{\{[^\r\n]*\}\}|\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*|(?:process\.)?env\.[A-Z_][A-Z0-9_]*|<[^>]+>|--\S+|x{2,}|\*{2,}|\.{3}|sk[_-]x+|example|sample|change-?me|(?:your|replace)[-_][a-z0-9_-]+|string|str|number|boolean|unknown|any|null|undefined|none)$/i;

const RULES: readonly RedactionRule[] = [
  {
    // PEM 私钥块:至对应 END,截断文件时取到文末
    pattern: /-----BEGIN ((?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?(?:-----END \1-----|$)/gi,
    kind: 'PRIVATE_KEY',
    priority: 100,
  },
  {
    pattern: /(?:^|[\r\n])[ \t]*(?:Proxy-)?Authorization[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)/gim,
    group: 1,
    kind: 'AUTH_TOKEN',
    priority: 95,
  },
  {
    pattern: /(?:^|[^A-Za-z0-9_-])(?:Bearer|Basic)\s+["']?([A-Za-z0-9._~+/=-]{16,})(?![A-Za-z0-9._~+/=-])/gi,
    group: 1,
    kind: 'AUTH_TOKEN',
    priority: 94,
  },
  {
    // JWT 三段形态
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{16,}\b/g,
    kind: 'AUTH_TOKEN',
    priority: 94,
  },
  {
    pattern: /(?:^|[\r\n])[ \t]*(?:Set-Cookie|Cookie)\s*:\s*([^\r\n]+)/gim,
    group: 1,
    kind: 'COOKIE',
    priority: 92,
  },
  {
    // 声明式赋值:key: value / key = value(含 export/const/let/var 前缀与引号键)
    pattern: new RegExp(
      String.raw`(?:^|[\r\n;,{}])[ \t]*(?:-[ \t]+)?(?:(?:export|const|let|var)[ \t]+)*["']?${SENSITIVE_KEY_SOURCE}["']?[ \t]*[:=][ \t]*(${CREDENTIAL_VALUE_SOURCE})`,
      'gim',
    ),
    group: 1,
    kind: 'CREDENTIAL',
    priority: 85,
    accept: (value) => !isSafeCredentialValue(value),
  },
  {
    // CLI 形态:--api-key value / --api-key=value
    pattern: new RegExp(
      String.raw`--${SENSITIVE_KEY_SOURCE}(?![A-Za-z0-9_$-])(?:[ \t]+|=[ \t]*)(${CREDENTIAL_VALUE_SOURCE})`,
      'gi',
    ),
    group: 1,
    kind: 'CREDENTIAL',
    priority: 85,
    accept: (value) => !isSafeCredentialValue(value),
  },
  {
    // URL query 形态:?api_key=...
    pattern: new RegExp(
      String.raw`[?&]${SENSITIVE_KEY_SOURCE}(?![A-Za-z0-9_$-])=([^&#\s"'<>]+)`,
      'gi',
    ),
    group: 1,
    kind: 'CREDENTIAL',
    priority: 85,
    accept: (value) => !isSafeCredentialValue(value),
  },
  {
    // URL userinfo 形态:scheme://user:pass@
    pattern: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]*:([^\s/@]+)@/g,
    group: 1,
    kind: 'CREDENTIAL',
    priority: 85,
    accept: (value) => !isSafeCredentialValue(value),
  },
  // ── 已知厂商 API key 形态(9 条) ──
  { pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}[A-Za-z0-9]\b/g, kind: 'API_KEY', priority: 80 },
  { pattern: /\bsk_[A-Za-z0-9_-]{8,}\b/g, kind: 'API_KEY', priority: 80 },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, kind: 'API_KEY', priority: 80 },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, kind: 'API_KEY', priority: 80 },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}[A-Za-z0-9]\b/g, kind: 'API_KEY', priority: 80 },
  { pattern: /\b(?:(?:sk|rk)_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,})\b/g, kind: 'API_KEY', priority: 80 },
  { pattern: /\bglpat-[A-Za-z0-9_-]{16,}[A-Za-z0-9]\b/g, kind: 'API_KEY', priority: 80 },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, kind: 'API_KEY', priority: 80 },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, kind: 'API_KEY', priority: 80 },
  {
    // 邮箱(前后向断言防误切)
    pattern: /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]{1,64}@[A-Z0-9](?:[A-Z0-9.-]{0,251}[A-Z0-9])?\.[A-Z]{2,63}(?![A-Z0-9-]|\.[A-Z0-9])/gi,
    kind: 'EMAIL',
    priority: 70,
  },
  {
    // UUID
    pattern: /(?<![A-Za-z0-9])[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}(?![A-Za-z0-9])/g,
    kind: 'OPAQUE_ID',
    priority: 60,
  },
  {
    // hex 64/40/32(含字母才脱——纯数字是普通长号,交 LONG_NUMBER)
    pattern: /(?<![A-Za-z0-9])(?:[0-9A-Fa-f]{64}|[0-9A-Fa-f]{40}|[0-9A-Fa-f]{32})(?![A-Za-z0-9])/g,
    kind: 'OPAQUE_ID',
    priority: 60,
    accept: (value) => /[A-Fa-f]/.test(value),
  },
  {
    // ≥24 位字母数字高熵启发式(熵参数见 looksLikeHighEntropyOpaqueId)
    pattern: /(?<![A-Za-z0-9])[A-Za-z0-9]{24,}(?![A-Za-z0-9])/g,
    kind: 'OPAQUE_ID',
    priority: 60,
    accept: looksLikeHighEntropyOpaqueId,
  },
  {
    // ≥9 位数字串(含电话形);日期形放行
    pattern: /(?<![A-Za-z0-9.])\+?(?:\d|\(\d)[\d ()-]*\d[Xx]?\)?(?![A-Za-z0-9]|\.\d)/g,
    kind: 'LONG_NUMBER',
    priority: 50,
    accept: (value) => {
      if (value.replace(/\D/g, '').length < 9) return false;
      const normalized = value.trim().replace(/[()]/g, '');
      return (
        !/^(?:19|20)\d{2}-\d{1,2}-\d{1,2}(?:[ T-]\d{1,2})?$/.test(normalized) &&
        !/^(?:19|20)\d{2}\s+\d{1,2}\s+\d{1,2}(?:\s+\d{1,2})?$/.test(normalized)
      );
    },
  },
];

/**
 * 对文本执行 8 类脱敏。规则各自扫描 → 收集值级 span → 合并重叠 → 重拼插入占位符。
 * 同一位置被多条规则命中时取更长/更高优先级的 span。
 */
export function redactSecrets(text: string): RedactionResult {
  if (!text) return { text, counts: {}, redacted: false };
  const spans: RedactionSpan[] = [];
  for (const rule of RULES) collectRuleSpans(text, rule, spans);
  const selected = mergeOverlappingSpans(spans);
  if (selected.length === 0) return { text, counts: {}, redacted: false };
  const counts: Partial<Record<RedactionKind, number>> = {};
  const output: string[] = [];
  let offset = 0;
  for (const span of selected) {
    output.push(text.slice(offset, span.start), `[REDACTED:${span.kind}]`);
    counts[span.kind] = (counts[span.kind] ?? 0) + 1;
    offset = span.end;
  }
  output.push(text.slice(offset));
  return { text: output.join(''), counts, redacted: true };
}

function collectRuleSpans(text: string, rule: RedactionRule, spans: RedactionSpan[]): void {
  rule.pattern.lastIndex = 0;
  for (const match of text.matchAll(rule.pattern)) {
    const value = match[rule.group ?? 0];
    if (match.index === undefined || !value || PLACEHOLDER_VALUE_PATTERN.test(value.trim())) continue;
    if (rule.accept && !rule.accept(value)) continue;
    const relativeStart = match[0].lastIndexOf(value);
    if (relativeStart < 0) continue;
    spans.push({
      start: match.index + relativeStart,
      end: match.index + relativeStart + value.length,
      kind: rule.kind,
      priority: rule.priority,
    });
  }
}

function isSafeCredentialValue(rawValue: string): boolean {
  let value = rawValue.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  return !value || SAFE_CREDENTIAL_VALUE_PATTERN.test(value);
}

/** 高熵判定:小写≥2 ∧ 大写≥2 ∧ 数字≥2 ∧ 字符类切换≥4 ∧ 最长连续字母段≤5 ∧ 去重字符≥12。 */
function looksLikeHighEntropyOpaqueId(value: string): boolean {
  let lowercase = 0;
  let uppercase = 0;
  let digits = 0;
  let transitions = 0;
  let letterRun = 0;
  let longestLetterRun = 0;
  let previousWasDigit: boolean | undefined;
  const unique = new Set<string>();
  for (const character of value) {
    const isDigit = character >= '0' && character <= '9';
    if (isDigit) {
      digits += 1;
      letterRun = 0;
    } else {
      if (character >= 'a' && character <= 'z') lowercase += 1;
      else uppercase += 1;
      letterRun += 1;
      longestLetterRun = Math.max(longestLetterRun, letterRun);
    }
    if (previousWasDigit !== undefined && previousWasDigit !== isDigit) transitions += 1;
    previousWasDigit = isDigit;
    unique.add(character);
  }
  return lowercase >= 2 && uppercase >= 2 && digits >= 2 && transitions >= 4 && longestLetterRun <= 5 && unique.size >= 12;
}

function mergeOverlappingSpans(spans: RedactionSpan[]): RedactionSpan[] {
  const sorted = [...spans].sort(
    (left, right) => left.start - right.start || right.end - left.end || right.priority - left.priority,
  );
  const merged: RedactionSpan[] = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (!previous || span.start >= previous.end) {
      merged.push({ ...span });
      continue;
    }
    previous.end = Math.max(previous.end, span.end);
  }
  return merged;
}
