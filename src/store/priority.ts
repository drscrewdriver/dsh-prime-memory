/**
 * priority 单一收敛点(O-9,计划 Wave 0 T0.7)。
 *
 * 本仓库现存**三套默认标度且本波不统一**(ADR-0014 如实登记,统一标度=破坏
 * 既有契约/零漂移承诺):
 * - **存储层 50**:`l1_records.priority INTEGER DEFAULT 50`(sqlite.ts DDL),
 *   读回兜底 `Number(r.priority ?? 50)`(sqlite.ts / graph-store.ts);
 * - **抽取管线 60**:蒸馏未打分/打 0/非法时 `Number(m.priority) || 60`(l1.ts);
 * - **导入/工具 80**:`memory_add`/memport 缺省 80 且 clamp 到 [0,100](tools)。
 *
 * 三处**解析语义也不同**(||回落 vs ??兜底 vs isFinite+clamp),本模块把它们
 * 收敛为三个具名函数——调用点必须从各自语义函数取值,禁止散落裸写默认数;
 * 默认值常量在此钉死,后续改标度只动本文件+ADR。
 *
 * 判定轴约定(O-9):写入门(l1-gate)判**抽取入口原始值**(`-1` 死命令哨兵在
 * 强转之前识别);召回侧按 priority 判定(含 Wave2 floorOf)一律读**收敛后落库**的
 * `rec.priority`。`type` 参数是判定轴的扩展位——解析本身不按 type 分支。
 */

/** 极严格全局死命令哨兵(l1-extraction prompt 约定仅 instruction 使用)。 */
export const PRIORITY_ABSOLUTE_INSTRUCTION = -1;

/** 存储层标度:DDL 列默认 + 读回兜底。 */
export const PRIORITY_DEFAULT_STORE = 50;
/** 抽取管线标度:蒸馏未打分兜底。 */
export const PRIORITY_DEFAULT_EXTRACT = 60;
/** 导入/工具标度:显式缺省。 */
export const PRIORITY_DEFAULT_IMPORT = 80;

/**
 * 抽取管线解析语义:与既有 `Number(m.priority) || 60` **逐字等价**——
 * 0/NaN/缺失/空串一律回落 fallback(`-1` 为真值,原样保留)。
 * 0 值交由 fallback 兜底是现状语义;写入门在强转之前判原始值,不受此影响。
 */
export function normalizePriority(
  raw: unknown,
  _type: string | undefined,
  fallback: number = PRIORITY_DEFAULT_EXTRACT,
): number {
  const n = Number(raw);
  return n || fallback;
}

/**
 * 存储层解析语义:与既有 `Number(r.priority ?? 50)` **逐字等价**——
 * 仅 null/undefined 回落,0 与 NaN 原样透传(读回 fail-open,不擅改值)。
 */
export function normalizeStoredPriority(raw: unknown, fallback: number = PRIORITY_DEFAULT_STORE): number {
  return Number(raw ?? fallback);
}

/**
 * 导入/工具解析语义:与既有 `Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : 80`
 * **逐字等价**——有限非负收进 [0,100],其余(含 `-1`)回落 fallback。
 * 导入路径显式**不过写入门**(T1.12),本函数即导入侧唯一的 priority 归一。
 */
export function normalizeImportPriority(raw: unknown, fallback: number = PRIORITY_DEFAULT_IMPORT): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : fallback;
}
