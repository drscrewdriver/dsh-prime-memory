/**
 * 外部驱动共用小工具(计划 T1.x):extra JSON 解析、数值钳制、响应体安全取值。
 * 纯函数零 I/O;`objOf/arrOf/str/num` 与参考实现的 firstArray/jsonObject 家族
 * 同语义——外部服务的响应形状漂移是常态,取值面必须逐字段判缺、绝不 `!` 断言。
 */

/** 解析配置的 `extra` JSON 串(非法/空 → {})。驱动专有字段全部走这里进来。 */
export function parseExtra(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 按候选键序取第一个数组字段(各家包裹层不一:results/memories/items/…)。 */
export function firstArray(payload: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  const o = obj(payload);
  if (o === undefined) return [];
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v) && v.length > 0) return v;
  }
  // 全都存在但为空数组时,返回第一个空数组(区分"字段缺失"与"零结果"没有意义,
  // 两者都归一为 []);键都不存在 → []。
  for (const k of keys) {
    if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  return [];
}

export function clampInt(value: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** 内容注入前的安全截断(外部正文不受本地 maxCharsPerMemory 之外判据约束,lane 层先切一刀)。 */
export function clip(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}\n[... truncated]`;
}

/** 外部件的稳定 id:`ext:<driverId>:<spaceId>:<externalId>`(与 L1Store.extLane 归因约定同源)。 */
export function extHitId(driverId: string, spaceId: string, externalId: string): string {
  return `ext:${driverId}:${spaceId}:${externalId}`;
}

/**
 * 内容指纹**单源**(T4.1):实现在 `store/digest.ts`，这里只 re-export 保既有 import 面。
 * `recordDigest` = `contentDigest`(含 type 的库侧指纹);三侧裁决用 `contentOnlyDigest`。
 */
export { normContentKey, sha256Hex, contentDigest as recordDigest } from '../store/digest.js';

/** CSV 串归一成去重 Set(非法/空 → 空 Set;消费侧容错,配置面不抛)。 */
export function normCsv(raw: unknown): Set<string> {
  if (typeof raw !== 'string') return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== ''));
}

/** CSV 串归一成升序数值数组(非法项丢弃;空集回退缺省阶梯)。 */
export function normCsvNumbers(raw: unknown, dflt: number[]): number[] {
  if (typeof raw !== 'string') return dflt;
  const out = raw.split(',').map((s) => Math.floor(Number(s.trim()))).filter((n) => Number.isFinite(n) && n > 0);
  return out.length > 0 ? out : dflt;
}

/**
 * Phase 1 只读构建的写侧桩:方法存在以满足 `assertRuntime`(声明与运行时互校),
 * 但任何真实写入都**明确报错而不静默半实现**——返回 failed 回执,推送链路(Phase 2)
 * 接入后由真实现替掉。
 *
 * 读侧桩不再用本常量：拉取类未实装的能力（list/graph）现在抛 `ExtCapabilityMissingError`，
 * 因为调用方需要能区分“该家没接”与“远端真故障”——旧写法两者都是普通 Error，于是 puller 要么
 * 无差别 catch（把远端抖动静默降级成从头全量翻页）、要么无差别计失败（把本来可用的 list 挡在门外）。
 */
export const READ_ONLY_RECEIPT = {
  completion: 'failed' as const,
  error: '外部记忆写路径未启用(Phase 1 为只读融合;推送在 Phase 2 接入)',
};

/**
 * 能力未实装哨兵错。`instanceof` 判据不受错误文案改动影响，也不依赖 message 子串匹配。
 */
export class ExtCapabilityMissingError extends Error {
  readonly capability: 'list' | 'graph' | 'sincePull' | 'discover';
  constructor(capability: ExtCapabilityMissingError['capability'], what: string) {
    super(`外部记忆 ${what} 未实装(该服务未提供对应端点或未接入)`);
    this.name = 'ExtCapabilityMissingError';
    this.capability = capability;
  }
}

/** 拉取分派判据：错是不是“能力没接”（而非网络/服务端故障）。 */
export function isCapabilityMissing(err: unknown, capability?: 'list' | 'graph' | 'sincePull' | 'discover'): boolean {
  if (!(err instanceof ExtCapabilityMissingError)) return false;
  return capability === undefined || err.capability === capability;
}

/** 旧接口保留（多处调用）：语义上等价于“能力未实装”。 */
export function readOnlyPhaseError(what: string): Error {
  return new Error(`外部记忆 ${what} 未启用(Phase 1 为只读融合;拉取/图在 Phase 3 接入)`);
}
