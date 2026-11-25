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

describe('applyBootMode 两轴写回', () => {
  it('注入轴 off → recall=false；提取轴 off → capture+distill=false；enabled 钉 true', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ recall: true, capture: true, distill: true, injectBootMode: 'off', extractBootMode: 'off' }),
      update: async (patch) => { writes.push(patch as Record<string, unknown>); },
      bootModeOf: (axis) => (axis === 'inject' ? 'off' : 'off'),
    };
    await applyBootMode(handle, { info: () => {}, warn: () => {} });
    expect(writes.length).toBe(1);
    const w = writes[0] as Record<string, unknown>;
    expect(w.recall).toBe(false);
    expect(w.capture).toBe(false);
    expect(w.distill).toBe(false);
    expect(w.enabled).toBe(true);
  });

  it('两轴均 last → 只钉 enabled，不动 recall/capture/distill', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ recall: true, capture: true, distill: true, injectBootMode: 'last', extractBootMode: 'last' }),
      update: async (patch) => { writes.push(patch as Record<string, unknown>); },
      bootModeOf: () => undefined,
    };
    await applyBootMode(handle, { info: () => {}, warn: () => {} });
    // recall/capture/distill 已是 true，与 last 无冲突；enabled 已 true → 无写回
    expect(writes).toEqual([]);
  });

  it('注入轴 on 而 recall 已 true → 不写 recall；提取轴 off 而 capture=true → 只写提取侧', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const handle: LiveSettingsHandle = {
      supported: true,
      get: () => resolveSettings({ recall: true, capture: true, distill: true, injectBootMode: 'on', extractBootMode: 'off' }),
      update: async (patch) => { writes.push(patch as Record<string, unknown>); },
      bootModeOf: () => undefined,
    };
    await applyBootMode(handle, { info: () => {}, warn: () => {} });
    expect(writes.length).toBe(1);
    const w = writes[0] as Record<string, unknown>;
    expect('recall' in w).toBe(false); // inject=on 与 recall=true 已一致，不写
    expect(w.capture).toBe(false);
    expect(w.distill).toBe(false);
  });
});
