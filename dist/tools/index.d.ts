/**
 * 模型可调用工具:memory_search(L1)、conversation_search(L0)、memory_read_scene(L2/L3)、
 * 高权限 memory_add / memory_delete。
 *
 * 会话档位联动:execute 的 exec.agent 即发起调用的 agent(agent.id === sessionId),
 * memory_search 按会话档位过滤族(auto 不过滤,纯档只查本族);off 档下读类工具统一
 * 返回提示(本会话已对记忆系统隐身)。conversation_search 检索范围保持全库。
 * 只写会话(注入覆盖=关)同款拒读,notice 区分文案——写入走捕获钩子不经工具,
 * 拒读不影响"只写"语义。
 *
 * 写删工具受 live.memoryMutate 高权限门控(默认 false):显式记忆指令语义——
 * 用户说"记得 X" → memory_add;说"忘了/删除该记忆" → memory_delete。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { LiveSettingsHandle } from '../settings.js';
import type { L0Store } from '../store/l0.js';
import type { L1Store } from '../store/l1.js';
import type { PersonaStore } from '../store/persona.js';
import type { SceneStore } from '../store/scenes.js';
import type { SessionModeStore } from '../store/session-modes.js';
import type { MemoryFamily, MemoryLogger } from '../types.js';
export declare function registerMemoryTools(ctx: Context, cfg: MemoryConfig, stores: {
    l0: L0Store;
    l1: L1Store;
    scenes: Record<MemoryFamily, SceneStore>;
    persona: Record<MemoryFamily, PersonaStore>;
}, logger: MemoryLogger, modes: SessionModeStore, live: LiveSettingsHandle): void;
