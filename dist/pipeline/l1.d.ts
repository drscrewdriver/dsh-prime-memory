import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { L1Store } from '../store/l1.js';
import type { MemoryState } from '../store/state.js';
import type { ConversationAnchor, ConversationMessage, ExtractMode, MemoryFamily, MemoryLogger, MemoryRecord } from '../types.js';
export interface ExtractionResult {
    stored: number;
    skipped: boolean;
    sceneName: string;
    newRecords: MemoryRecord[];
}
/** 分族 checkpoint 桶(活引用,改动由调用方 save 落盘)。 */
export type FamilyStates = Record<MemoryFamily, MemoryState>;
/**
 * 按字符预算把消息切成多块(保持顺序,单条超预算独占一块,由 callLLM 兜底截断)。
 * 每条消息按 content 长度 + 64 字符脚手架开销(id/时间戳行)计。
 */
export declare function chunkByCharBudget(messages: ConversationMessage[], budgetChars: number): ConversationMessage[][];
export declare function runExtraction(ctx: Context, cfg: MemoryConfig, store: L1Store, states: FamilyStates, pending: ConversationMessage[], background: ConversationMessage[], logger: MemoryLogger, mode: ExtractMode, 
/**
 * §E 当前工作区标识(由调用方经 `sessionWorkspaceIdOf` 解析;拿不到传 undefined)。
 * 传 undefined 时行为与改动前**逐字一致**——`cfg.scope='global'` 的既有部署
 * 永远走这条分支,这是零漂移的构造性保证。
 */
workspaceId?: string, 
/**
 * R7 锚点映射(`L0 消息 id → 会话坐标`),由调用方经 `buildAnchorMap` 构造。
 * **缺省时行为与改动前逐字一致**——传入的 `pending` 消息若不带锚点(老数据、
 * 未启用捕获侧打戳),`resolveSourceAnchors` 一律返回 undefined,不写 metadata 键。
 */
anchorMap?: ReadonlyMap<string, ConversationAnchor>): Promise<ExtractionResult>;
