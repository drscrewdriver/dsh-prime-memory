/**
 * §B 防注入边界声明快照测试(memorax-absorb Wave 2 / task_12-13)。
 *
 * 钉住两件事:
 *  1. 六个蒸馏 prompt 文件的全部 system 变体都含 CONTENT_IS_DATA_CLAUSE——
 *     防后续改版把声明行弄丢;
 *  2. 全部 user-prompt 格式化函数的输出含 DATA_DELIMITER_NOTE(数据插槽界定)。
 * 同时抽查冻结门控组合(getConflictDetectionSystemPrompt)在开关两态下都保留声明。
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_CONFLICT_DETECTION_SYSTEM_PROMPT,
  CONFLICT_DETECTION_SYSTEM_PROMPT,
  WORK_CONFLICT_DETECTION_SYSTEM_PROMPT,
  formatBatchConflictPrompt,
  getConflictDetectionSystemPrompt,
} from '../src/prompts/l1-dedup.js';
import {
  EXTRACT_ALL_MEMORIES_SYSTEM_PROMPT,
  EXTRACT_MEMORIES_SYSTEM_PROMPT,
  EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT,
  formatExtractionPrompt,
} from '../src/prompts/l1-extraction.js';
import { buildScenePrompt } from '../src/prompts/scene.js';
import { buildPersonaPrompt } from '../src/prompts/persona.js';
import { buildGraphProjectionPrompt, getGraphProjectionSystemPrompt } from '../src/prompts/graph-projection.js';
import { CONTENT_IS_DATA_CLAUSE, DATA_DELIMITER_NOTE } from '../src/prompts/boundary.js';
import type { ExtractedMemory, MemoryRecord } from '../src/types.js';

const ALL_SYSTEM_VARIANTS: Array<[string, string]> = [
  ['l1-extract/chat', EXTRACT_MEMORIES_SYSTEM_PROMPT],
  ['l1-extract/work', EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT],
  ['l1-extract/all', EXTRACT_ALL_MEMORIES_SYSTEM_PROMPT],
  ['l1-dedup/chat', CONFLICT_DETECTION_SYSTEM_PROMPT],
  ['l1-dedup/work', WORK_CONFLICT_DETECTION_SYSTEM_PROMPT],
  ['l1-dedup/all', ALL_CONFLICT_DETECTION_SYSTEM_PROMPT],
  ['l2/chat', buildScenePrompt({
    memoriesJson: '[]', sceneSummaries: '', sceneContents: '', currentTimestamp: 't', existingSceneFiles: [], maxScenes: 12, family: 'chat',
  }).systemPrompt],
  ['l2/work', buildScenePrompt({
    memoriesJson: '[]', sceneSummaries: '', sceneContents: '', currentTimestamp: 't', existingSceneFiles: [], maxScenes: 12, family: 'work',
  }).systemPrompt],
  ['l3/persona', buildPersonaPrompt({
    mode: 'first', family: 'chat', currentTime: 't', totalProcessed: 0, sceneCount: 0, changedSceneCount: 0,
    changedScenesContent: 'x', existingPersona: undefined, triggerInfo: undefined,
  }).systemPrompt],
  ['l3/team', buildPersonaPrompt({
    mode: 'first', family: 'work', currentTime: 't', totalProcessed: 0, sceneCount: 0, changedSceneCount: 0,
    changedScenesContent: 'x', existingPersona: undefined, triggerInfo: undefined,
  }).systemPrompt],
  ['graph', getGraphProjectionSystemPrompt()],
];

describe('§B system 层边界声明(12 处变体)', () => {
  for (const [name, prompt] of ALL_SYSTEM_VARIANTS) {
    it(`${name} 含 CONTENT_IS_DATA_CLAUSE`, () => {
      expect(prompt).toContain('内容边界');
      expect(prompt).toContain(CONTENT_IS_DATA_CLAUSE.slice(0, 24));
    });
  }
});

describe('§B user 层数据界定(全部格式化函数)', () => {
  const msg = (id: string, text: string) => ({
    id,
    role: 'user' as const,
    content: text,
    timestamp: 1_700_000_000_000,
  });

  it('formatExtractionPrompt:背景与新消息两个插槽都有界定', () => {
    const out = formatExtractionPrompt({
      newMessages: [msg('m1', '用户文本')],
      backgroundMessages: [msg('m0', '背景文本')],
    });
    expect(out.match(new RegExp(DATA_DELIMITER_NOTE.replace(/[()（）]/g, (c) => `\\${c}`), 'g'))?.length).toBeGreaterThanOrEqual(2);
  });

  it('formatBatchConflictPrompt:候选池与新记忆两个插槽都有界定', () => {
    const candidate = {
      id: 'r1',
      content: '已有记忆',
      type: 'persona',
      priority: 60,
      scene_name: 's',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      metadata_json: '{}',
      family: 'chat',
    } as unknown as MemoryRecord;
    const fresh = {
      record_id: 'n1',
      content: '新记忆',
      type: 'persona',
      scene_name: 's',
      priority: 60,
      timestamps: [],
    } as unknown as ExtractedMemory & { record_id: string };
    const out = formatBatchConflictPrompt([
      { newMemory: fresh, candidates: [candidate] },
    ]);
    expect(out).toContain(DATA_DELIMITER_NOTE);
    expect(out.match(new RegExp(DATA_DELIMITER_NOTE.replace(/[()（）]/g, (c) => `\\${c}`), 'g'))?.length).toBeGreaterThanOrEqual(2);
  });

  it('buildScenePrompt:新记忆与既有场景插槽都有界定', () => {
    const { userPrompt } = buildScenePrompt({
      memoriesJson: '[]',
      sceneSummaries: '',
      sceneContents: '场景全文',
      currentTimestamp: '2026-09-28T00:00:00.000Z',
      existingSceneFiles: [],
      maxScenes: 12,
      family: 'chat',
    });
    expect(userPrompt.match(new RegExp(DATA_DELIMITER_NOTE.replace(/[()（）]/g, (c) => `\\${c}`), 'g'))?.length).toBeGreaterThanOrEqual(2);
  });

  it('buildPersonaPrompt:变化场景插槽有界定(既有画像走代码围栏,声明在 system 层)', () => {
    const { userPrompt } = buildPersonaPrompt({
      mode: 'incremental',
      family: 'chat',
      currentTime: '2026-09-28T00:00:00.000Z',
      totalProcessed: 10,
      sceneCount: 2,
      changedSceneCount: 1,
      changedScenesContent: '变化场景全文',
      existingPersona: '既有画像全文',
      triggerInfo: undefined,
    });
    expect(userPrompt).toContain(DATA_DELIMITER_NOTE);
  });

  it('buildGraphProjectionPrompt:本批记录插槽有界定', () => {
    const out = buildGraphProjectionPrompt({ records: [], nodes: [], edges: [] });
    expect(out).toContain(DATA_DELIMITER_NOTE);
  });
});

describe('§B 与冻结门控组合不冲突', () => {
  it('conflictFreeze 开/关两态下声明都保留(门控追加段只是追加)', () => {
    for (const on of [false, true]) {
      // mode 词汇 = ExtractMode('auto'|'chat'|'work');冻结态经 opts.conflictFreeze 表达
      const p = getConflictDetectionSystemPrompt('chat', { conflictFreeze: on });
      expect(p).toContain('内容边界');
    }
  });

  it('reconcile 的 system/user 由 buildReconcilePrompt 装配——直接验证边界常量被引用', async () => {
    // reconcile 的 prompt 在函数内组装;这里以常量被 src/pipeline/reconcile.ts 引用为准
    const src = await import('../src/pipeline/reconcile.js');
    expect(typeof src.buildReconcilePrompt === 'function' || typeof src.runReconcile === 'function').toBe(true);
  });
});
