/**
 * 反刍重标定阶段(relabelPass)测试:机械校验(cogHall 派生补写 / 非法 wing 剥离)+
 * LLM 有界重标(wing 补标 / 涌现标签,注入桩)+ 门控与失败路径。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import { NoopEmbeddingService } from '../src/store/embedding.js';
import { relabelPass } from '../src/pipeline/relabel.js';
import type { MemoryConfig, MemoryLogger, MemoryRecord } from '../src/types.js';
import type { Context } from '@deepseek-ai/cordis';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-relabel-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as MemoryLogger;
const cfg = { hall: { enabled: ['work', 'relationships', 'learning', 'creative', 'home', 'health', 'finance', 'journey'] } } as unknown as MemoryConfig;
const ctx = {} as Context;

async function mkL1(): Promise<L1Store> {
  const root = await tmp();
  const db = new MemoryDb(join(root, `m-${Math.random().toString(36).slice(2)}.db`), 0);
  db.init();
  return new L1Store(root, db, new NoopEmbeddingService());
}

const now = Date.now();
const base = { priority: 60, scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now };

describe('relabelPass 机械校验(零 LLM 部分)', () => {
  it('cogHall 按 type 派生补写;非法 wing 剥离并转入 LLM 队列', async () => {
    const l1 = await mkL1();
    await l1.appendNew([
      { id: 'r1', content: '合法 wing', type: 'work_fact', ...base, metadata: { hall: 'work' } },
      { id: 'r2', content: '非法 wing', type: 'episodic', ...base, metadata: { hall: 'bogus-domain' } },
      { id: 'r3', content: '未打标', type: 'persona', ...base, metadata: {} },
    ]);
    const stats = await relabelPass(
      { ctx, cfg, l1, logger: noopLogger },
      {
        wingLabeler: async (chunk) => chunk.filter((r) => r.id === 'r3').map((r) => ({ record: r, wing: 'creative' })),
        tagger: async (chunk) => chunk.map((r) => ({ record: r, tags: ['Riley-College', 'x_9', 'ok-tag'] })),
      },
    );
    expect(stats.checked).toBe(3);
    expect(stats.cogHallFixed).toBe(3); // 三条都可派生且原本缺失
    expect(stats.wingInvalidFixed).toBe(1);
    expect(stats.wingLabeled).toBe(1);
    expect(stats.tagged).toBe(2); // tagger 桩对整批(r2+r3)都产出标签
    expect(stats.llmSkipped).toBe(1); // r2 在批里但桩未返回

    const byId = new Map(l1.all().map((r) => [r.id, r]));
    expect(byId.get('r1')?.metadata).toMatchObject({ hall: 'work', cogHall: 'facts' });
    expect(byId.get('r2')?.metadata).toMatchObject({ cogHall: 'events' });
    expect(byId.get('r2')?.metadata?.hall).toBeUndefined(); // 非法值已剥离
    expect(byId.get('r3')?.metadata).toMatchObject({ hall: 'creative', cogHall: 'facts' });
    // slug 归一:大写转小写、下划线非法被剔除
    expect(byId.get('r3')?.metadata?.tags).toEqual(['riley-college', 'ok-tag']);
  });

  it('wing.enabled 为空:LLM 部分整体跳过,机械校验照常', async () => {
    const l1 = await mkL1();
    await l1.appendNew([{ id: 'u1', content: '未打标', type: 'episodic', ...base, metadata: {} }]);
    let llmCalled = false;
    const stats = await relabelPass(
      { ctx, cfg: { hall: { enabled: [] } } as unknown as MemoryConfig, l1, logger: noopLogger },
      { wingLabeler: async () => { llmCalled = true; return []; }, tagger: async () => [] },
    );
    expect(llmCalled).toBe(false);
    expect(stats.wingLabeled).toBe(0);
    expect(stats.cogHallFixed).toBe(1); // 机械部分不受 wing.enabled 影响
    expect(l1.all()[0]?.metadata?.cogHall).toBe('events');
  });

  it('空库:零巡检、零 LLM', async () => {
    const l1 = await mkL1();
    let llmCalled = false;
    const stats = await relabelPass(
      { ctx, cfg, l1, logger: noopLogger },
      { wingLabeler: async () => { llmCalled = true; return []; }, tagger: async () => [] },
    );
    expect(stats.checked).toBe(0);
    expect(llmCalled).toBe(false);
  });
});
