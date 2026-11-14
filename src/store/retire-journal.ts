/**
 * 退场墓碑账本(计划 ext-mem-drivers-sync T0.4)。
 *
 * ## 它修的是哪条环
 *
 * `retire()` 是软删:标记写在检索库主表,**不回写 JSONL 事实源**(事实源只增不改)。
 * 于是"重建记忆"从 L0 重蒸会把用户已显式遗忘的事实**以活跃态复活**——这在纯本地
 * 时代只是"多见一条旧事实"(bench 已声明的已知边界),但接上外部推送后它变成:
 *
 * ```
 * 用户"忘了 X" → 本地软删 → 推送远端 hard-delete
 *   → 重建把 X 重蒸成活跃态 → 同步器看到"本地有、远端无" ⇒ 重新推送
 *     ⇒ X 在远端复活 —— 用户的"忘记"在本地与远端两处失效,且全程无报错
 * ```
 *
 * 运行期补救不可能(远端已 hard delete,第二条时间线无法证明"当初删过"),所以
 * 墓碑必须在**退场发生的当下**落盘:`retire-journal.jsonl` 与事实源同级、只增不改,
 * 重建收尾据此把"重蒸回来的已遗忘内容"重新压回退场态。
 *
 * ## 墓碑的身份为什么是 contentHash
 *
 * 重蒸馏产出**新铸的 record_id**——按 id 过滤复活在结构上不成立。跨 id 的唯一
 * 身份是规范化后的内容本身(`\s+→' '` + lowercase,与 `computeExtKey` 的身份归一同款)。
 * 诚实边界:**只拦字节级重现**;LLM 重蒸换措辞的产出拦不住(那要语义判据,
 * 属去重可见性改造,不在本波)。远端二次蒸馏改写正文的家同理——墓碑对它们是
 * 尽力而为,不是完备保证。
 *
 * ## 哪些退场配当墓碑
 *
 * 只有**人的判定**:`manual`(人工删除)与 `conflict`(人工裁决败方)。
 * `superseded`/`obsolete` 是机器节奏内的取代/过期,重建时让去重管线自己收敛,
 * 压死它们反而会误伤"用户显式重新添加同一事实"的正当路径。
 * `restore()` 落反向事件:replay 时后到者胜,恢复即撤销墓碑。
 *
 * ## 降级纪律
 *
 * 追加失败只 warn 不抛(退场在库侧已经成立,墓碑缺一条 = 该条回到旧边界,
 * 不能让旁路面否决主链路);读取失败回空集(重扫退化为 no-op,绝不阻断重建)。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { MemoryLogger, MemoryRecord } from '../types.js';
import type { RetireReason, SupersedeInfo } from './supersede.js';
import { readJsonl } from '../util/io.js';

/** 墓碑账本文件名(数据目录根下,与 memory.db / records/ 同级)。 */
export const RETIRE_JOURNAL_FILE = 'retire-journal.jsonl';

/** 配当墓碑的退场原因(见文件头「哪些退场配当墓碑」)。 */
export const TOMBSTONED_REASONS: readonly RetireReason[] = ['manual', 'conflict'];

export interface RetireJournalEntry {
  /** 事件类型:退场落正向墓碑,恢复落反向事件(replay 后到者胜)。 */
  ev: 'retire' | 'restore';
  id: string;
  /** ISO 8601 事件时刻。 */
  ts: string;
  /** 仅 ev='retire' 且有墓碑价值(manual/conflict)时写入。 */
  reason?: RetireReason;
  /** 内容墓碑指纹(仅 ev='retire');restore 反向事件按 id 撤销,不需要指纹。 */
  hash?: string;
  /** 外部幂等键(有则带上,Phase 2+ 的 pusher 侧交叉审计用)。 */
  extKey?: string;
}

/** 内容归一:折叠空白 + 小写。与 `computeExtKey` 的身份归一口径一致——**改动即换算法**,
 *  已有墓碑全部失配,升级须知写在这里。 */
export function normalizeForTombstone(content: string): string {
  return content.replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

/** 墓碑指纹(sha256 hex)。纯函数,零 I/O。 */
export function tombstoneHash(content: string): string {
  return createHash('sha256').update(normalizeForTombstone(content), 'utf8').digest('hex');
}

function journalPath(dataDir: string): string {
  return path.join(dataDir, RETIRE_JOURNAL_FILE);
}

/**
 * 追加退场事件(同步落盘,量级 = 单次退场批的条数,微秒级)。
 * `records` 提供内容与 extKey(retire 调用点在库侧已完成,这里只派生指纹)。
 * 失败只 warn:墓碑缺一条 = 该条回到旧的已知边界,不是新故障。
 */
export function appendRetireJournal(
  dataDir: string,
  ids: readonly string[],
  info: SupersedeInfo,
  recordsById: ReadonlyMap<string, MemoryRecord>,
  logger?: MemoryLogger,
): void {
  if (ids.length === 0) return;
  const tombstoned = TOMBSTONED_REASONS.includes(info.reason);
  try {
    mkdirSync(dataDir, { recursive: true });
    const lines: string[] = [];
    for (const id of ids) {
      const rec = recordsById.get(id);
      const e: RetireJournalEntry = { ev: 'retire', id, ts: info.at };
      if (tombstoned) {
        e.reason = info.reason;
        if (rec !== undefined) e.hash = tombstoneHash(rec.content);
        const extKey = rec?.extKey;
        if (typeof extKey === 'string' && extKey !== '') e.extKey = extKey;
      }
      lines.push(JSON.stringify(e));
    }
    appendFileSync(journalPath(dataDir), `${lines.join('\n')}\n`, 'utf8');
  } catch (err) {
    logger?.warn(`[memory] 退场墓碑写入失败(退场本身已生效;该批重建后可能复活): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 追加恢复事件(撤销语义由 replay 的"后到者胜"给出,这里只落一行)。 */
export function appendRestoreJournal(
  dataDir: string,
  ids: readonly string[],
  logger?: MemoryLogger,
): void {
  if (ids.length === 0) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    const ts = new Date().toISOString();
    const lines = ids.map((id) => JSON.stringify({ ev: 'restore', id, ts } satisfies RetireJournalEntry));
    appendFileSync(journalPath(dataDir), `${lines.join('\n')}\n`, 'utf8');
  } catch (err) {
    logger?.warn(`[memory] 恢复事件写入墓碑账本失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 当前活跃的墓碑集:内容指纹 → 退场原因。 */
export interface TombstoneSet {
  /** 命中活跃墓碑则返回其退场原因,否则 undefined。 */
  reasonFor(hash: string): RetireReason | undefined;
  get size(): number;
}

const EMPTY_TOMBSTONES: TombstoneSet = { reasonFor: () => undefined, size: 0 };

function isJournalEntry(v: unknown): v is RetireJournalEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (o.ev === 'retire' || o.ev === 'restore') && typeof o.id === 'string';
}

/**
 * 读账本并 replay 出活跃墓碑集(事件溯源,后到者胜:同一 id 最后一次 retire/restore
 * 决定生死;活着的 retire 按其 hash 建索引)。
 *
 * 坏行跳过(readJsonl 本身也跳),整体读失败回空集——重扫退化为 no-op,
 * 绝不因旁路账本阻断重建。
 */
export async function readTombstones(dataDir: string, logger?: MemoryLogger): Promise<TombstoneSet> {
  let rows: unknown[];
  try {
    rows = await readJsonl<unknown>(journalPath(dataDir));
  } catch (err) {
    logger?.warn(`[memory] 墓碑账本读取失败(本次重建不做遗忘重压): ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY_TOMBSTONES;
  }
  // id → 最后一条事件(只留有墓碑价值的:retire 且 reason ∈ TOMBSTONED 且有 hash)
  const lastByid = new Map<string, RetireJournalEntry>();
  for (const raw of rows) {
    if (!isJournalEntry(raw)) continue;
    lastByid.set(raw.id, raw);
  }
  const byHash = new Map<string, RetireReason>();
  for (const e of lastByid.values()) {
    if (e.ev !== 'retire' || e.hash === undefined) continue;
    if (!TOMBSTONED_REASONS.includes(e.reason as RetireReason)) continue;
    byHash.set(e.hash, e.reason as RetireReason);
  }
  if (byHash.size === 0) return EMPTY_TOMBSTONES;
  return {
    reasonFor: (hash: string) => byHash.get(hash),
    get size() {
      return byHash.size;
    },
  };
}

/**
 * 重建收尾的**遗忘重压**:扫本轮新产物,内容指纹命中活跃墓碑的重新压回退场。
 *
 * 单独成函数(而不是埋进 RebuildController)只为可测——环路判据不该要求
 * 跑一次端到端重建才能验证。`retire` 注入的是 `L1Store.retire`(汇流口,
 * 投射跟随与墓碑追加自然发生)。
 *
 * @returns scanned 扫过多少条候选,repressed 重新退场多少条。
 */
export async function tombstoneResweep(
  opts: {
    dataDir: string;
    /** 重建窗口内的新产记录(调用方按 createdAt >= rebuildStartMs 收集)。 */
    candidates: readonly MemoryRecord[];
    retire: (ids: string[], info: SupersedeInfo) => number;
    logger?: MemoryLogger;
    now?: () => Date;
  },
): Promise<{ scanned: number; repressed: number }> {
  const tombs = await readTombstones(opts.dataDir, opts.logger);
  if (tombs.size === 0 || opts.candidates.length === 0) return { scanned: opts.candidates.length, repressed: 0 };
  const byReason = new Map<RetireReason, string[]>();
  for (const r of opts.candidates) {
    const reason = tombs.reasonFor(tombstoneHash(r.content));
    if (reason === undefined) continue;
    const list = byReason.get(reason) ?? [];
    list.push(r.id);
    byReason.set(reason, list);
  }
  let repressed = 0;
  const at = (opts.now?.() ?? new Date()).toISOString();
  for (const [reason, ids] of byReason) {
    try {
      // 逐 id 的墓碑原因回写(release 语义:重压只是"再次退场",审计线索进 reason 字段)
      repressed += opts.retire(ids, { at, reason });
    } catch (err) {
      opts.logger?.warn(`[memory] 墓碑重压失败(reason=${reason}, ${ids.length} 条): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (repressed > 0) {
    opts.logger?.info(`[memory] 重建收尾遗忘重压:${repressed} 条用户已删除/已裁决的记忆被重新压回退场`);
  }
  return { scanned: opts.candidates.length, repressed };
}
