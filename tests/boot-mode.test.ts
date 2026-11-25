/**
 * 两轴启动挡位（injectBootMode / extractBootMode）的行为闸（0.27.9 两轴重构）。
 *
 * 语义钉成两条：
 *   ① resolveSettings 只归一两轴挡位（缺键/非法→'off'），enabled 恒被钉 true，
 *      读侧不折叠挡位到 recall/capture/distill；
 *   ② applyBootMode 在启动期把 on/off 写回对应生效键（inject→recall，
 *      extract→capture+distill），last 不动，且总钉 enabled=true。
 */
import { describe, expect, it } from 'vitest';

import { applyBootMode, resolveSettings, type LiveSettingsHandle } from '../src/settings.js';

describe('resolveSettings 归一两轴启动挡位', () => {
  it('缺键 / 非法值一律归 off（出厂默认关闭）', () => {
    const s = resolveSettings({});
    expect(s.injectBootMode).toBe('off');
    expect(s.extractBootMode).toBe('off');
    expect(resolveSettings({ injectBootMode: 'ON' }).injectBootMode).toBe('off');
    expect(resolveSettings({ extractBootMode: 1 }).extractBootMode).toBe('off');
  });

  it('合法三态原样保留', () => {
    expect(resolveSettings({ injectBootMode: 'on' }).injectBootMode).toBe('on');
    expect(resolveSettings({ injectBootMode: 'last' }).injectBootMode).toBe('last');
    expect(resolveSettings({ extractBootMode: 'off' }).extractBootMode).toBe('off');
  });

  it('总闸 enabled 恒被钉 true（不再作为顶控）', () => {
    expect(resolveSettings({ enabled: false }).enabled).toBe(true);
    expect(resolveSettings({}).enabled).toBe(true);
  });

  it('读侧**不**折叠挡位：recall/capture/distill 只认自己的键', () => {
    expect(resolveSettings({ injectBootMode: 'off', recall: true }).recall).toBe(true);
    expect(resolveSettings({ extractBootMode: 'on', capture: false }).capture).toBe(false);
  });
});

describe('applyBootMode 两轴写回', () => {
  const mk = (value: Record<string, unknown>, writes: Array<Record<string, unknown>>): LiveSettingsHandle => ({
    supported: true,
    get: () => resolveSettings(value),
    update: async (patch) => { writes.push(patch as Record<string, unknown>); },
  });

  it('inject=off + recall=true → 写 { recall:false, enabled:true }', async () => {
    const writes: Array<Record<string, unknown>> = [];
    await applyBootMode(mk({ injectBootMode: 'off', recall: true }, writes), { info: () => {}, warn: () => {} });
    expect(writes[0]).toMatchObject({ recall: false, enabled: true });
  });

  it('extract=off + capture/distill=true → 写 capture:false distill:false', async () => {
    const writes: Array<Record<string, unknown>> = [];
    await applyBootMode(mk({ extractBootMode: 'off', capture: true, distill: true }, writes), { info: () => {}, warn: () => {} });
    expect(writes[0]).toMatchObject({ capture: false, distill: false, enabled: true });
  });

  it('两轴均 last 且生效键已 true → 一次都不写', async () => {
    const writes: Array<Record<string, unknown>> = [];
    await applyBootMode(mk({ injectBootMode: 'last', extractBootMode: 'last', recall: true, capture: true, distill: true }, writes), { info: () => {}, warn: () => {} });
    expect(writes).toEqual([]);
  });

  it('写面抛错 → 吞掉不阻断，走 logger.warn', async () => {
    const warned: string[] = [];
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ injectBootMode: 'off', recall: true }),
      update: async () => { throw new Error('volatile 写面不可用'); },
    };
    await expect(applyBootMode(handle, { info: () => {}, warn: (m) => warned.push(m) })).resolves.toBeUndefined();
    expect(warned.some((m) => m.includes('启动挡位应用失败'))).toBe(true);
  });
});
