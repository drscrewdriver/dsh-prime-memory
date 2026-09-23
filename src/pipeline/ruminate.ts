/**
 * 反刍控制器:按用户指令把未蒸馏缓冲冲刷出来,跑一轮 L1 抽取 → L2 场景整合 → L3 画像更新,
 * 可选图谱投影。与 rebuild 不同:不清库、不改 L0、不归档旧产物;仅消化"攒而未蒸馏"的切片。
 *
 * 语义:
 * - 扫描 pending 三桶(auto/chat/work),按会话分组,逐个入队强制蒸馏(force=true);
 * - 蒸馏完成后按族强制 L2(把未整合的残余记录全部落进场景);
 * - L3 画像冷启动更新(hasPersona=false 时自动触发,已有人格则轻量刷新);
 * - 若有图谱投影,新记录自动入队(由 runner 的图谱泵接管)。
 * - 支持中途取消:已蒸馏部分保留,pending 切片中未被消费的维持原状。
 *
 * 调度:任务入队走 runner 的优先级队列(live 任务优先于 ruminate 任务),
 * 不阻塞宿主正常对话。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { L1Store } from '../store/l1.js';
import type { PersonaStore } from '../store/persona.js';
import type { SceneStore } from '../store/scenes.js';
import type { StateStore } from '../store/state.js';
import type { LiveSettingsHandle } from '../settings.js';
import {
  groupPendingBySession,
  loadPending,
  type PendingBuckets,
} from '../store/pending.js';
import type { ConversationMessage, ExtractMode, MemoryFamily, MemoryLogger } from '../types.js';
import { errDetail } from '../util/filelog.js';
import { runSceneConsolidation } from './l2.js';
import { relabelPass, type RelabelStats } from './relabel.js';
import { runPersona } from './l3.js';
import type { MemoryRunner } from './runner.js';

export interface RuminateStatus {
  running: boolean;
  /** 当前阶段:idle / refreshing / distilling / consolidating / updating / done / cancelled / failed */
  phase: string;
  /** 已完成会话数(轻量刷新为已完成步骤数) */
  done: number;
  /** 待处理会话数(轻量刷新为待执行步骤数) */
  total: number;
  /** 蒸馏产出记录总数 */
  recordsBuilt: number;
  /** 当前动作的人类可读描述(L2/L3 单次可达分钟级) */
  detail: string | null;
  /** 标注校验/重标定结果(最后一次反刍/轻量刷新;未执行或旧版为 null)。 */
  relabel: RelabelStats | null;
  /** 子进度:非会话阶段(relabeling)的批次进度,由重标定批回调驱动;离开阶段即清空。 */
  sub: { done: number; total: number; label: string } | null;
  /** 取消请求标志 */
  cancelRequested: boolean;
  /** 开始时间 */
  startedAt: number | null;
  /** 结束时间 */
  finishedAt: number | null;
  /** 错误信息(失败时) */
  error: string | null;
}

const IDLE_STATUS: RuminateStatus = {
  running: false,
  phase: 'idle',
  done: 0,
  total: 0,
  recordsBuilt: 0,
  relabel: null,
  sub: null,
  detail: null,
  cancelRequested: false,
  startedAt: null,
  finishedAt: null,
  error: null,
};

/** 分组 pending 切片为会话列表(含族信息)。 */
interface RuminateSession {
  sessionId: string;
  mode: ExtractMode;
  messages: ConversationMessage[];
}

function groupSessions(buckets: PendingBuckets): RuminateSession[] {
  const sessions: RuminateSession[] = [];
  for (const mode of ['auto' as ExtractMode, 'chat' as ExtractMode, 'work' as ExtractMode]) {
    const groups = groupPendingBySession(buckets[mode]);
    for (const g of groups) {
      if (g.messages.length === 0) continue;
      sessions.push({ sessionId: g.sessionId, mode, messages: g.messages });
    }
  }
  return sessions;
}

export class RuminateController {
  private status: RuminateStatus = IDLE_STATUS;
  private cancelRequested = false;
  /** 启动守卫:置位早于 status.running,封住"await 读取"期间的双击窗口。 */
  private starting = false;
  private sessions: RuminateSession[] = [];
  private totalL1 = 0;
  private pendingFile: string;

  constructor(
    private readonly ctx: Context,
    private readonly cfg: MemoryConfig,
    private readonly runner: Pick<MemoryRunner, 'enqueue' | 'states'>,
    private readonly stores: {
      l1: L1Store;
      scenes: Record<MemoryFamily, SceneStore>;
      persona: Record<MemoryFamily, PersonaStore>;
      state: StateStore;
    },
    private readonly logger: MemoryLogger,
    private readonly live: LiveSettingsHandle,
    pendingFile: string,
  ) {
    this.pendingFile = pendingFile;
  }

  /** 状态快照 */
  getStatus(): RuminateStatus {
    return { ...this.status };
  }

  /**
   * 启动反刍:扫描 pending 三桶,按会话分组,逐个入队蒸馏;完成后强制 L2+L3。
   * 桶形状的唯一权威是 store/pending.ts 的 loadPending——不得在本层再解析该文件。
   */
  async start(): Promise<RuminateStatus> {
    if (this.status.running || this.starting) throw new Error('反刍已在进行中');
    this.starting = true;
    try {
      const liveNow = this.live.get();
      if (!liveNow.enabled || !liveNow.distill) {
        throw new Error('蒸馏开关已关闭,请先开启蒸馏再反刍');
      }
      if (!this.cfg.extract.enabled) {
        throw new Error('部署配置已停用蒸馏(extract.enabled=false),无法反刍');
      }

      // 读取 pending 三桶(loadPending 负责解包 PendingFile 并校验条目)
      const { buckets } = await loadPending(this.pendingFile, this.logger);
      this.sessions = groupSessions(buckets);

      this.cancelRequested = false;
      this.totalL1 = 0;

      if (this.sessions.length === 0) {
        // 没有 pending 切片 → 做 L2/L3 轻量刷新
        return await this.doLightRefresh();
      }

      this.status = {
        ...IDLE_STATUS,
        running: true,
        phase: 'distilling',
        total: this.sessions.length,
        startedAt: Date.now(),
      };

      this.logger.info(`[memory] 反刍开始:${this.sessions.length} 个会话待消化`);
      // 第一个会话入队
      this.doEnqueue(0);
      // 此刻 status.running 已置位,后续并发 start() 由该守卫拦截
      this.starting = false;
      return { ...this.status };
    } catch (err) {
      // 失败必须落状态:否则 status 仍报 idle/error:null,与面板上的报错自相矛盾
      this.status = {
        ...IDLE_STATUS,
        running: false,
        phase: 'failed',
        error: errDetail(err),
        finishedAt: Date.now(),
      };
      this.logger.warn(`[memory] 反刍启动失败: ${errDetail(err)}`);
      throw err;
    } finally {
      this.starting = false;
    }
  }

  /** 请求取消:当前块完成后停止,已蒸馏部分保留。 */
  requestCancel(): RuminateStatus {
    if (!this.status.running) return this.getStatus();
    this.cancelRequested = true;
    this.status.cancelRequested = true;
    this.logger.info('[memory] 反刍取消已请求(当前块完成后停止)');
    return { ...this.status };
  }

  /** 入队一个会话。 */
  private doEnqueue(index: number): void {
    if (this.cancelRequested || index >= this.sessions.length) {
      // 已登记的会话(含被取消截断者)视为已完成,避免 done 恒 0
      this.status.done = index;
      // 收尾
      void this.finalize();
      return;
    }

    const session = this.sessions[index];
    this.status.phase = 'distilling';
    this.status.detail = `L1 蒸馏中:会话 ${session.sessionId}(第 ${index + 1}/${this.sessions.length} 个)`;
    // 真实产出计数:enqueue 只入队,产出由 onTurnDone 在任务真正跑完后回调
    // (此前 totalL1 从不累加,recordsBuilt 与完成日志恒为 0,修复效果无法判定)
    this.runner.enqueue(session.sessionId, session.messages, session.mode, {
      force: true,
      onTurnDone: (records) => {
        this.totalL1 += records;
        this.status.recordsBuilt = this.totalL1;
      },
    });

    // runner 的 drain 是同步循环,给一个 tick 让它消费完再入队下一个
    setImmediate(() => this.doEnqueue(index + 1));
  }

  /** 收尾:强制 L2 + L3。 */
  private async finalize(): Promise<void> {
    try {
      this.status.phase = 'consolidating';
      this.status.detail = 'L2 场景整合(收尾)';

      const liveNow = this.live.get();
      const distillOn = liveNow.enabled && liveNow.distill;

      // 强制 L2:把全部未整合的残余记录落进场景
      if (this.cfg.l2.enabled && distillOn) {
        for (const family of ['chat', 'work'] as const) {
          const fstate = this.runner.states?.[family];
          if (!fstate) continue;
          // 收集本族所有记录(反刍后全部未整合)
          const records = this.stores.l1.list({ family, limit: 500, offset: 0 }).items;
          if (records.length === 0) continue;
          try {
            const t = Date.now();
            await runSceneConsolidation(this.ctx, this.cfg, this.stores.scenes[family], records, this.logger, family);
            if (fstate) {
              fstate.newMemoriesSinceL2 = 0;
              fstate.lastL2At = Date.now();
            }
            this.logger.info(`[memory] 反刍 L2 完成(family=${family},${Date.now() - t}ms,${records.length} 条记录)`);
          } catch (err) {
            this.logger.warn(`[memory] 反刍 L2 失败(family=${family}): ${errDetail(err)}`);
          }
        }
      }

      // 强制 L3:画像更新
      if (this.cfg.l3.enabled && distillOn) {
        this.status.phase = 'updating';
        this.status.detail = 'L3 画像更新';
        for (const family of ['chat', 'work'] as const) {
          try {
            const scenes = await this.stores.scenes[family].list();
            if (scenes.length === 0) continue;
            const fstate = this.runner.states?.[family];
            await runPersona(this.ctx, this.cfg, this.stores.scenes[family], this.stores.persona[family], fstate || undefined, this.logger, family);
            this.logger.info(`[memory] 反刍 L3 完成(family=${family})`);
          } catch (err) {
            this.logger.warn(`[memory] 反刍 L3 失败(family=${family}): ${errDetail(err)}`);
          }
        }
      }

      // 标注校验/重标定:Wing 合法性 + 认知 hall 映射 + 未打标补标 + 涌现标签
      // 批次进度经 onProgress 写入 detail + sub 子进度(非会话阶段的进度由重标批次决定)
      this.status.phase = 'relabeling';
      this.status.detail = '标注校验与重标定(Wing/认知 hall/标签)';
      try {
        this.status.relabel = await relabelPass(
          { ctx: this.ctx, cfg: this.cfg, l1: this.stores.l1, logger: this.logger },
          {},
          {
            progress: (text, done, total) => {
              this.status.detail = text;
              this.status.sub = { done, total, label: '重标定批次' };
            },
          },
        );
        this.status.sub = null;
        const r = this.status.relabel;
        this.logger.info(
          `[memory] 反刍重标定完成:巡检 ${r.checked},补 cogHall ${r.cogHallFixed},非法 wing ${r.wingInvalidFixed},LLM 补 wing ${r.wingLabeled},打 tags ${r.tagged},跳过 ${r.llmSkipped},预算让出 ${r.deferred}`,
        );
      } catch (err) {
        this.status.sub = null;
        // 重标定失败不拖垮反刍整体(蒸馏/L2/L3 产物保留)
        this.logger.warn(`[memory] 反刍重标定失败(不影响本次产物): ${errDetail(err)}`);
      }

      this.status.phase = 'done';
      this.finish(null);
    } catch (err) {
      this.finish(`收尾失败: ${errDetail(err)}`);
    }
  }

  /**
   * 轻量刷新:没有 pending 时仅跑一轮 L2/L3。
   *
   * 为什么必须先置 running/phase:此处每次 runSceneConsolidation/runPersona 都是**真实 LLM 调用**
   * (实测单次可达 70s+),而本方法是 `await` 的、期间 `start()` 一直挂着并占住守卫。
   * 原先不置 running,导致刷新期间界面既无进度也无取消按钮,再点一次只得到"反刍已在进行中"
   * 却看不到任何进展——即用户反馈的"管线进度和状态提示仍然欠缺"。
   * 现在:先把步骤数登记为 total、每完成一步自增 done,并给出当前动作描述(detail)。
   */
  private async doLightRefresh(): Promise<RuminateStatus> {
    const liveNow = this.live.get();
    const distillOn = liveNow.enabled && liveNow.distill;

    // 先算出待执行步骤(每族 L2/L3 各算一步),据此给界面一个真实进度
    const l2Targets: MemoryFamily[] = [];
    if (this.cfg.l2.enabled && distillOn) {
      for (const family of ['chat', 'work'] as const) {
        const fstate = this.runner.states?.[family];
        if (!fstate || fstate.newMemoriesSinceL2 <= 0) continue;
        const records = this.stores.l1.list({ family, limit: 200, offset: 0 }).items;
        if (records.length === 0) continue;
        l2Targets.push(family);
      }
    }
    const l3Targets: MemoryFamily[] = [];
    if (this.cfg.l3.enabled && distillOn) {
      for (const family of ['chat', 'work'] as const) {
        if (!this.runner.states?.[family]) continue;
        l3Targets.push(family);
      }
    }

    this.cancelRequested = false;
    this.status = {
      ...IDLE_STATUS,
      running: true,
      phase: 'refreshing',
      done: 0,
      total: l2Targets.length + l3Targets.length,
      detail: '准备轻量刷新(无未蒸馏缓冲)',
      startedAt: Date.now(),
    };
    this.logger.info(
      `[memory] 反刍轻量刷新开始(pending 无切片):L2 ${l2Targets.length} 族 / L3 ${l3Targets.length} 族`,
    );

    if (l2Targets.length > 0) this.status.phase = 'consolidating';
    for (const family of l2Targets) {
      if (this.cancelRequested) break;
      this.status.detail = `L2 场景整合(${family})`;
      const fstate = this.runner.states?.[family];
      const records = this.stores.l1.list({ family, limit: 200, offset: 0 }).items;
      try {
        await runSceneConsolidation(this.ctx, this.cfg, this.stores.scenes[family], records, this.logger, family);
        // 仅成功后归零:失败时保留计数,留给下一次触发重试(原先先归零会静默吞掉失败)
        if (fstate) {
          fstate.newMemoriesSinceL2 = 0;
          fstate.lastL2At = Date.now();
        }
      } catch (err) {
        this.logger.warn(`[memory] 反刍轻量刷新 L2 失败(family=${family}): ${errDetail(err)}`);
      }
      this.status.done++;
    }

    if (l3Targets.length > 0) this.status.phase = 'updating';
    for (const family of l3Targets) {
      if (this.cancelRequested) break;
      this.status.detail = `L3 画像更新(${family})`;
      const fstate = this.runner.states?.[family];
      try {
        await runPersona(this.ctx, this.cfg, this.stores.scenes[family], this.stores.persona[family], fstate, this.logger, family);
      } catch (err) {
        this.logger.warn(`[memory] 反刍轻量刷新 L3 失败(family=${family}): ${errDetail(err)}`);
      }
      this.status.done++;
    }

    // 轻量刷新同样做标注校验/重标定(有界,失败不影响刷新结果)
    this.status.phase = 'relabeling';
    this.status.detail = '标注校验与重标定(Wing/认知 hall/标签)';
    try {
      this.status.relabel = await relabelPass(
        { ctx: this.ctx, cfg: this.cfg, l1: this.stores.l1, logger: this.logger },
        {},
        {
          progress: (text, done, total) => {
            this.status.detail = text;
            this.status.sub = { done, total, label: '重标定批次' };
          },
        },
      );
      this.status.sub = null;
      this.status.done++;
    } catch (err) {
      this.status.sub = null;
      this.logger.warn(`[memory] 反刍轻量刷新重标定失败(不影响刷新结果): ${errDetail(err)}`);
    }

    this.status.running = false;
    this.status.detail = null;
    this.status.phase = this.cancelRequested ? 'cancelled' : 'done';
    this.status.finishedAt = Date.now();
    const cost = this.status.finishedAt - (this.status.startedAt ?? this.status.finishedAt);
    this.logger.info(
      `[memory] 反刍轻量刷新结束(${this.status.phase}):${this.status.done}/${this.status.total} 步,耗时 ${Math.round(cost / 1000)}s`,
    );
    return this.getStatus();
  }

  private finish(error: string | null): void {
    this.status.running = false;
    this.status.detail = null;
    this.status.phase = this.cancelRequested ? 'cancelled' : 'done';
    this.status.error = error;
    this.status.finishedAt = Date.now();
    this.status.recordsBuilt = this.totalL1;
    const cost = this.status.finishedAt - (this.status.startedAt ?? this.status.finishedAt);
    this.logger.info(
      `[memory] 反刍结束(${this.status.phase}):${this.status.done}/${this.status.total} 会话,产出 ${this.totalL1} 条记录,耗时 ${Math.round(cost / 1000)}s`,
    );
  }
}
