/**
 * L3 画像蒸馏 prompt(first/incremental 双模式,分族词表)。
 *
 * 净室重写说明:本文件的 prompt 文案按重写规格(Phase 2 决策)逐字沿用——
 * prompt 内容直接决定蒸馏质量,是已发布行为的一部分,不属于可自由重写文本。
 */
import type { MemoryFamily } from '../types.js';
export interface PersonaPromptParams {
    mode: 'first' | 'incremental';
    family: MemoryFamily;
    currentTime: string;
    totalProcessed: number;
    sceneCount: number;
    changedSceneCount: number;
    changedScenesContent: string;
    existingPersona?: string;
    triggerInfo?: string;
}
export interface PersonaPromptResult {
    systemPrompt: string;
    userPrompt: string;
}
export declare function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult;
