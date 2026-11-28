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
    terms: {
        selfNames: string[];
        aliases: string[];
        cardName: string;
        source: string;
    };
    hits: LeakHit[];
    summary: LeakSummary;
    /** 扫描量（自证没漏扫：审计说"0 命中"时必须能证明它真的看过）。 */
    scanned: {
        l1: number;
        l0: number;
        md: number;
    };
}
/** 中危词的排除词：实测存在（「淘宝/支付宝/宝藏」会把单字「宝」打成误报）。 */
export declare const ALIAS_EXCLUDES: string[];
/**
 * 对一段文本判级（纯函数，可单测）。
 *
 * @returns 命中的词与级别；未命中返回 undefined
 */
export declare function matchLevel(text: string, terms: PersonaLeakTerms): {
    level: LeakLevel;
    matched: string[];
    excerpt: string;
} | undefined;
/** 结构化 SQLite 面（node:sqlite DatabaseSync 的窄投影，与 drs-anchor-backfill 同款）。 */
export interface SqliteReaderLike {
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
    };
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
export declare function scanL1(db: SqliteReaderLike, terms: PersonaLeakTerms, window: ScanWindow): {
    hits: LeakHit[];
    scanned: number;
};
/** 扫 L0（增量口径 `timestamp`，epoch 毫秒整数列）。 */
export declare function scanL0(db: SqliteReaderLike, terms: PersonaLeakTerms, window: ScanWindow): {
    hits: LeakHit[];
    scanned: number;
};
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
export declare function scanMdFiles(files: readonly MdFileLike[], terms: PersonaLeakTerms, window: ScanWindow, read?: (abs: string) => string, mtimeOf?: (abs: string) => number): {
    hits: LeakHit[];
    scanned: number;
};
export declare function summarize(hits: readonly LeakHit[]): LeakSummary;
export interface LeakState {
    lastRanAt: number;
    firstRunDone: boolean;
}
export declare const AUDIT_DIR = "audit";
export declare const REPORT_FILE = "persona-leak.json";
export declare const STATE_FILE = ".persona-leak-state.json";
export declare function auditDirOf(dataDir: string): string;
/** 读状态；缺失/损坏 ⇒ undefined（= 按首跑处理）。 */
export declare function readState(dataDir: string): LeakState | undefined;
export declare function writeState(dataDir: string, state: LeakState): void;
/** 落报告，返回绝对路径（报告是运行时产物，不进 git）。 */
export declare function writeReport(dataDir: string, report: LeakReport): string;
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
export declare function runPersonaLeakAudit(opts: RunAuditOptions): LeakReport;
/** 递归列出目录下的 .md 文件（不存在 ⇒ 空表，不抛）。 */
export declare function listMdFiles(root: string, relBase?: string): MdFileLike[];
/** 状态文件是否存在（接线处判断首跑用；与 readState 的容错口径一致）。 */
export declare function hasState(dataDir: string): boolean;
