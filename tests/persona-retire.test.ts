/**
 * 存量去人格化（task_6.1）：dryRun 默认不写库，摘特征保留内容，摘空才退场。
 *
 * 用假 store 钉行为（真 store 的 reviseInPlace 会嵌入向量、写 JSONL，属集成面）：
 * 这里守的是**判据**——改哪些、退哪些、dryRun 是否真的一字不动。
 */

import { describe, expect, it } from 'vitest';

import { planPersonaRetire, retirePersonaArtifacts, type RetireStoreLike } from '../src/audit/persona-retire.js';
import { PERSONA_LINE_TAGS } from '../src/audit/persona-terms.js';
import type { MemoryRecord } from '../src/types.js';

const TERMS = {
  selfNames: ['本鱼'],
  aliases: ['大肥鱼', '鱼鱼', '鱼', '宝'],
  cardName: '俏皮同伴',
  boundaryLines: [...PERSONA_LINE_TAGS],
  source: 'builtin' as const,
};

function rec(id: string, content: string, name = ''): MemoryRecord {
  return {
    id,
    content,
    type: 'work_fact',
    priority: 50,
    scene_name: '',
    timestamps: [0],
    createdAt: 0,
    updatedAt: 0,
    version: 0,
    source_message_ids: [],
    metadata: {},
    family: 'work',
    scope: 'global',
    workspaceId: '',
    name,
  } as MemoryRecord;
}

const KEEP = '结论：本机已安装 dsh-spirit (v0.9.2)，承担当前会话的“本鱼”人格与第一人称体验记忆功能。';
const PURE = '[角色] 俏皮同伴\n[自称] 本鱼';
const CLEAN = '用户偏好：使用 NeatDownloader 作为下载工具。';

function makeStore(records: MemoryRecord[]): RetireStoreLike & { revised: string[]; retired: string[] } {
  const revised: string[] = [];
  const retired: string[] = [];
  return {
    revised,
    retired,
    getByIds: (ids: string[]) => records.filter((r) => ids.includes(r.id)),
    reviseInPlace: async (record: MemoryRecord) => {
      revised.push(record.id);
      const target = records.find((r) => r.id === record.id);
      if (target) target.content = record.content;
    },
    retire: (ids: string[]) => {
      retired.push(...ids);
      return ids.length;
    },
  };
}

describe('planPersonaRetire（纯计划，不写库）', () => {
  it('分类正确：摘词保留 / 摘空退场 / 干净不动', () => {
    const plan = planPersonaRetire([rec('a', KEEP), rec('b', PURE), rec('c', CLEAN)], TERMS);
    expect(plan.scanned).toBe(3);
    expect(plan.rewritten.map((r) => r.record.id)).toEqual(['a']);
    expect(plan.emptied.map((r) => r.id)).toEqual(['b']);
    expect(plan.rewritten[0]?.content).not.toContain('本鱼');
    expect(plan.rewritten[0]?.content).toContain('第一人称体验记忆功能');
  });
});

describe('retirePersonaArtifacts', () => {
  it('dryRun 默认不写库（两个数组只是预览）', async () => {
    const records = [rec('a', KEEP), rec('b', PURE), rec('c', CLEAN)];
    const store = makeStore(records);
    const out = await retirePersonaArtifacts(store, { dryRun: true, terms: TERMS, records });
    expect(out.applied).toBe(false);
    expect(out.rewritten.map((r) => r.recordId)).toEqual(['a']);
    expect(out.emptied.map((r) => r.recordId)).toEqual(['b']);
    expect(store.revised).toEqual([]);
    expect(store.retired).toEqual([]);
    expect(records[0]?.content).toBe(KEEP);
  });

  it('实跑：改写走 reviseInPlace，摘空走 retire（不是删行）', async () => {
    const records = [rec('a', KEEP), rec('b', PURE), rec('c', CLEAN)];
    const store = makeStore(records);
    const out = await retirePersonaArtifacts(store, { dryRun: false, terms: TERMS, records });
    expect(out.applied).toBe(true);
    expect(store.revised).toEqual(['a']);
    expect(store.retired).toEqual(['b']);
    expect(records[0]?.content).not.toContain('本鱼');
    expect(records[2]?.content).toBe(CLEAN);
  });

  it('recordIds 收窄：只动点名的条目', async () => {
    const records = [rec('a', KEEP), rec('b', PURE)];
    const store = makeStore(records);
    const out = await retirePersonaArtifacts(store, { dryRun: true, terms: TERMS, records, recordIds: ['b'] });
    expect(out.scanned).toBe(1);
    expect(out.emptied.map((r) => r.recordId)).toEqual(['b']);
  });
});
