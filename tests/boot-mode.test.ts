/**
 * 三态启动挡位（bootMode: on/off/last）的行为闸。
 *
 * 为什么需要这条测试：挡位若在**读侧**折叠，本会话的手动开关就永远失效
 * （挡位 off 时开不了、on 时关不掉）——这是设计上刻意避开的最坏形态。
 * 所以语义被钉成两条：
 *   ① `resolveSettings` 只归一挡位，**不改造 `enabled`**；
 *   ② `applyBootMode` 在启动期把初值写回 `enabled` 一次，写不进去就不动。
 */
import { describe, expect, it } from 'vitest';

import { applyBootMode, resolveSettings, type LiveSettingsHandle } from '../src/settings.js';

function fakeHandle(value: Record<string, unknown>): LiveSettingsHandle & { writes: Array<Record<string, unknown>> } {
  const writes: Array<Record<string, unknown>> = [];
  return {
    supported: true,
    writes,
    get: () => resolveSettings(value),
    update: async (patch) => {
      writes.push(patch as Record<string, unknown>);
    },
  };
}

describe('resolveSettings 归一启动挡位', () => {
  it('缺键 / 非法值一律归 off（出厂默认关闭）', () => {
    expect(resolveSettings({}).bootMode).toBe('off');
    expect(resolveSettings({ bootMode: 'ON' }).bootMode).toBe('off');
    expect(resolveSettings({ bootMode: 1 }).bootMode).toBe('off');
  });

  it('合法三态原样保留', () => {
    expect(resolveSettings({ bootMode: 'on' }).bootMode).toBe('on');
    expect(resolveSettings({ bootMode: 'off' }).bootMode).toBe('off');
    expect(resolveSettings({ bootMode: 'last' }).bootMode).toBe('last');
  });

  it('读侧**不**折叠挡位：enabled 只认自己的键', () => {
    expect(resolveSettings({ bootMode: 'off', enabled: true }).enabled).toBe(true);
    expect(resolveSettings({ bootMode: 'on', enabled: false }).enabled).toBe(false);
  });
});

describe('applyBootMode 启动期写回', () => {
  it('off + enabled=true → 写一次 { enabled: false }', async () => {
    const handle = fakeHandle({ bootMode: 'off', enabled: true });
    await applyBootMode(handle);
    expect(handle.writes).toEqual([{ enabled: false }]);
  });

  it('on + enabled=false → 写一次 { enabled: true }', async () => {
    const handle = fakeHandle({ bootMode: 'on', enabled: false });
    await applyBootMode(handle);
    expect(handle.writes).toEqual([{ enabled: true }]);
  });

  it('last → 一次都不写（跟随上次，绝不动用户值）', async () => {
    const handle = fakeHandle({ bootMode: 'last', enabled: false });
    await applyBootMode(handle);
    expect(handle.writes).toEqual([]);
  });

  it('已经一致 → 不重复写（避免每次启动都往 profile 落一次 diff）', async () => {
    const handle = fakeHandle({ bootMode: 'off', enabled: false });
    await applyBootMode(handle);
    expect(handle.writes).toEqual([]);
  });

  it('写面抛错 → 吞掉，不阻断启动', async () => {
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ bootMode: 'off', enabled: true }),
      update: async () => {
        throw new Error('volatile 写面不可用');
      },
    };
    await expect(applyBootMode(handle)).resolves.toBeUndefined();
  });
});
