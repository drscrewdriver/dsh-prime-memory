/**
 * §C 矛盾冻结 / task_20:决策词表扩充。
 *
 * 承重主张:三份去重 prompt 变体在**冻结开启**时都必须定义 `conflict` 动作,
 * 且要求输出**两个不同**的 `winner`/`loser`——这是「不自动裁决」的唯一入口,
 * 词表里没有它,LLM 就只能 update 覆盖或 merge 合并(见 findings.md §3)。
 *
 * 反向约束(另见 task_23 的零漂移用例):冻结关闭时**不得**注入该词表,
 * prompt 必须与改动前逐字一致。故本文件只断言"开启时存在",
 * "关闭时不存在"由 tests/conflict-freeze-switch.test.ts 守住。
 */
import { describe, expect, it } from 'vitest';

import { getConflictDetectionSystemPrompt } from '../src/prompts/l1-dedup.js';

const MODES = ['chat', 'work', 'auto'] as const;

/** 冻结开启时的 prompt。 */
function frozen(mode: (typeof MODES)[number]): string {
  return getConflictDetectionSystemPrompt(mode, { conflictFreeze: true });
}

describe('§C task_20: 三份变体的决策词表均含 conflict 动作', () => {
  it.each(MODES)('%s 变体定义了 conflict 动作', (mode) => {
    expect(frozen(mode)).toMatch(/- "conflict"：/);
  });

  it.each(MODES)('%s 变体的 action 枚举含 conflict', (mode) => {
    // 取**枚举行本身**断言,而不是全文 includes——全文命中可能来自说明段落,
    // 无法证明输出契约里真的多了这个取值。
    const enumLine = frozen(mode)
      .split('\n')
      .find((l) => l.includes('"action"'));
    expect(enumLine).toBeDefined();
    expect(enumLine).toMatch(/conflict/);
  });

  it.each(MODES)('%s 变体要求输出 winner/loser 两个字段', (mode) => {
    const p = frozen(mode);
    expect(p).toMatch(/"winner"/);
    expect(p).toMatch(/"loser"/);
  });

  it.each(MODES)('%s 变体要求 winner 与 loser 必须不同', (mode) => {
    expect(frozen(mode)).toMatch(/winner[\s\S]{0,80}loser[\s\S]{0,40}(必须不同|不得相同|不能相同)/);
  });

  it.each(MODES)('%s 变体声明 conflict 时不产出合并结果', (mode) => {
    // 冻结的语义是"不覆盖、不合并"——若 prompt 仍要求 conflict 时给 merged_content,
    // 模型会同时给出两套互斥指令,裁决语义被稀释。
    const clause = frozen(mode).slice(frozen(mode).indexOf('## 矛盾冻结动作'));
    expect(clause).not.toBe('');
    expect(clause).toMatch(/不覆盖|不合并/);
  });
});
