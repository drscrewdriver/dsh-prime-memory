import type { Context } from '@deepseek-ai/cordis';
import { type MemoryConfig } from '../config.js';
import type { L1Store } from '../store/l1.js';
import type { PersonaStore } from '../store/persona.js';
import type { SceneStore } from '../store/scenes.js';
import type { StateStore } from '../store/state.js';
import type { MemoryDb } from '../store/sqlite.js';
import type { LiveSettingsHandle } from '../settings.js';
import type { MemoryFamily, MemoryLogger } from '../types.js';
import { type MemoryRunner } from './runner.js';
import type { DrscClient } from '../clients/drsc.js';
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
import type { RebuildStatus } from '../contract.js';
export type { RebuildPhase, RebuildStatus } from '../contract.js';
/** 抽取调用数下界估算(与 l1.ts 的 perChunk 同式;会话数与字符预算取大)。 */
export declare function estimateCalls(sessions: number, messages: number, chars: number, maxInputChars: number): number;
/**
 * 水位落差**提示**阀值：检索库里晚于 L0 水位的占比超过此值，就要求二次确认。
 *
 * 为什么叫“提示阀值”而不是“拒绝阀值”：L0 写停后这个比例只会单调上升，
 * 拿它做硬门槛等于把重建**永久锁死**（issue #14 原提案的致命缺陷）。
 * 所以它只负责“提醒你正在做什么”，放行靠 `force`；真正的**不丢**由
 * `planPreserve` 的集合判据（`post-watermark`）结构性保证。
 */
export declare const STALE_RATIO_THRESHOLD = 0.5;
export declare class RebuildController {
    private readonly ctx;
    private readonly cfg;
    private readonly stores;
    private readonly db;
    private readonly runner;
    private readonly logger;
    private readonly live;
    private status;
    /**
     * 会话级事实源迭代器（issue #14-B）：不再把全量 L0 正文驻留内存。
     * null = 尚未进入蒸馏 / 已收尾。
     */
    private chunkIter;
    private cancelRequested;
    /** 快照时刻(收尾时按它区分重建产物与重建后新对话的记录)。 */
    private rebuildStartMs;
    constructor(ctx: Context, cfg: MemoryConfig, stores: RebuildStores, db: MemoryDb, runner: Pick<MemoryRunner, 'enqueueRebuildTask' | 'runRebuildTurn' | 'states'>, logger: MemoryLogger, live: LiveSettingsHandle);
    /** 状态快照(idle 时附带实时预估与事实源水位,供确认弹窗讲清"会发生什么")。 */
    getStatus(): RebuildStatus;
    /** 尚未处理的会话块数（流式下为估算 `total - done`；未运行时为 0，诊断/冒烟用）。 */
    get chunkCount(): number;
    /**
     * 按 `cfg.rebuild.factSource` 选事实源（issue #14-B）。
     *
     * 选 drsc 但客户端未装配时**显式抛错**，不静默回退本地表 —— “以为用了新源其实还是旧表”
     * 会让用户拿重建结果去判断 DRSC 数据是否完整，那是最坏的误判。
     */
    private provider;
    /**
     * 启动重建(校验后入队准备任务;真正的清库/归档在管线队列里串行执行,避开并发竞态)。
     *
     * `force` 只用于跨过**提示门槛**（水位落差超过 `STALE_RATIO_THRESHOLD` 时的二次确认），
     * 不能跨过唯一那条硬拒：「L0 一条消息都没有、检索库却有记录」—— 那种形状下重建
     * 只会清空、一条也重造不出来，属于纯亏。
     */
    start(force?: boolean): RebuildStatus;
    /** 请求取消:当前块完成后停止,已重建部分保留并照常收尾 L2/L3。 */
    requestCancel(): RebuildStatus;
    private prepare;
    /**
     * 分块链:一次只挂一个重建块,跑完再挂下一块——正常轮次可随时插队。
     *
     * 流式版（issue #14-B）：从事实源迭代器拉下一个会话，不再按下标从内存数组取。
     * 内存峰值从"全量正文"降到"单会话"。
     */
    private scheduleNext;
    private finalize;
    /**
     * 收集重建窗口内某族的记录:重建产物全部是新插入(updated==created),
     * 按 updated_time 倒序翻页、越过 rebuildStartMs 即停。
     */
    private collectRebuildRecords;
    private finish;
    /** 归档旧派生层:records/ scenes/ persona-*.md 改名 .bak.<ts>。不存在则跳过。 */
    private archiveDerived;
}
