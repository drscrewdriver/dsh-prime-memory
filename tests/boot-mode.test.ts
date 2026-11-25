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

  it('写面抛错 → 吞掉，不阻断启动（但不再静默：走 logger.warn）', async () => {
    const warned: string[] = [];
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ bootMode: 'off', enabled: true }),
      update: async () => {
        throw new Error('volatile 写面不可用');
      },
    };
    await expect(applyBootMode(handle, { info: () => {}, warn: (m) => warned.push(m) })).resolves.toBeUndefined();
    expect(warned.some((m) => m.includes('启动挡位应用失败'))).toBe(true);
  });
});

describe('applyBootMode 诊断与竞态防护（0.27.9）', () => {
  it('启动固定打印磁盘×运行时对照行；宿主不供 readConfig 时明说无法对照', async () => {
    const infos: string[] = [];
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ bootMode: 'off', enabled: false }),
      update: async () => {},
    };
    await applyBootMode(handle, { info: (m) => infos.push(m), warn: () => {} });
    expect(infos.some((m) => m.includes('启动挡位对照') && m.includes('磁盘侧无法对照'))).toBe(true);
    expect(infos.some((m) => m.includes('已一致,免写回'))).toBe(true);
  });

  it('竞态：磁盘挡位 ≠ 运行挡位 → 等一次 volatile 广播后重读再应用', async () => {
    // 首读 = 出厂默认（patch 未并入）；广播后重读 = 用户真选的 last。
    // 若不等待就会把 enabled 反写成 false（陈旧快照顶掉用户选择）。
    let phase = 0;
    let released = false;
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings(phase === 0 ? { bootMode: 'off', enabled: true } : { bootMode: 'last', enabled: true }),
      update: async () => { phase = 1; },
      readConfig: () => ({ bootMode: 'last', enabled: true }),
      waitForVolatile: async () => { released = true; phase = 1; },
    };
    const infos: string[] = [];
    await applyBootMode(handle, { info: (m) => infos.push(m), warn: () => {} });
    expect(released).toBe(true);
    expect(infos.some((m) => m.includes('挡位竞态信号'))).toBe(true);
    expect(infos.some((m) => m.includes('挡位=last'))).toBe(true);
    // 重读后是 last → 一次都不写
    void phase;
  });

  it('磁盘与运行时一致 → 不等广播，直接按挡位应用', async () => {
    let waited = false;
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ bootMode: 'off', enabled: true }),
      update: async () => {},
      readConfig: () => ({ bootMode: 'off', enabled: true }),
      waitForVolatile: async () => { waited = true; },
    };
    await applyBootMode(handle, { info: () => {}, warn: () => {} });
    expect(waited).toBe(false);
  });
});
