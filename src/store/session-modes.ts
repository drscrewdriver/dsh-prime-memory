/**
 * 会话记忆档位存储:sessionId → MemoryMode 的持久化映射。
 * 热路径(捕获 turn/end、召回 pre-step、工具 execute)需要同步读取,
 * 因此 init() 一次性载入内存 Map,set() 写穿。
 * 存储失败只降级为内存态(warn 不崩),与插件的存储降级不变量一致。
 */
import * as path from 'node:path';
import type { MemoryLogger, MemoryMode } from '../types.js';
import { HALL_CATALOG } from '../types.js';
import { errDetail } from '../util/filelog.js';
import { atomicWriteJson, ensureDir, readJsonIfExists } from '../util/io.js';

const MODES: readonly MemoryMode[] = ['auto', 'chat', 'work', 'off'];
const PRUNE_MS = 90 * 24 * 3600_000;
const MAX_ENTRIES = 500;

interface ModeEntry {
  mode: MemoryMode;
  /** 会话级注入覆盖(只写不读进档位语义):true/false = 强制开/关;缺省 = 跟随全局。
   *  只影响读侧三闸门(pre-step / 稳定区 / 工具),捕获与蒸馏零感知。 */
  recall?: boolean;
  /** 会话级域锁定(hall 八边形手动挡):角 id = 只召回该域(召回硬过滤);
   *  缺省/undefined = 中心(智能档,按域相关度软门禁)。与档位/注入正交,跨切档保留。
   *  写侧不收窄:蒸馏与打标零感知(标签只反映内容,无选中域偏向)。
   *  Phase 2 多选(R13):单值 `hall` 保留为磁盘兼容键(旧文件/单角时镜像),
   *  新多选写 `halls` 数组。 */
  hall?: string;
  /** 多选域锁定:命中任一锁定域即通过硬过滤;空/缺省 = 中心。 */
  halls?: string[];
  /** 锁定域时的边界开关:未打标记忆是否参与召回(默认包含——默认排除会静默丢掉一半语料)。 */
  hallIncludeUnlabeled?: boolean;
  /** 锁定域时跨域兜底 `general` 是否参与召回(默认不含——跨域与单主题相悖)。 */
  hallIncludeGeneral?: boolean;
  updatedAt: number;
}

interface ModeFile {
  version: 1;
  sessions: Record<string, ModeEntry>;
}

export function isMemoryMode(v: unknown): v is MemoryMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

/** 合法角 id 判定(锁域只认 8 角;general 是兜底值不是角,不可锁定)。 */
export function isHallCorner(v: unknown): v is string {
  return typeof v === 'string' && HALL_CATALOG.some((h) => h.id === v);
}

export class SessionModeStore {
  private readonly file: string;
  private readonly entries = new Map<string, ModeEntry>();
  private readonly loaded: MemoryMode;
  private persistFailed = false;
  /** 档位切换回调(index.ts 装配 runner 的同步动作:切片落袋/挂起,ADR-0003)。 */
  private onModeChange?: (sessionId: string, oldMode: MemoryMode, newMode: MemoryMode) => void;
  /** 串行化持久化写(避免并发原子写撞临时文件名)。 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly defaultMode: Extract<MemoryMode, 'auto' | 'chat' | 'work'>,
    private readonly logger?: MemoryLogger,
  ) {
    this.file = path.join(dataDir, 'session-modes.json');
    this.loaded = defaultMode;
  }

  /** 载入持久化映射(index.ts 启动时 await;失败降级内存态)。 */
  async init(): Promise<void> {
    const data = await readJsonIfExists<Partial<ModeFile>>(this.file);
    if (!data?.sessions || typeof data.sessions !== 'object') return;
    const now = Date.now();
    let count = 0;
    for (const [sid, entry] of Object.entries(data.sessions)) {
      if (!isMemoryMode(entry?.mode)) continue;
      if (now - (entry.updatedAt ?? 0) > PRUNE_MS) continue;
      this.entries.set(sid, {
        mode: entry.mode,
        // 非布尔视为损坏丢弃(= 跟随全局);旧文件无此键同款兼容
        recall: typeof entry.recall === 'boolean' ? entry.recall : undefined,
        // 域锁定只认 8 角 id;非法/缺省 = 中心(智能档)。多选数组优先,单值键兜底
        hall: isHallCorner(entry.hall) ? entry.hall : undefined,
        halls: Array.isArray(entry.halls)
          ? Array.from(new Set(entry.halls.filter((x) => isHallCorner(x))))
          : isHallCorner(entry.hall)
            ? [entry.hall]
            : undefined,
        hallIncludeUnlabeled:
          typeof entry.hallIncludeUnlabeled === 'boolean' ? entry.hallIncludeUnlabeled : undefined,
        hallIncludeGeneral:
          typeof entry.hallIncludeGeneral === 'boolean' ? entry.hallIncludeGeneral : undefined,
        updatedAt: entry.updatedAt ?? now,
      });
      count++;
    }
    if (count > 0) this.logger?.info(`[memory] 会话档位载入 ${count} 条(默认档=${this.defaultMode})`);
  }

  get default(): MemoryMode {
    return this.loaded;
  }

  /** 同步读取:未设置过的会话返回默认档。 */
  get(sessionId: string): MemoryMode {
    return this.entries.get(sessionId)?.mode ?? this.loaded;
  }

  /**
   * 该会话是否有**显式**档位条目(区别于 `get()` 的默认档回落)。
   *
   * 子代理档位继承(§A)靠它判断"这一层是否设过":未设过则继续沿父链上溯,
   * 而不是立刻吃默认档——后者正是"用户显式 off 被绕过"的成因。
   */
  hasEntry(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** 会话级注入覆盖原始值:undefined = 未覆盖,跟随全局。 */
  getRecall(sessionId: string): boolean | undefined {
    return this.entries.get(sessionId)?.recall;
  }

  /** 解析后的注入开关:会话覆盖 ?? 全局运行时开关(部署级 cfg.recall.enabled
   *  与主闸 s.enabled 不经此处,仍按既有硬门生效——覆盖打不穿部署上限)。 */
  resolvedRecall(sessionId: string, globalRecall: boolean): boolean {
    return this.entries.get(sessionId)?.recall ?? globalRecall;
  }

  /** 设置会话级注入覆盖(undefined = 清除覆盖跟随全局。写穿持久化)。 */
  setRecall(sessionId: string, recall: boolean | undefined): void {
    const entry = this.entries.get(sessionId);
    this.entries.set(sessionId, {
      mode: entry?.mode ?? this.loaded,
      recall,
      // 域锁定与注入正交:设置注入不动锁域(照抄"切档不动覆盖"模板)
      hall: entry?.hall,
      halls: entry?.halls,
      hallIncludeUnlabeled: entry?.hallIncludeUnlabeled,
      hallIncludeGeneral: entry?.hallIncludeGeneral,
      updatedAt: Date.now(),
    });
    this.writeChain = this.writeChain.then(() => this.persist());
  }

  /** 会话级域锁定(多选):空数组 = 中心(智能档,无锁域)。 */
  getHalls(sessionId: string): string[] {
    const e = this.entries.get(sessionId);
    if (e?.halls && e.halls.length > 0) return e.halls;
    return e?.hall ? [e.hall] : [];
  }

  /** 兼容读取(单选口径,取第一个锁定域):undefined = 中心。 */
  getHall(sessionId: string): string | undefined {
    return this.getHalls(sessionId)[0];
  }

  /** 锁定域边界开关:未打标是否包含(缺省 true)/ general 是否包含(缺省 false)。 */
  hallBoundaries(sessionId: string): { includeUnlabeled: boolean; includeGeneral: boolean } {
    const e = this.entries.get(sessionId);
    return {
      includeUnlabeled: e?.hallIncludeUnlabeled ?? true,
      includeGeneral: e?.hallIncludeGeneral ?? false,
    };
  }

  /** 设置会话级域锁定(多选:角 id 数组;空数组/undefined = 回中心清除锁定。写穿持久化)。
   *  单角时镜像写 `hall` 兼容键,多角时置空(旧读者按无锁域读)。 */
  setHall(
    sessionId: string,
    halls: readonly string[] | undefined,
    boundaries?: { includeUnlabeled?: boolean; includeGeneral?: boolean },
  ): void {
    const entry = this.entries.get(sessionId);
    const locked = Array.from(new Set((halls ?? []).filter((x) => isHallCorner(x))));
    this.entries.set(sessionId, {
      mode: entry?.mode ?? this.loaded,
      recall: entry?.recall,
      hall: locked.length === 1 ? locked[0] : undefined,
      halls: locked.length > 0 ? locked : undefined,
      hallIncludeUnlabeled: boundaries?.includeUnlabeled ?? entry?.hallIncludeUnlabeled,
      hallIncludeGeneral: boundaries?.includeGeneral ?? entry?.hallIncludeGeneral,
      updatedAt: Date.now(),
    });
    this.writeChain = this.writeChain.then(() => this.persist());
  }

  /** 注册档位切换回调(同步调用;回调异常只记日志不阻断写穿)。 */
  setModeChangeHandler(cb: (sessionId: string, oldMode: MemoryMode, newMode: MemoryMode) => void): void {
    this.onModeChange = cb;
  }

  /** 设置会话档位(写穿持久化;持久化失败保持内存态生效)。 */
  set(sessionId: string, mode: MemoryMode): void {
    const old = this.get(sessionId);
    // 已有注入覆盖跨切档保留(档位与注入正交,切档不动覆盖);
    // 域锁定同语义:跨切档保留
    const entry = this.entries.get(sessionId);
    this.entries.set(sessionId, {
      mode,
      recall: entry?.recall,
      hall: entry?.hall,
      halls: entry?.halls,
      hallIncludeUnlabeled: entry?.hallIncludeUnlabeled,
      hallIncludeGeneral: entry?.hallIncludeGeneral,
      updatedAt: Date.now(),
    });
    this.writeChain = this.writeChain.then(() => this.persist());
    if (old !== mode && this.onModeChange) {
      try {
        this.onModeChange(sessionId, old, mode);
      } catch (err) {
        this.logger?.warn(`[memory] 档位切换回调失败: ${errDetail(err)}`);
      }
    }
  }

  /** 等待在途持久化写完成(测试/停机用)。 */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private async persist(): Promise<void> {
    try {
      await ensureDir(path.dirname(this.file));
      await atomicWriteJson(this.file, this.serialize());
      this.persistFailed = false;
    } catch (err) {
      if (!this.persistFailed) {
        this.persistFailed = true;
        this.logger?.warn(`[memory] 会话档位持久化失败(降级内存态): ${errDetail(err)}`);
      }
    }
  }

  private serialize(): ModeFile {
    const now = Date.now();
    // 超期清理 + 条数上限(按 updatedAt 淘汰最旧)
    for (const [sid, e] of this.entries) {
      if (now - e.updatedAt > PRUNE_MS) this.entries.delete(sid);
    }
    while (this.entries.size > MAX_ENTRIES) {
      let oldest: string | undefined;
      let oldestAt = Infinity;
      for (const [sid, e] of this.entries) {
        if (e.updatedAt < oldestAt) {
          oldest = sid;
          oldestAt = e.updatedAt;
        }
      }
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const sessions: Record<string, ModeEntry> = {};
    for (const [sid, e] of this.entries) sessions[sid] = e;
    return { version: 1, sessions };
  }
}
