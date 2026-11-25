/**
 * 两轴启动挡位（injectBootMode / extractBootMode）的行为闸（0.28.1 语义重构）。
 *
 * 新语义：滑块控制新会话默认档位，不碰系统级 recall/capture/distill。
 *   • extract='off' → modes.setDefaultMode('off')
 *   • extract='on' + inject='off' → modes.setDefaultMode('auto') + setDefaultRecall(false)
 *   • 两轴 'on' → modes.setDefaultMode('auto') + setDefaultRecall(undefined)
 *   • 两轴 'last' → 不改
 */
import { describe, expect, it } from 'vitest';

import { applyBootMode, resolveSettings, type LiveSettingsHandle } from '../src/settings.js';

function mkLive(overrides: Record<string, unknown> = {}): LiveSettingsHandle {
  return {
    supported: true,
    get: () => resolveSettings(overrides),
    update: async () => {},
  };
}

describe('resolveSettings 归一两轴启动挡位', () => {
  it('缺键 / 非法值一律归 last（出厂默认跟随上次，新安装即开）', () => {
    const s = resolveSettings({});
    expect(s.injectBootMode).toBe('last');
    expect(s.extractBootMode).toBe('last');
    expect(resolveSettings({ injectBootMode: 'ON' }).injectBootMode).toBe('last');
    expect(resolveSettings({ extractBootMode: 1 }).extractBootMode).toBe('last');
  });

  it('合法三态原样保留', () => {
    expect(resolveSettings({ injectBootMode: 'on' }).injectBootMode).toBe('on');
    expect(resolveSettings({ injectBootMode: 'last' }).injectBootMode).toBe('last');
    expect(resolveSettings({ extractBootMode: 'off' }).extractBootMode).toBe('off');
  });

  it('总闸 enabled 恒被钉 true（不再作为顶控）', () => {
    expect(resolveSettings({ enabled: false }).enabled).toBe(true);
  });
});

describe('applyBootMode 写会话默认档（新语义）', () => {
  it('extract=off → setDefaultMode(off)', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const modes = {
      setDefaultMode: (m: string) => calls.push({ method: 'mode', args: [m] }),
      setDefaultRecall: (r: boolean | undefined) => calls.push({ method: 'recall', args: [r] }),
    };
    await applyBootMode(mkLive({ extractBootMode: 'off', injectBootMode: 'off' }), { info: () => {}, warn: () => {} }, modes);
    expect(calls).toContainEqual({ method: 'mode', args: ['off'] });
    expect(calls).toContainEqual({ method: 'recall', args: [undefined] });
  });

  it('extract=on + inject=off → mode=auto + recall=false（只写不注）', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const modes = {
      setDefaultMode: (m: string) => calls.push({ method: 'mode', args: [m] }),
      setDefaultRecall: (r: boolean | undefined) => calls.push({ method: 'recall', args: [r] }),
    };
    await applyBootMode(mkLive({ extractBootMode: 'on', injectBootMode: 'off' }), { info: () => {}, warn: () => {} }, modes);
    expect(calls).toContainEqual({ method: 'mode', args: ['auto'] });
    expect(calls).toContainEqual({ method: 'recall', args: [false] });
  });

  it('两轴均 on → mode=auto + recall=undefined（跟随全局）', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const modes = {
      setDefaultMode: (m: string) => calls.push({ method: 'mode', args: [m] }),
      setDefaultRecall: (r: boolean | undefined) => calls.push({ method: 'recall', args: [r] }),
    };
    await applyBootMode(mkLive({ extractBootMode: 'on', injectBootMode: 'on' }), { info: () => {}, warn: () => {} }, modes);
    expect(calls).toContainEqual({ method: 'mode', args: ['auto'] });
    expect(calls).toContainEqual({ method: 'recall', args: [undefined] });
  });

  it('两轴均 last → 不改 modes', async () => {
    let called = false;
    const modes = {
      setDefaultMode: () => { called = true; },
      setDefaultRecall: () => { called = true; },
    };
    await applyBootMode(mkLive({ extractBootMode: 'last', injectBootMode: 'last' }), { info: () => {}, warn: () => {} }, modes);
    expect(called).toBe(false);
  });

  it('modes 缺席（老宿主降级）→ 不报错不阻断', async () => {
    await expect(
      applyBootMode(mkLive({ extractBootMode: 'off' }), { info: () => {}, warn: () => {} }, undefined),
    ).resolves.toBeUndefined();
  });

  it('系统级 recall/capture/distill 不被滑块写回', async () => {
    const writes: Record<string, unknown>[] = [];
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ extractBootMode: 'off', injectBootMode: 'off', recall: true, capture: true, distill: true }),
      update: async (patch) => { writes.push(patch as Record<string, unknown>); },
    };
    const modes = { setDefaultMode: () => {}, setDefaultRecall: () => {} };
    await applyBootMode(handle, { info: () => {}, warn: () => {} }, modes);
    // 新语义：不写 recall/capture/distill
    expect(writes.length).toBe(0);
  });
});
