/**
 * wing/tags 标注器的**解析契约**回归测试。
 *
 * 这里钉的是一个真实线上事故:提示词要求返回 `"wing"`,但解析读的是 `item.hall`
 * → 每批 20 条全部配对失败 → `out` 恒空 → 反刍日志只增长 llmSkipped 而 wingLabeled 恒为 0,
 * 且**一条错误日志都没有**,排查代价极高(靠 LLM 输出 961 字符反推才定位)。
 *
 * 因此本文件同时钉两件事:
 *   1. 字段名必须是 `wing`(`hall` 是**另一个维度**,其值域与 Wing 不相交);
 *   2. 任何丢弃都必须留痕 —— 静默丢弃是这次事故放大伤害的主因。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig, MemoryLogger, MemoryRecord } from '../src/types.js';

/** LLM 桩:按序吐出预设回复,并记录每次调用的 layer/user(供断言提示词内容)。 */
const llmReplies: string[] = [];
const llmCalls: Array<{ layer?: string; user?: string; system?: string }> = [];

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    callLLM: vi.fn(async (_ctx: unknown, _cfg: unknown, opts: { layer?: string; user?: string; system?: string }) => {
      llmCalls.push({ layer: opts?.layer, user: opts?.user, system: opts?.system });
      return llmReplies.shift() ?? '[]';
    }),
  };
});

const { labelWingChunk, tagChunk } = await import('../src/wing-backfill.js');

const warned: string[] = [];
const logger = {
  info: () => {},
  warn: (m: string) => warned.push(m),
  error: () => {},
  debug: () => {},
} as unknown as MemoryLogger;

const cfg = {} as MemoryConfig;
const ctx = {} as Context;
const CANDIDATES = 'work / relationships / learning / creative / home / health / finance / journey / general';

/** 构造最小可用记录(标注器只用到 id / content)。 */
function rec(id: string, content = '内容'): MemoryRecord {
  return { id, content } as unknown as MemoryRecord;
}

describe('labelWingChunk 解析契约', () => {
  it('读 `wing` 字段:正常返回被接受', async () => {
    warned.length = 0;
    llmReplies.push(JSON.stringify([{ id: 'm1', wing: 'work' }, { id: 'm2', wing: 'health' }]));
    const out = await labelWingChunk(ctx, cfg, logger, [rec('m1'), rec('m2')], CANDIDATES);
    expect(out.map((r) => [r.record.id, r.wing])).toEqual([['m1', 'work'], ['m2', 'health']]);
    expect(warned).toEqual([]);
  });

  it('回归:`hall` 字段必须被拒(线上事故的原始形态)', async () => {
    warned.length = 0;
    // 历史 bug:提示词要 wing,解析读 hall。此回复在旧代码下会被「接受」(因为读 hall),
    // 在新代码下 wing 缺失 → 全部丢弃 —— 这是刻意的:字段名错配不允许被兜底掩盖。
    llmReplies.push(JSON.stringify([{ id: 'm1', hall: 'work' }, { id: 'm2', hall: 'health' }]));
    const out = await labelWingChunk(ctx, cfg, logger, [rec('m1'), rec('m2')], CANDIDATES);
    expect(out).toEqual([]);
    // 必须报「缺少 wing 字段」而非「非法值」——否则下次再换字段名,日志看不出真实原因
    expect(warned.filter((w) => w.includes('缺少 wing 字段'))).toHaveLength(2);
    expect(warned.some((w) => w.includes('实际键=id|hall'))).toBe(true);
  });

  it('认知 hall 的值(facts/events)被枚举校验拒绝', async () => {
    warned.length = 0;
    llmReplies.push(JSON.stringify([{ id: 'm1', wing: 'facts' }, { id: 'm2', wing: 'events' }]));
    const out = await labelWingChunk(ctx, cfg, logger, [rec('m1'), rec('m2')], CANDIDATES);
    expect(out).toEqual([]);
    expect(warned.filter((w) => w.includes('非法 wing 值'))).toHaveLength(2);
  });

  it('id 配对失败被丢弃且**留痕**(不许静默)', async () => {
    warned.length = 0;
    llmReplies.push(JSON.stringify([{ id: 'm1', wing: 'work' }, { id: 'nope', wing: 'work' }]));
    const out = await labelWingChunk(ctx, cfg, logger, [rec('m1')], CANDIDATES);
    expect(out.map((r) => r.record.id)).toEqual(['m1']);
    expect(warned.filter((w) => w.includes('id 配对失败'))).toHaveLength(1);
  });

  it('空数组与非法 JSON 结构不抛异常', async () => {
    warned.length = 0;
    llmReplies.push('[]');
    expect(await labelWingChunk(ctx, cfg, logger, [rec('m1')], CANDIDATES)).toEqual([]);
    llmReplies.push('{"not":"an array"}');
    expect(await labelWingChunk(ctx, cfg, logger, [rec('m1')], CANDIDATES)).toEqual([]);
  });

  it('提示词要求返回 wing 且约束 id 原样照抄(字段名与解析必须同源)', async () => {
    llmCalls.length = 0;
    llmReplies.push('[]');
    await labelWingChunk(ctx, cfg, logger, [rec('m1')], CANDIDATES);
    const sys = llmCalls[0]?.system ?? '';
    expect(sys).toContain('"wing"');
    expect(sys).not.toContain('"hall"');
    expect(sys).toContain('原样照抄');
    // 候选词表必须原样出现在 user 提示里(模型只能从其中选)
    expect(llmCalls[0]?.user).toContain(CANDIDATES);
  });
});

describe('tagChunk 解析契约', () => {
  it('归一 + 校验:大写/非法项被清理,id 配对失败留痕', async () => {
    warned.length = 0;
    llmReplies.push(
      JSON.stringify([
        { id: 'm1', tags: [' GraphQL-Switch ', 'graphql-switch', 'Has Space'] },
        { id: 'nope', tags: ['orphan'] },
      ]),
    );
    const out = await tagChunk(ctx, cfg, logger, [rec('m1')]);
    expect(out.map((r) => [r.record.id, r.tags])).toEqual([['m1', ['graphql-switch']]]);
    expect(warned.filter((w) => w.includes('tags 标注:id 配对失败'))).toHaveLength(1);
  });

  it('归一后仍全部非法时不产出该条(不写入空标签)', async () => {
    warned.length = 0;
    // 注意 `UPPER` 会被归一成 `upper` 而合法 —— 归一(转小写)发生在校验之前。
    // 这里刻意用归一后依然非法的输入。
    llmReplies.push(JSON.stringify([{ id: 'm1', tags: ['-bad', 'Has Space', '', 42, 'under_score'] }]));
    expect(await tagChunk(ctx, cfg, logger, [rec('m1')])).toEqual([]);
  });
});
