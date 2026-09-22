/**
 * 激活槽位(active slot)工具面。仅注册三个工具,不改动 tools/index.ts(零侵入)。
 *
 * 门控语义:
 * - memory_slot_list:读,受会话档位门控(与 memory_search 同语义)——off/召回关返回 notice。
 * - memory_slot_write / memory_slot_close:写,受 live.memoryMutate 高权限门控(默认关)。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { LiveSettingsHandle } from '../settings.js';
import type { SessionModeStore } from '../store/session-modes.js';
import type { SlotStore } from '../store/slots.js';
import type { MemoryLogger } from '../types.js';
export declare function registerSlotTools(ctx: Context, cfg: MemoryConfig, slots: SlotStore, logger: MemoryLogger, modes: SessionModeStore, live: LiveSettingsHandle): void;
