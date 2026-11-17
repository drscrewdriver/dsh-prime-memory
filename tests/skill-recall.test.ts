/**
 * 技能常驻注入的 per-turn 去重(issue #35)。
 *
 * 与 slot-recall 同款缺陷:注入挂在 `agent/pre-step`(按 step 触发),预算项名为
 * `maxPerTurnBytes` 而实现是每步重建。这里钉住三件事:
 * 1. 同回合多步只注入 1 次;
 * 2. 两个 hook 各自独立记账 —— slot 注入不会把 skill 注入挡掉(反之亦然);
 * 3. 压缩/清空后同回合可重注。
 *
 * 走**真** cordis Context + `ctx.waterfall`,与 slots-recall.test.ts 同脚手架。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { registerSkillRecall } from '../src/hooks/skill-recall.js';
import { registerSlotRecall } from '../src/hooks/slot-recall.js';
import { SkillStore } from '../src/store/skill-store.js';
import { SlotStore } from '../src/store/slots.js';
import type { MemoryConfig } from '../src/config.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryLogger } from '../src/types.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-skill-recall-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as MemoryLogger;
const live = { supported: true, get: () => ({ skillsEnabled: true, recall: true }), update: async () => {} } as unknown as LiveSettingsHandle;

interface Decision {
  kind: string;
  messages: { content?: { type: string; text: string }[]; source?: { kind?: string; form?: string } }[];
}

function makeCfg(over: Partial<{ enabled: boolean; inject: boolean }> = {}): MemoryConfig {
  return {
    slots: { enabled: true, inject: true, maxSlots: 8, maxAlwaysOnBytes: 2048, maxBodyChars: 512 },
    skills: {
      enabled: true,
      inject: true,
      allowPromote: false,
      minSessions: 2,
      minEvidence: 2,
      maxPerTurnBytes: 600,
      maxSkillCatalogBytes: 2000,
      excerptChars: 120,
      idleArchiveDays: 0,
      ...over,
    },
  } as unknown as MemoryConfig;
}

async function setup(cfg = makeCfg(), withSlots = false) {
  const dataDir = join(await tmp(), `r-${Math.random().toString(36).slice(2)}`);
  const skills = new SkillStore(dataDir, noopLogger);
  await skills.init();
  const ctx = new Context();
  const controller = registerSkillRecall(ctx, cfg, skills, noopLogger, live);
  let slotStore: SlotStore | undefined;
  if (withSlots) {
    slotStore = new SlotStore(SlotStore.pathFor(dataDir), noopLogger, { maxSlots: 8, maxBodyChars: 512, maxTitleChars: 60 });
    await slotStore.load();
    registerSlotRecall(ctx, cfg, slotStore, noopLogger, live);
  }
  const baseMessage = { content: [{ type: 'text', text: '用户问题' }] };
  const base: Decision = { kind: 'enter', messages: [baseMessage] };
  const run = async (at: { turn?: number; step?: number; agentId?: string } = {}): Promise<Decision> => {
    const payload = {
      agent: { id: at.agentId ?? 'sess-1' },
      messages: [baseMessage],
      turn: at.turn ?? 1,
      step: at.step ?? 1,
      signal: new AbortController().signal,
    };
    const events = ctx as unknown as {
      waterfall(name: string, payload: unknown, inner: () => Promise<Decision>): Promise<Decision>;
    };
    return events.waterfall('agent/pre-step', payload, async () => base);
  };
  return { skills, ctx, controller, base, run, slotStore };
}

const countSkillInjections = (d: Decision): number =>
  d.messages.filter((m) => m.content?.some((c) => c.text.includes('沉淀的技能'))).length;
const countSlotInjections = (d: Decision): number =>
  d.messages.filter((m) => m.content?.some((c) => c.text.includes('常驻记忆槽位'))).length;

async function seedSkill(skills: SkillStore, title = '发布流程'): Promise<void> {
  await skills.create({ title, body: '先跑测试再发版', status: 'active', injectionTier: 'excerpt' });
}

describe('技能注入 per-turn 去重(issue #35)', () => {
  it('同回合 10 步只注入 1 次(修复前是 10 次)', async () => {
    const { skills, run } = await setup();
    await seedSkill(skills);
    let injected = 0;
    for (let step = 1; step <= 10; step++) {
      injected += countSkillInjections(await run({ turn: 1, step }));
    }
    expect(injected).toBe(1);
  });

  it('跨回合各注入 1 次', async () => {
    const { skills, run } = await setup();
    await seedSkill(skills);
    expect(countSkillInjections(await run({ turn: 1, step: 1 }))).toBe(1);
    expect(countSkillInjections(await run({ turn: 2, step: 1 }))).toBe(1);
    expect(countSkillInjections(await run({ turn: 2, step: 2 }))).toBe(0);
  });

  it('无 active 技能时不烧额度:同回合后续步骤仍能注入', async () => {
    const { skills, run } = await setup();
    expect(countSkillInjections(await run({ turn: 1, step: 1 }))).toBe(0);
    await seedSkill(skills);
    expect(countSkillInjections(await run({ turn: 1, step: 2 }))).toBe(1);
  });

  it('压缩完成后同回合可重注', async () => {
    const { skills, ctx, run } = await setup();
    await seedSkill(skills);
    expect(countSkillInjections(await run({ turn: 1, step: 1 }))).toBe(1);
    expect(countSkillInjections(await run({ turn: 1, step: 2 }))).toBe(0);
    ctx.emit('session/event', { id: 'sess-1' }, { type: 'compaction/end', data: {} });
    expect(countSkillInjections(await run({ turn: 1, step: 3 }))).toBe(1);
  });

  it('agent/created(source=clear)后同回合可重注', async () => {
    const { skills, ctx, run } = await setup();
    await seedSkill(skills);
    await run({ turn: 1, step: 1 });
    ctx.emit('agent/created', { agent: { id: 'sess-1' }, source: 'clear' });
    expect(countSkillInjections(await run({ turn: 1, step: 2 }))).toBe(1);
  });

  it('buildInjection 仍是纯读函数(预算/门控语义不变)', async () => {
    const { skills, controller } = await setup();
    await seedSkill(skills);
    expect(controller.buildInjection()).toContain('[技能·发布流程]');
    const off = await setup(makeCfg({ inject: false }));
    await seedSkill(off.skills);
    expect(off.controller.buildInjection()).toBeNull();
  });
});

describe('两段注入互不遮蔽(独立记账)', () => {
  it('同回合内 slot 与 skill 各注入 1 次', async () => {
    const { skills, run, slotStore } = await setup(makeCfg(), true);
    await seedSkill(skills);
    await slotStore!.upsert({ title: '网络规则', kind: 'rule', pinned: true, body: '上行官方', priority: 90 });
    const first = await run({ turn: 1, step: 1 });
    expect(countSlotInjections(first)).toBe(1);
    expect(countSkillInjections(first)).toBe(1);
    const second = await run({ turn: 1, step: 2 });
    expect(countSlotInjections(second)).toBe(0);
    expect(countSkillInjections(second)).toBe(0);
    // 新回合:两段都回来
    const next = await run({ turn: 2, step: 1 });
    expect(countSlotInjections(next)).toBe(1);
    expect(countSkillInjections(next)).toBe(1);
  });
});
