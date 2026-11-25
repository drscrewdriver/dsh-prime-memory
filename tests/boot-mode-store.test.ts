/**
 * BootModeStore 的落盘/读回行为闸（0.27.9）。
 *
 * 钉住的核心不变量：宿主 forms.update 会剪掉新增的 bootMode 键（findings F5），
 * 因此挡位必须由插件自有文件承载并跨"进程重启"存活——这里用新建 store 实例
 * 重新读同一目录来模拟重启。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BootModeStore, isBootMode } from '../src/store/boot-mode.js';
import { applyBootMode, resolveSettings, type LiveSettingsHandle } from '../src/settings.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pm-boot-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('BootModeStore 落盘与重启读回', () => {
  it('set 后新建实例（模拟重启）能读回同一挡位', async () => {
    const a = new BootModeStore(dir);
    expect(a.get()).toBeUndefined(); // 首次无存档
    await a.set('off');
    expect(a.get()).toBe('off');
    const b = new BootModeStore(dir);
    expect(b.get()).toBe('off');
  });

  it('非法值不收；同值不重复写', async () => {
    const s = new BootModeStore(dir);
    await s.set('bogus' as never);
    expect(s.get()).toBeUndefined();
    await s.set('on');
    expect(s.get()).toBe('on');
  });

  it('isBootMode 只认 on/off/last', () => {
    expect(isBootMode('on')).toBe(true);
    expect(isBootMode('last')).toBe(true);
    expect(isBootMode('ON')).toBe(false);
    expect(isBootMode(1)).toBe(false);
  });
});

describe('applyBootMode 以插件存档为权威', () => {
  it('存档=off 覆盖 volatile 默认：写回 enabled=false（即使宿主磁盘无 bootMode）', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const handle: LiveSettingsHandle = {
      supported: true,
      // volatile 侧读到出厂默认（模拟宿主剪枝后 bootMode 缺失 → resolveSettings 归 'off'、enabled=true）
      get: () => ({ ...resolveSettings({ enabled: true }), bootMode: 'off' }),
      update: async (patch) => {
        writes.push(patch as Record<string, unknown>);
      },
      readConfig: () => ({ enabled: true }), // 磁盘确实没有 bootMode
      bootModeOf: () => 'off', // 但插件存档有
    };
    const infos: string[] = [];
    await applyBootMode(handle, { info: (m) => infos.push(m), warn: () => {} });
    expect(writes).toEqual([{ enabled: false }]);
    expect(infos.some((m) => m.includes('插件存档'))).toBe(true);
  });

  it('存档存在时不因磁盘缺 bootMode 而触发竞态等待', async () => {
    let waited = false;
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => ({ ...resolveSettings({ enabled: true }), bootMode: 'last' }),
      update: async () => {},
      readConfig: () => ({ enabled: true }), // 磁盘无 bootMode 键
      bootModeOf: () => 'last',
      waitForVolatile: async () => {
        waited = true;
      },
    };
    await applyBootMode(handle, { info: () => {}, warn: () => {} });
    expect(waited).toBe(false); // last 且权威=last，直接沿用不写、不等待
  });
});
