/**
 * L2 场景整合 prompt(文件操作 JSON 词表 + 上限预警 + PERSONA_UPDATE_REQUEST 标记)。
 *
 * 净室重写说明:本文件的 prompt 文案按重写规格(Phase 2 决策)逐字沿用——
 * prompt 内容直接决定蒸馏质量,是已发布行为的一部分,不属于可自由重写文本。
 */
import type { MemoryFamily, SceneSummary } from '../types.js';
export interface ScenePromptParams {
    memoriesJson: string;
    sceneSummaries: string;
    sceneContents: string;
    currentTimestamp: string;
    existingSceneFiles: string[];
    maxScenes: number;
    family: MemoryFamily;
}
export interface ScenePromptResult {
    systemPrompt: string;
    userPrompt: string;
}
/** 文件操作 JSON 契约（LLM 输出 → 工程侧执行）。 */
export interface SceneOp {
    op: 'write' | 'delete';
    path: string;
    content?: string;
}
/**
 * 组装 L2 prompt。sceneSummaries 为摘要文本；sceneContents 为"文件名 + 完整内容"文本块。
 */
export declare function buildScenePrompt(params: ScenePromptParams): ScenePromptResult;
/** 场景摘要文本（供 L2 prompt 与场景导航）。 */
export declare function formatSceneSummaries(scenes: SceneSummary[]): string;
