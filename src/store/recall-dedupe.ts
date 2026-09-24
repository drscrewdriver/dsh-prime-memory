/**
 * 召回去重存储:sessionId → 已注入 L1 记录 id 集合的持久化映射。
 *
 * 语义:
 * - 同会话内已注入过的记忆不再重复注入(模型上下文已持有,重复注入浪费 token);
 * - 压制粒度 = 记录 id——去重合并更新会换新 id,新内容天然解除压制重新注入;
 * - compact/clear 事件重置(上下文被压缩/清空,注入内容已丢失);resume 不重置;
 * - 热路径(召回 pre-step)同步内存读取,mark/reset 写穿持久化(session-modes 同款:
 *   串行化原子写 + 失败降级内存态),任何 I/O 失败绝不抛进召回路径。
 */
import * as path from 'node:path';
import type { MemoryLogger } from '../types.js';
import { errDetail } from '../util/filelog.js';
import { ensureDir, readJsonStrict, rmwJson } from '../util/io.js';
import { RECALL_DEDUPE_FILE_VERSION } from './file-versions.js';

/** 会话条目上限(按 updatedAt 淘汰最旧;防文件无限增长)。 */
export const RECALL_DEDUPE_SESSION_CAP = 200;
/** 单会话记录 id 上限(按插入序淘汰最旧;Set 迭代序即插入序)。 */
export const RECALL_DEDUPE_IDS_CAP = 512;
/** 条目过期清理(90 天未更新即丢弃,与 session-modes 同款量级)。 */
const PRUNE_MS = 90 * 24 * 3600_000;

interface DedupeEntry {
  ids: Set<string>;
  updatedAt: number;
}

interface DedupeFile {
  version: typeof RECALL_DEDUPE_FILE_VERSION;
  sessions: Record<string, { recordIds: string[]; updatedAt: number }>;
}

export class RecallDedupeStore {
  private readonly file: string;
  private readonly entries = new Map<string, DedupeEntry>();
  private persistFailed = false;
  /** 只读降级原因(undefined = 正常):非空时去重集合照常生效,但停止回写。 */
  private degraded: string | undefined;
  private degradedLogged = false;
  /** 本进程上次成功写入的磁盘内容(紧凑 JSON);并发冲突判据:磁盘与它不同 = 别人写过。 */
  private lastPersisted: string | undefined;
  /** 串行化持久化写(避免并发原子写撞临时文件名);init 链最前(先载入再落盘,防丢更新)。 */
  private writeChain: Promise<void>;

  constructor(dataDir: string, private readonly logger?: MemoryLogger) {
    this.file = path.join(dataDir, 'recall-dedupe.json');
    this.writeChain = this.init();
  }

  /**
   * 载入持久化映射(合并进内存——构造与载入之间发生的 mark 不丢);失败降级内存态。
   *
   * **读侧分类**(文件层加固 T2):缺失合法;损坏/不可读 → 告警 + 只读降级(禁写);
   * 未知版本 → **仍按当前形状读取** + 只读降级(本 store 无迁移路径)。
   */
  private async init(): Promise<void> {
    const r = await readJsonStrict<Partial<DedupeFile>>(this.file, { expectedVersion: RECALL_DEDUPE_FILE_VERSION });
    let data: Partial<DedupeFile> | undefined;
    if (r.ok) {
      data = r.value;
    } else if (r.reason === 'missing') {
      return;
    } else {
      const lenient = await readJsonStrict<Partial<DedupeFile>>(this.file);
      if (!lenient.ok) {
        this.degraded = lenient.reason;
        this.logger?.warn(
          `[memory] 召回去重文件${lenient.reason === 'corrupt' ? '损坏' : '不可读'}(${this.file}): ` +
            `按空集合起步且**不回写**,原文件已保留${lenient.detail ? ` — ${lenient.detail}` : ''}`,
        );
        return;
      }
      data = lenient.value;
      this.degraded = `未知版本(${lenient.version ?? '无 version 字段'})`;
      this.logger?.warn(`[memory] 召回去重文件版本未知(${lenient.version ?? '无'}):按当前形状读取并进入只读降级(不回写)`);
    }
    this.lastPersisted = JSON.stringify(data);
    if (!data?.sessions || typeof data.sessions !== 'object') return;
    const now = Date.now();
    let count = 0;
    for (const [sid, entry] of Object.entries(data.sessions)) {
      if (!Array.isArray(entry?.recordIds)) continue;
      if (now - (entry.updatedAt ?? 0) > PRUNE_MS) continue;
      const existing = this.entries.get(sid);
      if (existing) {
        // 合并:构造后、载入完成前已发生的 mark(保留较大 updatedAt)
        for (const id of entry.recordIds) existing.ids.add(id);
        existing.updatedAt = Math.max(existing.updatedAt, entry.updatedAt ?? 0);
      } else {
        this.entries.set(sid, { ids: new Set(entry.recordIds), updatedAt: entry.updatedAt ?? now });
      }
      count++;
    }
    if (count > 0) this.logger?.info(`[memory] 召回去重记录载入 ${count} 个会话`);
  }

  /** 该会话的已注入集合(热路径同步读;未出现过的会话返回空集合,惰性建条)。 */
  seen(sessionId: string): Set<string> {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { ids: new Set(), updatedAt: 0 };
      this.entries.set(sessionId, entry);
    }
    return entry.ids;
  }

  /** 标记本轮实际注入的记录 id(写穿;调用方保证只传模型真实看到的条目)。 */
  mark(sessionId: string, recordIds: string[]): void {
    if (recordIds.length === 0) return;
    const ids = this.seen(sessionId);
    for (const id of recordIds) ids.add(id);
    // 插入序淘汰最旧(Set 迭代序 = 插入序)
    while (ids.size > RECALL_DEDUPE_IDS_CAP) {
      const oldest = ids.values().next().value;
      if (oldest === undefined) break;
      ids.delete(oldest);
    }
    const entry = this.entries.get(sessionId)!;
    entry.updatedAt = Date.now();
    this.writeChain = this.writeChain.then(() => this.persist());
  }

  /** 清空该会话的记录(compact/clear 后上下文已丢失,记忆需可重新注入)。 */
  reset(sessionId: string): void {
    if (!this.entries.has(sessionId)) return;
    this.entries.delete(sessionId);
    this.writeChain = this.writeChain.then(() => this.persist());
  }

  /** 等待在途持久化写完成(测试/停机用)。 */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private async persist(): Promise<void> {
    if (this.degraded !== undefined) {
      // 只读降级:内存去重集合照常生效(重复注入照样被压),但不落盘
      if (!this.degradedLogged) {
        this.degradedLogged = true;
        this.logger?.warn(`[memory] 召回去重处于只读降级(${this.degraded}),已停止回写(磁盘文件保持不变)`);
      }
      return;
    }
    try {
      await ensureDir(path.dirname(this.file));
      await rmwJson<DedupeFile, void>(
        this.file,
        async (cur) => {
          const diskRaw = cur.ok ? JSON.stringify(cur.value) : undefined;
          if (this.lastPersisted !== undefined && diskRaw !== undefined && diskRaw !== this.lastPersisted) {
            throw new Error(`召回去重文件已被其它进程更新,本次写入已取消以避免覆盖;请重试该操作`);
          }
          const next = this.serialize();
          this.lastPersisted = JSON.stringify(next);
          return { next, result: undefined };
        },
        { logger: this.logger, purpose: 'recall-dedupe-rmw' },
      );
      this.persistFailed = false;
    } catch (err) {
      if (!this.persistFailed) {
        this.persistFailed = true;
        this.logger?.warn(`[memory] 召回去重持久化失败(降级内存态): ${errDetail(err)}`);
      }
    }
  }

  private serialize(): DedupeFile {
    const now = Date.now();
    // 超期清理 + 条数上限(按 updatedAt 淘汰最旧)
    for (const [sid, e] of this.entries) {
      if (now - e.updatedAt > PRUNE_MS && e.updatedAt > 0) this.entries.delete(sid);
    }
    while (this.entries.size > RECALL_DEDUPE_SESSION_CAP) {
      let oldest: string | undefined;
      let oldestAt = Infinity;
      for (const [sid, e] of this.entries) {
        if (e.updatedAt > 0 && e.updatedAt < oldestAt) {
          oldest = sid;
          oldestAt = e.updatedAt;
        }
      }
      if (oldest === undefined) break; // 只剩惰性空条目(updatedAt=0),不占文件体积可留待过期清理
      this.entries.delete(oldest);
    }
    const sessions: DedupeFile['sessions'] = {};
    for (const [sid, e] of this.entries) {
      if (e.ids.size === 0) continue; // 空集合不落盘
      sessions[sid] = { recordIds: [...e.ids], updatedAt: e.updatedAt };
    }
    return { version: RECALL_DEDUPE_FILE_VERSION, sessions };
  }
}
