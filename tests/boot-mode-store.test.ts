/**
 * BootModeStore（两轴）落盘/读回 + applyBootMode 双轴行为闸（0.27.9 两轴重构）。
 *
 * 核心不变量：宿主 forms.update 会剪掉新增的挡位键（findings F5），故两轴挡位由插件
 * 自有文件承载并跨重启存活；applyBootMode 把 injectBootMode 写回 recall、
 * extractBootMode 写回 capture+distill，并把总闸 enabled 钉 true。
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

describe('BootModeStore 两轴落盘与重启读回', () => {
  it('两轴分别 set 后新建实例（模拟重启）读回同值', async () => {
    const a = new BootModeStore(dir);
    expect(a.get('inject')).toBeUndefined();
    await a.set('inject', 'off');
    await a.set('extract', 'on');
    expect(a.get('inject')).toBe('off');
    expect(a.get('extract')).toBe('on');
    const b = new BootModeStore(dir);
    expect(b.get('inject')).toBe('off');
    expect(b.get('extract')).toBe('on');
  });

  it('非法值不收；同值不重复写', async () => {
    const s = new BootModeStore(dir);
    await s.set('inject', 'bogus' as never);
    expect(s.get('inject')).toBeUndefined();
    await s.set('extract', 'last');
    expect(s.get('extract')).toBe('last');
  });

  it('isBootMode 只认 on/off/last', () => {
    expect(isBootMode('on')).toBe(true);
    expect(isBootMode('last')).toBe(true);
    expect(isBootMode('ON')).toBe(false);
    expect(isBootMode(1)).toBe(false);
  });
});

describe('applyBootMode 写会话默认档（新语义：不写 recall/capture/distill）', () => {
  it('两轴 off → 不写系统级开关，只设 modes.default', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const modeCalls: string[] = [];
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ recall: true, capture: true, distill: true, injectBootMode: 'off', extractBootMode: 'off' }),
      update: async (patch) => { writes.push(patch as Record<string, unknown>); },
      bootModeOf: (axis) => (axis === 'inject' ? 'off' : 'off'),
    };
    const modes = { setDefaultMode: (m: string) => modeCalls.push(m), setDefaultRecall: () => {} };
    await applyBootMode(handle, { info: () => {}, warn: () => {} }, modes);
    expect(writes.length).toBe(0); // 新语义：不写系统级
    expect(modeCalls).toContain('off'); // 会话默认设为 off
  });

  it('两轴均 last → 不改 modes', async () => {
    let called = false;
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ injectBootMode: 'last', extractBootMode: 'last' }),
      update: async () => {},
      bootModeOf: () => undefined,
    };
    const modes = { setDefaultMode: () => { called = true; }, setDefaultRecall: () => { called = true; } };
    await applyBootMode(handle, { info: () => {}, warn: () => {} }, modes);
    expect(called).toBe(false);
  });

  it('extract=on + inject=off → mode=auto + recall=false', async () => {
    const modeCalls: Array<{ m: string; r: boolean | undefined }> = [];
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ injectBootMode: 'off', extractBootMode: 'on' }),
      update: async () => {},
      bootModeOf: () => undefined,
    };
    const modes = {
      setDefaultMode: (m: string) => modeCalls.push({ m, r: undefined }),
      setDefaultRecall: (r: boolean | undefined) => { modeCalls[modeCalls.length - 1] = { ...modeCalls[modeCalls.length - 1], r }; },
    };
    await applyBootMode(handle, { info: () => {}, warn: () => {} }, modes);
    expect(modeCalls[0]?.m).toBe('auto');
    expect(modeCalls[0]?.r).toBe(false);
  });
});
