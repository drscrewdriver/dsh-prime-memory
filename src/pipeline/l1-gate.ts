/**
 * L1 写入门(治理升级 Wave 1,T1.1-T1.5)。
 *
 * **位置契约**:只插在抽取循环产出之后、去重之前——判**抽取入口原始值**
 * (`||60` 强转之前,P0-5);merge/update 产物与导入路径**不在此路径**
 * (导入显式绕门,T1.12)。
 *
 * **零漂移契约(I-10)**:全部子门默认 `off`——off 时 `applyWriteGate` 逐字返回
 * 输入,抽取产物与升级前逐字一致。`warn` 只留痕不丢弃(观察态,O-5);
 * `enforce` 才丢弃。每条丢弃/告警都落 `gate_rejected` 留痕(T1.6),否则用户
 * 不知道记忆为何没进来、无法评估门是否过严(P0-5)。
 *
 * **极保守契约(P1-15)**:形状门/乱码门只拦「不可打印字符占比」与「U+FFFD 占比」
 * 超阈——**绝不基于语言白名单**(中/日/韩/阿拉伯/emoji/代码块/表格 必须全部放行,
 * tests/l1-gate.test.ts 的多语言夹具钉死)。
 */
import { PRIORITY_ABSOLUTE_INSTRUCTION } from '../store/priority.js';
import { assertNotDedupPath } from '../store/search-utils.js';

/** 门模式(Schema.string 落库 + 本函数归一,禁 union/nullable——P0-10)。 */
export type GateMode = 'off' | 'warn' | 'enforce';

export function normalizeGateMode(raw: unknown): GateMode {
  return raw === 'warn' || raw === 'enforce' ? raw : 'off';
}

/** 子门名(词表单一来源;留痕 gate 列只用这里的值,I-17)。 */
export const GATE_NAMES = ['priority', 'shape', 'garbled', 'nearDup', 'llmFilter'] as const;
export type GateName = (typeof GATE_NAMES)[number];

/**
 * priority 阈值表(l1-extraction prompt 的打分纪律,代码层首次落地)。
 * 未登记类型 → Infinity(不设门,fail-open——未知类型宁漏不误)。
 */
export const GATE_PRIORITY_THRESHOLD: Readonly<Record<string, number>> = {
  persona: 50,
  episodic: 60,
  instruction: 70,
  work_fact: 70,
  work_task: 70,
  work_method: 70,
  work_artifact: 70,
};

export function gatePriorityThresholdOf(type: unknown): number {
  const t = typeof type === 'string' ? GATE_PRIORITY_THRESHOLD[type] : undefined;
  return typeof t === 'number' ? t : Number.POSITIVE_INFINITY;
}

// ── 形状/乱码门常量(极保守;安全机制不进配置,ADR-0006 条9 同款) ──
/** 不可打印字符(控制字符,排除 \t \n \r)占比超此阈 → 形状门拦。 */
export const GATE_SHAPE_MAX_NON_PRINTABLE_RATIO = 0.3;
/** U+FFFD 替换符占比超此阈 → 乱码门拦(解码失败的典型形态)。 */
export const GATE_GARBLED_MAX_REPLACEMENT_RATIO = 0.05;
/** 乱码门最小计数:短文本里个别替换符不拦(极保守——占比对短串过敏)。 */
export const GATE_GARBLED_MIN_COUNT = 3;
/** 近重复门(T1.4):与候选的字符二元组 Jaccard ≥ 此阈才拦——阈值刻意贴上限,只在 LLM 判 store 的明显误判上二次拦截。 */
export const GATE_NEARDUP_JACCARD = 0.92;

/** 门判定入参(结构化最小面——PendingMemory 的超集形状,避免反向依赖管线内部类型)。 */
export interface GateCandidate {
  record_id: string;
  content: string;
  type?: unknown;
  family?: unknown;
  /** 抽取入口的**原始** priority(未强转;`-1` 哨兵在此识别,P0-4)。 */
  priority?: unknown;
}

/** 单条留痕(gate_rejected;冷溯源,不进检索/快照)。 */
export interface GateRejection {
  recordId: string;
  gate: GateName;
  mode: Exclude<GateMode, 'off'>;
  /** 原始 priority 的字符串化(未强转的真值;缺失记 ''。 */
  priorityRaw: string;
  reason: string;
  contentChars: number;
}

export interface WriteGateResult<T extends GateCandidate> {
  /** 通过门(含 warn 放行)的记忆,顺序与输入一致。 */
  kept: T[];
  /** 全部丢弃/告警留痕(含 warn;调用方落库)。 */
  rejections: GateRejection[];
}

// ── 纯判定函数(单元测试直接打这里;门只做模式分发) ──

/** priority 门:原始值判定。`-1` 死命令恒放行;缺失/非有限放行(交 ||60 兜底=零漂移)。 */
export function judgePriorityGate(raw: unknown, type: unknown): { pass: boolean; reason: string } {
  if (raw === PRIORITY_ABSOLUTE_INSTRUCTION) return { pass: true, reason: '死命令哨兵恒放行' };
  if (raw === undefined || raw === null || raw === '') return { pass: true, reason: '缺失不拒(交管线兜底)' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { pass: true, reason: '非法不拒(交管线兜底)' };
  const threshold = gatePriorityThresholdOf(type);
  // {instruction,0} 显式定义:0 视为未打分,交管线 ||60 兜底前先按"低于阈值"拦
  if (n >= 0 && n < threshold) {
    return { pass: false, reason: `priority ${n} < threshold(${String(type)}=${threshold})` };
  }
  return { pass: true, reason: '' };
}

/** 形状门:不可打印字符(控制字符,排除 \t\n\r)占比。 */
export function nonPrintableRatio(content: string): number {
  if (content.length === 0) return 0;
  let bad = 0;
  for (const ch of content) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++;
    else if (c === 127) bad++;
  }
  return bad / content.length;
}

export function judgeShapeGate(content: string): { pass: boolean; reason: string } {
  const ratio = nonPrintableRatio(content);
  if (ratio > GATE_SHAPE_MAX_NON_PRINTABLE_RATIO) {
    return { pass: false, reason: `不可打印字符占比 ${(ratio * 100).toFixed(0)}% 超阈` };
  }
  return { pass: true, reason: '' };
}

export function replacementRatio(content: string): number {
  if (content.length === 0) return 0;
  let bad = 0;
  for (const ch of content) if (ch === '\uFFFD') bad++;
  return bad / content.length;
}

export function replacementCount(content: string): number {
  let bad = 0;
  for (const ch of content) if (ch === '\uFFFD') bad++;
  return bad;
}

export function judgeGarbledGate(content: string): { pass: boolean; reason: string } {
  const ratio = replacementRatio(content);
  // 双条件(占比超阈 **且** 绝对数 ≥ MIN_COUNT):短文本里一两个替换符
  // 占比虚高,不拦——极保守,宁可漏拦不可误杀(P1-15)。
  if (ratio > GATE_GARBLED_MAX_REPLACEMENT_RATIO && replacementCount(content) >= GATE_GARBLED_MIN_COUNT) {
    return { pass: false, reason: `U+FFFD 占比 ${(ratio * 100).toFixed(0)}% 超阈` };
  }
  return { pass: true, reason: '' };
}

/** 字符二元组集合(近重复门相似度底座;纯函数,无分词依赖——跨语言安全)。 */
function bigramSet(text: string): Set<string> {
  const t = text.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Jaccard 相似度(二元组;任一侧空 → 0)。近重复门 T1.4 专用。 */
export function nearDupSimilarity(a: string, b: string): number {
  const sa = bigramSet(a);
  const sb = bigramSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * 近重复判定(T1.4):与**既有候选**的最大相似度 ≥ 阈 → 拦。
 * 调用契约:**放 LLM 去重之后**、只在 LLM 判 `store` 的条目上二次拦截——
 * 本函数不判断"该不该跑",只回答"像不像"。
 */
export function judgeNearDupGate(
  content: string,
  candidateContents: readonly string[],
): { pass: boolean; reason: string } {
  let max = 0;
  for (const c of candidateContents) {
    const s = nearDupSimilarity(content, c);
    if (s > max) max = s;
  }
  if (max >= GATE_NEARDUP_JACCARD) {
    return { pass: false, reason: `与既有候选相似度 ${max.toFixed(2)} ≥ ${GATE_NEARDUP_JACCARD}(LLM 判 store 的近重复)` };
  }
  return { pass: true, reason: '' };
}

// ── 门主体 ──

export interface WriteGateConfig {
  priorityMode?: unknown;
  shapeMode?: unknown;
  garbledMode?: unknown;
  nearDupMode?: unknown;
  llmFilterMode?: unknown;
}

/**
 * 写入门主体(T1.1/T1.2/T1.3)。纯同步、无 I/O;留痕由调用方落库。
 * nearDup 与 llmFilter 不在此跑(分别在判 store 处与可选 LLM pass),这里只做
 * priority/shape/garbled 三道机械门。
 *
 * 全 off 时逐字返回输入(含对象引用不复制——零漂移的最强形态)。
 */
export function applyWriteGate<T extends GateCandidate>(
  candidates: T[],
  cfg: WriteGateConfig,
): WriteGateResult<T> {
  assertNotDedupPath('applyWriteGate(写入门只作用抽取入口,不得进入去重候选路径)');
  const priorityMode = normalizeGateMode(cfg.priorityMode);
  const shapeMode = normalizeGateMode(cfg.shapeMode);
  const garbledMode = normalizeGateMode(cfg.garbledMode);
  if (priorityMode === 'off' && shapeMode === 'off' && garbledMode === 'off') {
    return { kept: candidates, rejections: [] };
  }
  const kept: T[] = [];
  const rejections: GateRejection[] = [];
  for (const m of candidates) {
    let dropped = false;
    for (const [gate, mode, judge] of [
      ['priority', priorityMode, () => judgePriorityGate(m.priority, m.type)] as const,
      ['shape', shapeMode, () => judgeShapeGate(m.content)] as const,
      ['garbled', garbledMode, () => judgeGarbledGate(m.content)] as const,
    ] as const) {
      if (mode === 'off') continue;
      const verdict = judge();
      if (verdict.pass) continue;
      rejections.push({
        recordId: m.record_id,
        gate,
        mode,
        priorityRaw: m.priority === undefined || m.priority === null ? '' : String(m.priority),
        reason: verdict.reason,
        contentChars: m.content.length,
      });
      if (mode === 'enforce') dropped = true;
      break; // 一门即定性;同条多门违规不重复留痕(首因即因)
    }
    if (!dropped) kept.push(m);
  }
  return { kept, rejections };
}

// ── 可选 LLM 质量过滤 pass(T1.5;默认关,fail-open) ──

/** 单批上限(学 relabel 的 LLM_CAP 纪律:单次过滤成本硬上界)。 */
export const GATE_LLM_FILTER_BATCH_CAP = 60;

export interface LlmFilterVerdict {
  /** 放行条目的 record_id 集(判不了/失败 = 全部放行)。 */
  keepIds: Set<string>;
  /** 判定留痕(仅明确 drop 的条目)。 */
  rejections: GateRejection[];
}

/**
 * LLM 质量过滤 pass。**fail-open 契约(ADR-0011 条4)**:
 * LLM 不可用/超时/输出不可解析 → **全部放行**,绝不 fail-closed 全拦。
 * `judge` 由调用方注入(管线里接 callLLM),本函数只管批处理与降级语义。
 */
export async function applyLlmQualityFilter<T extends GateCandidate>(
  candidates: T[],
  judge: (batch: T[]) => Promise<Map<string, 'keep' | 'drop'>>,
  mode: unknown,
): Promise<LlmFilterVerdict> {
  const m = normalizeGateMode(mode);
  const keepAll: LlmFilterVerdict = { keepIds: new Set(candidates.map((c) => c.record_id)), rejections: [] };
  if (m !== 'enforce' || candidates.length === 0) return keepAll;
  // 预算截断:超上限的尾部直接放行(deferred 语义——过滤是增益不是门槛)
  const batch = candidates.slice(0, GATE_LLM_FILTER_BATCH_CAP);
  try {
    const verdicts = await judge(batch);
    const keepIds = new Set<string>();
    const rejections: GateRejection[] = [];
    for (const c of candidates) {
      const inBatch = batch.includes(c);
      const v = inBatch ? verdicts.get(c.record_id) : undefined;
      if (v === 'drop') {
        rejections.push({
          recordId: c.record_id,
          gate: 'llmFilter',
          mode: 'enforce',
          priorityRaw: c.priority === undefined || c.priority === null ? '' : String(c.priority),
          reason: 'LLM 质量过滤判 drop',
          contentChars: c.content.length,
        });
      } else {
        // keep / 判不了(undefined) / 超预算 → 全部放行
        keepIds.add(c.record_id);
      }
    }
    return { keepIds, rejections };
  } catch {
    // 任何异常(LLM 不可用/超时/取消)→ fail-open 放行,绝不因过滤器丢记忆
    return keepAll;
  }
}
