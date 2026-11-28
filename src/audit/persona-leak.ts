/**
 * 人格泄露审计（只报告，不动库）。
 *
 * 判定纪律：**纯关键词，零 LLM、零 embedding**。审计自己不能成为新的漂移源——
 * 一个"看起来差不多"的语义判官会让每次运行给出不同的结论，那比不审计更糟。
 *
 * 首跑深扫 / 常态增量（用户裁决②：「初次允许深度检查，但判定只按关键词」）：
 *  - 无 `audit/.persona-leak-state.json` ⇒ 全库扫（L1 全量 + L0 全量 + md 全量），不受窗口限制；
 *  - 有 ⇒ 只扫 `updated_time > lastRanAt` 的 L1、`timestamp > lastRanAt` 的 L0、mtime 变化的 md。
 *
 * 写面：报告 `<dataDir>/audit/persona-leak.json` 与状态 `<dataDir>/audit/.persona-leak-state.json`。
 * `personaLeakAutoRetire` 默认 **false**——误删不可逆，显式优先纪律。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PersonaLeakTerms } from './persona-terms.js';

/** 命中级别：high = 任意出现即命中；medium = 需词边界且排除常见词。 */
export type LeakLevel = 'high' | 'medium';

export interface LeakHit {
  layer: 'l1' | 'l0' | 'md';
  /** l1/l0 的 record_id；md 的仓库内相对路径。 */
  recordId: string;
  /** 记忆名 / 会话 id / 文件路径（人看的定位符）。 */
  name: string;
  level: LeakLevel;
  /** 命中的词（去重）。 */
  matched: string[];
  /** 命中点前后文（≤80 字，单行）。 */
  excerpt: string;
}

export interface LeakSummary {
  l1: number;
  l0: number;
  md: number;
  high: number;
  medium: number;
}

export interface LeakReport {
  ranAt: string;
  windowDays: number;
  /** true = 本次是全库首跑（无状态文件）。 */
  firstRun: boolean;
  terms: { selfNames: string[]; aliases: string[]; cardName: string; source: string };
  hits: LeakHit[];
  summary: LeakSummary;
  /** 扫描量（自证没漏扫：审计说"0 命中"时必须能证明它真的看过）。 */
  scanned: { l1: number; l0: number; md: number };
}

/** 中危词的排除词：实测存在（「淘宝/支付宝/宝藏」会把单字「宝」打成误报）。 */
export const ALIAS_EXCLUDES = ['淘宝', '支付宝', '宝藏', '宝马', '宝可梦'];

/**
 * 中危词边界：**只看紧邻的那一个字**。
 *
 * 真机实测的教训：早先写成"前文里含任意标点就算边界"，于是「漏网之鱼。」「鲸鱼 Logo」
 * 「八宝山」「元宝」全部命中——因为一整段话里总有个逗号。边界必须逐字符判。
 */
const ALIAS_BOUNDARY = /[\s，。！？、；：,.!?;:~～「」『』（）()]/u;

/** 命中一处即记一次（同一词只记一次）。 */
function excerptAround(text: string, index: number, word: string): string {
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + word.length + 24);
  return text.slice(start, end).replace(/\s+/gu, ' ').trim();
}

/**
 * 对一段文本判级（纯函数，可单测）。
 *
 * @returns 命中的词与级别；未命中返回 undefined
 */
export function matchLevel(text: string, terms: PersonaLeakTerms): { level: LeakLevel; matched: string[]; excerpt: string } | undefined {
  if (text === '') return undefined;
  const high: string[] = [];
  let firstIndex = -1;
  const note = (word: string, index: number): void => {
    if (!high.includes(word)) high.push(word);
    if (firstIndex === -1 || index < firstIndex) firstIndex = index;
  };
  // high ①：自称词（任意出现即命中）
  for (const word of terms.selfNames) {
    if (word === '') continue;
    const at = text.indexOf(word);
    if (at !== -1) note(word, at);
  }
  // high ②：角色名（任意出现即命中）
  if (terms.cardName !== '') {
    const at = text.indexOf(terms.cardName);
    if (at !== -1) note(terms.cardName, at);
  }
  // high ③：人设行标签（行首出现即命中——标签只可能来自人格区渲染）
  for (const tag of terms.boundaryLines) {
    const at = text.indexOf(tag);
    if (at !== -1 && (at === 0 || text[at - 1] === '\n')) note(tag, at);
  }
  if (high.length > 0) {
    const word = high[0] ?? '';
    return { level: 'high', matched: high, excerpt: excerptAround(text, Math.max(0, firstIndex), word) };
  }
  // medium：昵称词需要词边界 + 排除词
  const medium: string[] = [];
  let mediumIndex = -1;
  for (const word of terms.aliases) {
    if (word === '') continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(word, from);
      if (at === -1) break;
      from = at + word.length;
      const prevChar = at === 0 ? '' : text.charAt(at - 1);
      const nextChar = text.charAt(at + word.length);
      const leftOk = at === 0 || ALIAS_BOUNDARY.test(prevChar);
      const rightOk = at + word.length === text.length || ALIAS_BOUNDARY.test(nextChar);
      if (!leftOk || !rightOk) continue;
      // 排除词：命中位置落在排除词内部 ⇒ 不算（「淘宝」里的「宝」）
      const window = text.slice(Math.max(0, at - 4), Math.min(text.length, at + word.length + 4));
      if (ALIAS_EXCLUDES.some((ex) => ex.includes(word) && window.includes(ex))) continue;
      if (!medium.includes(word)) medium.push(word);
      if (mediumIndex === -1 || at < mediumIndex) mediumIndex = at;
      break;
    }
  }
  if (medium.length > 0) {
    const word = medium[0] ?? '';
    return { level: 'medium', matched: medium, excerpt: excerptAround(text, Math.max(0, mediumIndex), word) };
  }
  return undefined;
}

/** 结构化 SQLite 面（node:sqlite DatabaseSync 的窄投影，与 drs-anchor-backfill 同款）。 */
export interface SqliteReaderLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

export interface ScanWindow {
  /** 无状态文件 ⇒ 首跑：全库、不看窗口。 */
  firstRun: boolean;
  /** 增量起点（epoch ms）。firstRun=true 时忽略。 */
  sinceMs: number;
}

/**
 * 扫 L1。
 *
 * 增量口径用 `updated_time`（ISO 毫秒串，与 graph-store 的 MAX(updated_time) 兜底同源）；
 * 首跑不看窗口——裁决②要的是"第一次把库底也过一遍"。
 */
export function scanL1(db: SqliteReaderLike, terms: PersonaLeakTerms, window: ScanWindow): { hits: LeakHit[]; scanned: number } {
  const sql = window.firstRun
    ? 'SELECT record_id, content, type, scene_name, updated_time FROM l1_records'
    : 'SELECT record_id, content, type, scene_name, updated_time FROM l1_records WHERE updated_time > ?';
  const rows = (window.firstRun ? db.prepare(sql).all() : db.prepare(sql).all(new Date(window.sinceMs).toISOString())) as Array<{
    record_id?: unknown;
    content?: unknown;
    type?: unknown;
    scene_name?: unknown;
  }>;
  const hits: LeakHit[] = [];
  for (const row of rows) {
    const content = typeof row.content === 'string' ? row.content : '';
    const m = matchLevel(content, terms);
    if (m === undefined) continue;
    hits.push({
      layer: 'l1',
      recordId: typeof row.record_id === 'string' ? row.record_id : '',
      // l1_records 没有 name 列（名字只活在 JSONL 事实源里），所以这里给的是
      // 「类型 / 场景」定位符——报告要能被人直接翻到那条，不能让人以为它是记录名。
      name: `${String(row.type ?? '')} / ${typeof row.scene_name === 'string' ? row.scene_name : ''}`.trim(),
      level: m.level,
      matched: m.matched,
      excerpt: m.excerpt,
    });
  }
  return { hits, scanned: rows.length };
}

/** 扫 L0（增量口径 `timestamp`，epoch 毫秒整数列）。 */
export function scanL0(db: SqliteReaderLike, terms: PersonaLeakTerms, window: ScanWindow): { hits: LeakHit[]; scanned: number } {
  const sql = window.firstRun
    ? 'SELECT record_id, session_id, role, message_text FROM l0_conversations'
    : 'SELECT record_id, session_id, role, message_text FROM l0_conversations WHERE timestamp > ?';
  const rows = (window.firstRun ? db.prepare(sql).all() : db.prepare(sql).all(window.sinceMs)) as Array<{
    record_id?: unknown;
    session_id?: unknown;
    message_text?: unknown;
    role?: unknown;
  }>;
  const hits: LeakHit[] = [];
  for (const row of rows) {
    const text = typeof row.message_text === 'string' ? row.message_text : '';
    const m = matchLevel(text, terms);
    if (m === undefined) continue;
    hits.push({
      layer: 'l0',
      recordId: typeof row.record_id === 'string' ? row.record_id : '',
      name: `${String(row.session_id ?? '')}/${String(row.role ?? '')}`,
      level: m.level,
      matched: m.matched,
      excerpt: m.excerpt,
    });
  }
  return { hits, scanned: rows.length };
}

export interface MdFileLike {
  /** 展示用的相对路径。 */
  rel: string;
  /** 绝对路径。 */
  abs: string;
}

/**
 * 扫 md 投影文件。
 *
 * 增量口径用 mtime：md 是**投射产物**，内容变了 mtime 必然变；用 mtime 比解析内容再比
 * 哈希便宜，且"文件没动过"的语义本来就成立。
 */
export function scanMdFiles(
  files: readonly MdFileLike[],
  terms: PersonaLeakTerms,
  window: ScanWindow,
  read: (abs: string) => string = (abs) => readFileSync(abs, 'utf8'),
  mtimeOf: (abs: string) => number = (abs) => statSync(abs).mtimeMs,
): { hits: LeakHit[]; scanned: number } {
  const hits: LeakHit[] = [];
  let scanned = 0;
  for (const file of files) {
    if (!window.firstRun) {
      try {
        if (mtimeOf(file.abs) <= window.sinceMs) continue;
      } catch {
        continue;
      }
    }
    let text: string;
    try {
      text = read(file.abs);
    } catch {
      continue;
    }
    scanned++;
    const m = matchLevel(text, terms);
    if (m === undefined) continue;
    hits.push({ layer: 'md', recordId: file.rel, name: file.rel, level: m.level, matched: m.matched, excerpt: m.excerpt });
  }
  return { hits, scanned };
}

export function summarize(hits: readonly LeakHit[]): LeakSummary {
  return {
    l1: hits.filter((h) => h.layer === 'l1').length,
    l0: hits.filter((h) => h.layer === 'l0').length,
    md: hits.filter((h) => h.layer === 'md').length,
    high: hits.filter((h) => h.level === 'high').length,
    medium: hits.filter((h) => h.level === 'medium').length,
  };
}

export interface LeakState {
  lastRanAt: number;
  firstRunDone: boolean;
}

export const AUDIT_DIR = 'audit';
export const REPORT_FILE = 'persona-leak.json';
export const STATE_FILE = '.persona-leak-state.json';

export function auditDirOf(dataDir: string): string {
  return join(dataDir, AUDIT_DIR);
}

/** 读状态；缺失/损坏 ⇒ undefined（= 按首跑处理）。 */
export function readState(dataDir: string): LeakState | undefined {
  try {
    const raw = readFileSync(join(auditDirOf(dataDir), STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { lastRanAt?: unknown; firstRunDone?: unknown };
    if (typeof parsed.lastRanAt !== 'number' || !Number.isFinite(parsed.lastRanAt)) return undefined;
    return { lastRanAt: parsed.lastRanAt, firstRunDone: parsed.firstRunDone === true };
  } catch {
    return undefined;
  }
}

export function writeState(dataDir: string, state: LeakState): void {
  const dir = auditDirOf(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state), 'utf8');
}

/** 落报告，返回绝对路径（报告是运行时产物，不进 git）。 */
export function writeReport(dataDir: string, report: LeakReport): string {
  const dir = auditDirOf(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, REPORT_FILE);
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
  return path;
}

export interface RunAuditOptions {
  dataDir: string;
  terms: PersonaLeakTerms;
  /** 常态增量的窗口天数（首跑不受限）。 */
  windowDays: number;
  /** 库读取面；缺省 ⇒ 跳过 L1/L0 两臂（存储降级时不伪造数据）。 */
  db?: SqliteReaderLike;
  /** md 投影文件清单；缺省 ⇒ 跳过 md 臂。 */
  mdFiles?: readonly MdFileLike[];
  /** 当前时刻（测试注入）。 */
  now?: number;
  /** 首跑/增量的外部覆盖（测试注入）；缺省读状态文件。 */
  window?: ScanWindow;
}

/**
 * 跑一次审计：扫 → 汇总 → 写报告 → 写状态。**不写记忆库**。
 *
 * 返回报告（调用方拿去打日志/告警）；抛错只在写盘失败时发生，由调用方兜住。
 */
export function runPersonaLeakAudit(opts: RunAuditOptions): LeakReport {
  const now = opts.now ?? Date.now();
  const state = readState(opts.dataDir);
  const firstRun = opts.window?.firstRun ?? state === undefined;
  const sinceMs = opts.window?.sinceMs ?? (state?.lastRanAt ?? 0);
  const window: ScanWindow = { firstRun, sinceMs };
  const l1 = opts.db === undefined ? { hits: [] as LeakHit[], scanned: 0 } : scanL1(opts.db, opts.terms, window);
  const l0 = opts.db === undefined ? { hits: [] as LeakHit[], scanned: 0 } : scanL0(opts.db, opts.terms, window);
  const md = opts.mdFiles === undefined ? { hits: [] as LeakHit[], scanned: 0 } : scanMdFiles(opts.mdFiles, opts.terms, window);
  const hits = [...l1.hits, ...l0.hits, ...md.hits];
  const report: LeakReport = {
    ranAt: new Date(now).toISOString(),
    windowDays: opts.windowDays,
    firstRun,
    terms: { selfNames: opts.terms.selfNames, aliases: opts.terms.aliases, cardName: opts.terms.cardName, source: opts.terms.source },
    hits,
    summary: summarize(hits),
    scanned: { l1: l1.scanned, l0: l0.scanned, md: md.scanned },
  };
  writeReport(opts.dataDir, report);
  writeState(opts.dataDir, { lastRanAt: now, firstRunDone: true });
  return report;
}

/** 递归列出目录下的 .md 文件（不存在 ⇒ 空表，不抛）。 */
export function listMdFiles(root: string, relBase = ''): MdFileLike[] {
  const out: MdFileLike[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(join(root, relBase), { withFileTypes: true, encoding: 'utf8' }) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = relBase === '' ? entry.name : join(relBase, entry.name);
    if (entry.isDirectory()) out.push(...listMdFiles(root, rel));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push({ rel, abs: join(root, rel) });
  }
  return out;
}

/** 状态文件是否存在（接线处判断首跑用；与 readState 的容错口径一致）。 */
export function hasState(dataDir: string): boolean {
  return existsSync(join(auditDirOf(dataDir), STATE_FILE));
}
