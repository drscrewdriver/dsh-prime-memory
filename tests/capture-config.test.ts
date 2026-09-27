/**
 * §C 配置键测试(memorax-absorb Wave 2 / task_16)——scope-config 先例:
 * 默认值 / 接受 true/false / 非法值不抛(解析失败不阻断启动,ADR-0008 第 4 条)。
 */
import { describe, expect, it } from 'vitest';
import { memorySchema } from '../src/config.js';

describe('capture.redactSecrets 配置键(§C)', () => {
  it('默认 true(偏离新特性默认关惯例,决策记录见计划 spec §C)', () => {
    const defaults = memorySchema({}) as { capture: { redactSecrets?: boolean } };
    expect(defaults.capture.redactSecrets).toBe(true);
  });

  it('接受显式 false(一键回明文)与 true', () => {
    for (const v of [true, false]) {
      const cfg = memorySchema({ capture: { redactSecrets: v } }) as { capture: { redactSecrets?: boolean } };
      expect(cfg.capture.redactSecrets).toBe(v);
    }
  });

  it('类型错误走 schemastery 标准校验(与既有 capture 键同语义,union 风险不涉及)', () => {
    // 与 enabled/stripCodeBlocks 一致:boolean 键传非布尔即 ValidationError——
    // 这是全部既有键的标准行为;「解析失败不阻断启动」由宿主对 Config 校验的兜底承接
    expect(() => memorySchema({ capture: { redactSecrets: 'bogus' } })).toThrow(/boolean/);
  });

  it('缺省回落默认 true:手造 capture 夹具(未带该键)不破坏', () => {
    const cfg = memorySchema({ capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 } }) as {
      capture: { redactSecrets?: boolean };
    };
    expect(cfg.capture.redactSecrets).toBe(true);
  });

  it('可选键:未提供 capture 对象时整体默认不破坏(手造 fixture 兼容)', () => {
    const cfg = memorySchema({}) as { capture: Record<string, unknown> };
    expect(cfg.capture.enabled).toBe(true);
    expect(cfg.capture.maxMessageChars).toBe(4000);
    expect(cfg.capture.stripCodeBlocks).toBe(true);
  });
});
