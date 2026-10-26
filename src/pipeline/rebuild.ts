/**
 * 重建控制器:从 L0 事实源重新推导 L1/L2/L3(用户主动动作,设置页按钮触发)。
 *
 * 语义(CONTEXT.md「重建」):
 * - L0 永不改动;旧派生层归档保留(records/ scenes/ persona-*.md → *.bak.<ts>,不硬删);
 * - 检索库 L1 清空、checkpoint 原地重置;
 * - 统一按 auto 档、按会话分块重蒸馏;分块经 runner 的低优先级队列让位于正常轮次;
 * - 收尾强制一轮 L2(各族残余记录)+ L3(重建后 hasPersona=false → 冷启动触发)。
 *
 * **保留式清空(task_8c)**:"清空 + 重蒸馏"对**由 L0 派生**的记忆自洽,对
 * **不由 L0 派生**的记忆则是破坏性的:`memory_add` / `memory_import` 写进来的
 * 外部记忆在会话日志里没有对应位置,清掉就再也造不出来。故 `prepare()` 的固定顺序为
 * **读事实源 → 判保留集 → 过闸门 → 快照 → 归档 → 清空 → 放回保留集**;
 * 判据与实测依据见 `rebuild-preserve.ts` 文件头。事实源读不到时**拒绝清空** ——
 * 判不出该保留什么,放行等于静默退化成破坏性重建。
 *
 * 失败语义:准备/归档任一步失败 → phase=failed,绝不拖垮宿主;
 * 单块蒸馏失败继续下一块(消息留在未蒸馏缓冲,下轮对话/重启补跑自愈)。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { resolveDataDir, type MemoryConfig } from '../config.js';
import type { L1Store } from '../store/l1.js';
import { snapshotBeforeClear } from '../store/l1-snapshot.js';
import type { PersonaStore } from '../store/persona.js';
import type { SceneStore } from '../store/scenes.js';
import type { StateStore } from '../store/state.js';
import type { MemoryDb } from '../store/sqlite.js';
import type { LiveSettingsHandle } from '../settings.js';
import type { MemoryFamily, MemoryLogger, MemoryRecord } from '../types.js';
import { errDetail } from '../util/filelog.js';
import { runSceneConsolidation } from './l2.js';
import { runPersona } from './l3.js';
import { describePlan, gateClear, planPreserve, readFactSource, restorePreserved } from './rebuild-preserve.js';
import { effectiveCfg, type MemoryRunner } from './runner.js';
import {
  DrscFactSource,
  LocalL0FactSource,
  type FactSourceProvider,
  type RebuildChunk,
} from './fact-source.js';
import type { DrscClient } from '../clients/drsc.js';

// 事实源与分块语义已在 fact-source.ts（issue #14-B）；这里只做转出，保持旧引用面不变。
export type { FactCoverage, FactEstimate, FactMessage, FactSourceProvider, RebuildChunk } from './fact-source.js';
export { DrscFactSource, groupL0Sessions, LocalL0FactSource } from './fact-source.js';

/** 重建所需的存储子集(l0 不需要——快照直接走 db)。 */
export interface RebuildStores {
  l1: L1Store;
  scenes: Record<MemoryFamily, SceneStore>;
  persona: Record<MemoryFamily, PersonaStore>;
  state: StateStore;
  /**
   * DRSC 客户端（issue #14-B）：仅当 `rebuild.factSource === 'drsc'` 时用到。
   * 缺席时选 drsc 会**显式中止**，不静默回退本地表。
   */
  drsc?: DrscClient;
}

// RebuildPhase/RebuildStatus 来自契约单一事实源;rebuild-* 端点与 client 重建面板
// 共享同一形状。
import type { RebuildPhase, RebuildStatus } from '../contract.js';
export type { RebuildPhase, RebuildStatus } from '../contract.js';

// `RebuildChunk` 与 `groupL0Sessions` 已迁到 pipeline/fact-source.ts（上面已转出）。

/** 抽取调用数下界估算(与 l1.ts 的 perChunk 同式;会话数与字符预算取大)。 */
export function estimateCalls(sessions: number, messages: number, chars: number, maxInputChars: number): number {
  if (messages === 0) return 0;
  const perChunk = Math.max(20_000, maxInputChars - 42_000);
  return Math.max(sessions, Math.ceil((chars + 64 * messages) / perChunk));
}

/**
 * 水位落差**提示**阀值：检索库里晚于 L0 水位的占比超过此值，就要求二次确认。
 *
 * 为什么叫“提示阀值”而不是“拒绝阀值”：L0 写停后这个比例只会单调上升，
 * 拿它做硬门槛等于把重建**永久锁死**（issue #14 原提案的致命缺陷）。
 * 所以它只负责“提醒你正在做什么”，放行靠 `force`；真正的**不丢**由
 * `planPreserve` 的集合判据（`post-watermark`）结构性保证。
 */
export const STALE_RATIO_THRESHOLD = 0.5;

function idleStatus(): RebuildStatus {
  return {
    running: false,
    phase: 'idle',
    done: 0,
    total: 0,
    sessionCount: 0,
    messageCount: 0,
    estCalls: 0,
    recordsBuilt: 0,
    cancelRequested: false,
    startedAt: null,
    finishedAt: null,
    error: null,
    archiveNote: null,
    preserveNote: null,
    rederivableCount: null,
    preserveCount: null,
    factWatermark: null,
  };
}

/** 时间戳后缀(归档命名,秒级防撞)。 */
function stamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export class RebuildController {
  private status: RebuildStatus = idleStatus();
  /**
   * 会话级事实源迭代器（issue #14-B）：不再把全量 L0 正文驻留内存。
   * null = 尚未进入蒸馏 / 已收尾。
   */
  private chunkIter: AsyncIterator<RebuildChunk> | null = null;
  private cancelRequested = false;
  /** 快照时刻(收尾时按它区分重建产物与重建后新对话的记录)。 */
  private rebuildStartMs = 0;

  constructor(
    private readonly ctx: Context,
    private readonly cfg: MemoryConfig,
    private readonly stores: RebuildStores,
    private readonly db: MemoryDb,
    private readonly runner: Pick<MemoryRunner, 'enqueueRebuildTask' | 'runRebuildTurn' | 'states'>,
    private readonly logger: MemoryLogger,
    private readonly live: LiveSettingsHandle,
  ) {}

  /** 状态快照(idle 时附带实时预估与事实源水位,供确认弹窗讲清"会发生什么")。 */
  getStatus(): RebuildStatus {
    if (this.status.phase === 'idle') {
      try {
        const provider = this.provider();
        const est = provider.estimate();
        const cov = provider.coverage();
        return {
          ...this.status,
          sessionCount: est.sessions,
          messageCount: est.messages,
          estCalls: estimateCalls(est.sessions, est.messages, est.chars, effectiveCfg(this.cfg, this.live).llm.maxInputChars),
          factWatermark: cov.untilIso,
        };
      } catch {
        // 事实源未就绪（如选了 drsc 但 collector 未装配）：面板不能因此整块挂，
        // 只把水位置空；真正的错误留给 start() 显式报。
        return { ...this.status, factWatermark: null };
      }
    }
    return { ...this.status };
  }

  /** 尚未处理的会话块数（流式下为估算 `total - done`；未运行时为 0，诊断/冒烟用）。 */
  get chunkCount(): number {
    return this.status.running ? Math.max(0, this.status.total - this.status.done) : 0;
  }

  /**
   * 按 `cfg.rebuild.factSource` 选事实源（issue #14-B）。
   *
   * 选 drsc 但客户端未装配时**显式抛错**，不静默回退本地表 —— “以为用了新源其实还是旧表”
   * 会让用户拿重建结果去判断 DRSC 数据是否完整，那是最坏的误判。
   */
  private provider(): FactSourceProvider {
    if (this.cfg.rebuild?.factSource === 'drsc') {
      const drsc = this.stores.drsc;
      if (!drsc) {
        throw new Error(
          '重建事实源配置为 drsc，但 collector 客户端未装配 —— 已中止且**未动任何数据**。'
          + '请先启用 reference-session-collector，或把 rebuild.factSource 改回 local。',
        );
      }
      return new DrscFactSource(drsc, this.logger);
    }
    return new LocalL0FactSource(this.db, this.logger);
  }

  /**
   * 启动重建(校验后入队准备任务;真正的清库/归档在管线队列里串行执行,避开并发竞态)。
   *
   * `force` 只用于跨过**提示门槛**（水位落差超过 `STALE_RATIO_THRESHOLD` 时的二次确认），
   * 不能跨过唯一那条硬拒：「L0 一条消息都没有、检索库却有记录」—— 那种形状下重建
   * 只会清空、一条也重造不出来，属于纯亏。
   */
  start(force = false): RebuildStatus {
    if (this.status.running) throw new Error('重建已在进行中');
    // drsc 但客户端未装配 → provider() 在这里显式抛（未动任何数据）
    const provider = this.provider();
    const est = provider.estimate();
    const wm = this.db.rebuildWatermark();
    // 同步门只对“能同步报数”的事实源成立（本地 L0）。DRSC 要发请求才知道会话数，
    // known=false 时必须跳过 —— 否则会把“未知”当成“空”直接拒掉。
    if (est.known && est.messages === 0) {
      if (wm.l1Total > 0) {
        throw new Error(
          `本地 L0 一条消息都没有,而检索库有 ${wm.l1Total} 条记忆 ——`
          + 'L0 正文自 T8.4 起已停写,用它重建只会清空检索库、一条也重造不出来。'
          + '已中止重建且**未动任何数据**。若确实需要以其他事实源重建,请先把该事实源接上后重试。',
        );
      }
      throw new Error('L0 无任何消息,无需重建');
    }
    // 水位落差**只做提示**:L0 停写后这个比例会单调上升，硬拒等于永久锁死重建。
    // 真正的“不丢”由 planPreserve 的集合判据结构性保证，这里只负责让用户看清楚。
    if (est.known && !force && wm.l1Total > 0) {
      const ratio = wm.l1After / wm.l1Total;
      if (ratio > STALE_RATIO_THRESHOLD) {
        const pct = Math.round(ratio * 100);
        throw new Error(
          `检索库有 ${wm.l1Total} 条记忆，其中 ${wm.l1After} 条(${pct}%)晚于本地 L0 水位`
          + `${wm.l0Iso ? ` ${wm.l0Iso}` : '(L0 为空)'} —— 这些记忆的原材料已不在本次快照里，`
          + '重建会把它们**原样保留但不再重蒸馏**(不会丢，只是不重造)。'
          + '确认要继续请带 force 重试。',
        );
      }
    }
    this.cancelRequested = false;
    this.chunkIter = null;
    this.status = {
      ...idleStatus(),
      running: true,
      phase: 'preparing',
      sessionCount: est.sessions,
      messageCount: est.messages,
      estCalls: estimateCalls(est.sessions, est.messages, est.chars, effectiveCfg(this.cfg, this.live).llm.maxInputChars),
      startedAt: Date.now(),
      factWatermark: provider.coverage().untilIso,
    };
    this.runner.enqueueRebuildTask(() => this.prepare());
    this.logger.info(
      `[memory] 重建开始:${est.sessions} 个会话 / ${est.messages} 条 L0 消息`
      + `(预计 ≥${this.status.estCalls} 次抽取调用;事实源水位 ${wm.l0Iso ?? '空'};`
      + `检索库 ${wm.l1Total} 条,其中晚于水位 ${wm.l1After} 条)`,
    );
    return { ...this.status };
  }

  /** 请求取消:当前块完成后停止,已重建部分保留并照常收尾 L2/L3。 */
  requestCancel(): RebuildStatus {
    if (!this.status.running) return this.getStatus();
    this.cancelRequested = true;
    this.status.cancelRequested = true;
    this.logger.info('[memory] 重建取消已请求(当前块完成后停止)');
    return { ...this.status };
  }

  private async prepare(): Promise<void> {
    try {
      // 事实源（issue #14-B）：默认本地 L0；drsc 需显式配置且必须有客户端。
      const provider = this.provider();
      // 快照时刻:重建期间新捕获的消息走正常轮次,天然不重不漏
      this.rebuildStartMs = Date.now();
      const est = await provider.prepare();
      if (est.sessions === 0) {
        this.finish('failed', `事实源(${provider.kind})为空，无可重建内容`);
        return;
      }
      this.status.total = est.sessions;
      if (est.messages > 0) this.status.messageCount = est.messages;
      // 本次事实源的**消息 id 集**：判"来源是否还在快照里"的唯一依据。
      // 不取时间:时间差对停写的 L0 会永久走扩（详见 rebuild-preserve 的 post-watermark）。
      // 注意这里**不读正文**：2.5 万条 id 约 1.5MB，而全量正文是 88MB。
      const snapshotIds = await provider.snapshotIds();

      const dataDir = resolveDataDir(this.cfg);

      // ── ① 读事实源 + 判定保留集(必须在 archiveDerived 之前:归档会把 records/ 搬走)──
      const factRead = await readFactSource(path.join(dataDir, 'records'));
      const plan = planPreserve(factRead.records, this.stores.l1.all(), { snapshotIds });
      this.status.rederivableCount = plan.rederivable;
      this.status.preserveCount = plan.preserved.length;

      // ── ② 过闸门:判不出该保留什么时**拒绝清空**(见 rebuild-preserve.ts 文件头)──
      const gate = gateClear(factRead, plan);
      if (!gate.allowed) {
        this.logger.error(`[memory] 重建已中止:${gate.note}`);
        this.finish('failed', gate.note);
        return;
      }

      // ── ③ 先快照后清空:快照失败即终止(此刻还没清任何东西,中止是零代价的)──
      const snap = await snapshotBeforeClear(this.db, dataDir, 'pre-rebuild');
      this.logger.info(
        `[memory] 重建前快照已建:${path.basename(snap.dir)}(${snap.manifest.sections.records.count} 条,哈希 ${snap.manifest.sections.records.hash.slice(0, 8)})`,
      );

      // ── ④ 归档旧派生层(改名不硬删;任一失败即终止——半清半留会破坏"全量重导"语义)──
      const archiveNote = await this.archiveDerived();
      this.status.archiveNote = archiveNote ?? null;

      // ── ⑤ 清检索库 + 重置 checkpoint;归档后重建空目录(records/ 由 appendNew 自动重建)──
      if (!this.db.clearL1()) throw new Error('L1 检索库清空失败');

      // ── ⑥ 把无来源记忆放回:清空后立刻、且在首块蒸馏之前 ——
      //     放回后它们在检索库里,后续 L1 去重候选就能看见它们,不会重复造出新副本。
      const restored = await restorePreserved(this.stores.l1, plan);
      if (restored.missing.length > 0) {
        // 不静默:保留集里没回来的 id 必须点名(它们在快照里,可手工找回)
        this.logger.error(
          `[memory] 保留集恢复不完整:${restored.restored}/${restored.attempted} 条,缺失 ${restored.missing.join(', ')}` +
            `(缺失项仍在本轮快照 ${path.basename(snap.dir)} 中)`,
        );
      }
      this.status.preserveNote = describePlan(plan);

      this.stores.state.reset();
      await this.stores.state.save();
      await Promise.all([
        this.stores.scenes.chat.init(),
        this.stores.scenes.work.init(),
        this.stores.persona.chat.init(),
        this.stores.persona.work.init(),
      ]);

      this.status.phase = 'distilling';
      this.logger.info(
        `[memory] 重建准备完成(归档:${archiveNote ?? '无旧产物'},保留:${this.status.preserveNote},${est.sessions} 个会话块,事实源=${provider.kind})`,
      );
      this.chunkIter = provider.chunks()[Symbol.asyncIterator]();
      this.scheduleNext();
    } catch (err) {
      this.finish('failed', `准备阶段失败: ${errDetail(err)}`);
    }
  }

  /**
   * 分块链:一次只挂一个重建块,跑完再挂下一块——正常轮次可随时插队。
   *
   * 流式版（issue #14-B）：从事实源迭代器拉下一个会话，不再按下标从内存数组取。
   * 内存峰值从"全量正文"降到"单会话"。
   */
  private scheduleNext(): void {
    if (this.cancelRequested) {
      this.runner.enqueueRebuildTask(() => this.finalize());
      return;
    }
    const iter = this.chunkIter;
    if (!iter) {
      this.runner.enqueueRebuildTask(() => this.finalize());
      return;
    }
    this.runner.enqueueRebuildTask(async () => {
      // 入队后开跑前可能已收到取消(等待插队的正常轮次期间),直接跳到收尾
      if (this.cancelRequested) {
        this.runner.enqueueRebuildTask(() => this.finalize());
        return;
      }
      let next: IteratorResult<RebuildChunk>;
      try {
        next = await iter.next();
      } catch (err) {
        // 事实源中途失败**不能**当“跑完了”：那会把“只重建了一部分”报成成功，
        // 而用户会拿这个结论去判断数据是否重新生成。
        this.logger.error(
          `[memory] 重建事实源中断(已完成 ${this.status.done}/${this.status.total} 个会话): ${errDetail(err)}`,
        );
        this.finish('failed', `事实源读取中断: ${errDetail(err)}`);
        return;
      }
      if (next.done === true) {
        this.chunkIter = null;
        this.runner.enqueueRebuildTask(() => this.finalize());
        return;
      }
      const chunk = next.value;
      try {
        const n = await this.runner.runRebuildTurn(chunk.sessionId, chunk.messages);
        this.status.recordsBuilt += n;
      } catch (err) {
        this.logger.warn(`[memory] 重建块失败(session=${chunk.sessionId},跳过继续): ${errDetail(err)}`);
      }
      this.status.done += 1;
      this.scheduleNext();
    });
  }

  private async finalize(): Promise<void> {
    try {
      this.status.phase = 'finalizing';
      const cfg = effectiveCfg(this.cfg, this.live);
      const liveNow = this.live.get();
      const distillOn = liveNow.enabled && liveNow.distill;

      // 强制 L2:把重建窗口内该族尚未整合的残余记录补一轮(正常轮次语义里差几条
      // 不触发是常态,但"重建"应把已有记录全部落进场景)
      if (cfg.l2.enabled && distillOn) {
        for (const family of ['chat', 'work'] as const) {
          const fstate = this.runner.states[family];
          if (fstate.newMemoriesSinceL2 <= 0) continue;
          const leftovers = this.collectRebuildRecords(family);
          if (leftovers.length === 0) continue;
          try {
            const t = Date.now();
            const result = await runSceneConsolidation(this.ctx, cfg, this.stores.scenes[family], leftovers, this.logger, family);
            fstate.lastL2At = Date.now();
            fstate.newMemoriesSinceL2 = 0;
            if (result.personaRequestedReason) fstate.personaRequestedReason = result.personaRequestedReason;
            this.logger.info(`[memory] 重建收尾 L2 完成(family=${family},${Date.now() - t}ms,${leftovers.length} 条残余记录)`);
          } catch (err) {
            this.logger.warn(`[memory] 重建收尾 L2 失败(family=${family}): ${errDetail(err)}`);
          }
        }
      }

      // 强制 L3:checkpoint 已重置(hasPersona=false)→ 冷启动触发;无场景的族跳过
      if (cfg.l3.enabled && distillOn) {
        for (const family of ['chat', 'work'] as const) {
          try {
            const scenes = await this.stores.scenes[family].list();
            if (scenes.length === 0) continue;
            await runPersona(this.ctx, cfg, this.stores.scenes[family], this.stores.persona[family], this.runner.states[family], this.logger, family);
          } catch (err) {
            this.logger.warn(`[memory] 重建收尾 L3 失败(family=${family}): ${errDetail(err)}`);
          }
        }
      }

      await this.stores.state.save();
      this.finish(this.cancelRequested ? 'cancelled' : 'done', null);
    } catch (err) {
      this.finish('failed', `收尾失败: ${errDetail(err)}`);
    }
  }

  /**
   * 收集重建窗口内某族的记录:重建产物全部是新插入(updated==created),
   * 按 updated_time 倒序翻页、越过 rebuildStartMs 即停。
   */
  private collectRebuildRecords(family: MemoryFamily): MemoryRecord[] {
    const out: MemoryRecord[] = [];
    const PAGE = 200;
    for (let offset = 0; ; offset += PAGE) {
      const { items } = this.stores.l1.list({ family, limit: PAGE, offset });
      if (items.length === 0) break;
      let beyond = 0;
      for (const r of items) {
        if (r.createdAt >= this.rebuildStartMs) out.push(r);
        else beyond++;
      }
      if (beyond > 0 || items.length < PAGE) break;
    }
    return out;
  }

  private finish(phase: RebuildPhase, error: string | null): void {
    this.status.running = false;
    this.status.phase = phase;
    this.status.error = error;
    this.status.finishedAt = Date.now();
    // 事实源释放:迭代器持有单会话内存，收尾必须断开（不能滞留到下一次 start 覆盖）。
    // 若它实现了 `return`（异步生成器），顺手关掉，避免上游资源悬着。
    const iter = this.chunkIter as (AsyncIterator<RebuildChunk> & { return?: () => Promise<unknown> }) | null;
    this.chunkIter = null;
    if (iter !== null && typeof iter.return === 'function') {
      void iter.return().catch(() => {});
    }
    const cost = this.status.finishedAt - (this.status.startedAt ?? this.status.finishedAt);
    this.logger.info(
      `[memory] 重建结束(${phase}):${this.status.done}/${this.status.total} 会话,产出 ${this.status.recordsBuilt} 条记录,耗时 ${Math.round(cost / 1000)}s` +
        (error ? `,错误:${error}` : ''),
    );
  }

  /** 归档旧派生层:records/ scenes/ persona-*.md 改名 .bak.<ts>。不存在则跳过。 */
  private async archiveDerived(): Promise<string | undefined> {
    const dataDir = resolveDataDir(this.cfg);
    const ts = stamp();
    const items: Array<[string, string]> = [
      [path.join(dataDir, 'records'), path.join(dataDir, `records.bak.${ts}`)],
      [path.join(dataDir, 'scenes'), path.join(dataDir, `scenes.bak.${ts}`)],
      [path.join(dataDir, 'persona-chat.md'), path.join(dataDir, `persona-chat.md.bak.${ts}`)],
      [path.join(dataDir, 'persona-work.md'), path.join(dataDir, `persona-work.md.bak.${ts}`)],
    ];
    const archived: string[] = [];
    for (const [from, to] of items) {
      try {
        await fs.access(from);
      } catch {
        continue;
      }
      await fs.rename(from, to);
      archived.push(path.basename(to));
    }
    return archived.length > 0 ? archived.join(', ') : undefined;
  }
}
