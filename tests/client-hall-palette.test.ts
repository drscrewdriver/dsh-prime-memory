/**
 * hall-palette 纯函数层验收面:
 * ① 防漂移钉:HALL_ORDER 与服务端 WING_CATALOG.map(w=>w.id) 逐项相等;
 * ② defaultHallToken 按序取 chart-1..8、general 不占位;
 * ③ variantOf 确定性:strength=0 逐字节等于基准色、同 id 恒同色、双路独立;
 * ④ HSL 往返稳定。
 */
import { describe, expect, it } from 'vitest';
import { WING_CATALOG, WING_FALLBACK } from '../src/types.js';
import {
  HALL_FALLBACK,
  HALL_LABELS,
  HALL_ORDER,
  defaultHallToken,
  hallLabel,
  hexToHsl,
  hslToHex,
  variantOf,
} from '../client/src/explorer/hall-palette.js';

describe('hall-palette:词表防漂移钉', () => {
  it('HALL_ORDER 与 WING_CATALOG.map(w=>w.id) 逐项相等(漂移即红)', () => {
    expect([...HALL_ORDER]).toEqual(WING_CATALOG.map((w) => w.id));
  });
  it('HALL_FALLBACK 与 WING_FALLBACK 相等', () => {
    expect(HALL_FALLBACK).toBe(WING_FALLBACK);
  });
  it('defaultHallToken:八维按序 chart-1..8;general 复用 chart-8 不占位;未知值落 chart-8', () => {
    HALL_ORDER.forEach((h, i) => expect(defaultHallToken(h)).toBe(`--dsh-mem-chart-${i + 1}`));
    expect(defaultHallToken('general')).toBe('--dsh-mem-chart-8');
    expect(defaultHallToken('ghost-hall')).toBe('--dsh-mem-chart-8');
  });
  it('hallLabel:八维 + general 都有中文名;未知回落 id', () => {
    for (const h of [...HALL_ORDER, 'general']) expect(hallLabel(h)).toBeTruthy();
    expect(hallLabel('ghost')).toBe('ghost');
    expect(Object.keys(HALL_LABELS).length).toBe(9);
  });
});

describe('hall-palette:HSL 往返', () => {
  it('hex→hsl→hex 逐字节稳定(令牌实色样本)', () => {
    const samples = ['#4d6bfe', '#0e9c8f', '#1f9d55', '#a8821c', '#d97a0d', '#d64570', '#7c5cff', '#61666b', '#ffffff', '#04070f'];
    for (const s of samples) {
      const hsl = hexToHsl(s);
      expect(hsl).not.toBeNull();
      expect(hslToHex(hsl!.h, hsl!.s, hsl!.l)).toBe(s.toLowerCase());
    }
  });
  it('非法输入返 null,不猜', () => {
    expect(hexToHsl('not-a-color')).toBeNull();
    expect(hexToHsl('')).toBeNull();
  });
  it('色相环绕归一:359+2 → 1;负角归正', () => {
    expect(hslToHex(361, 50, 50)).toBe(hslToHex(1, 50, 50));
    expect(hslToHex(-30, 50, 50)).toBe(hslToHex(330, 50, 50));
  });
});

describe('hall-palette:variantOf 确定性变异', () => {
  const base = '#4d6bfe';
  it('strength=0 逐字节等于基准色(不走浮点转换)', () => {
    expect(variantOf(base, 'node-1', 0)).toBe(base);
    expect(variantOf(base, 'node-2', 0)).toBe(base);
  });
  it('同 id 恒同色;不同 id 大概率不同色(变异确实发生)', () => {
    expect(variantOf(base, 'n-abc', 0.5)).toBe(variantOf(base, 'n-abc', 0.5));
    const distinct = new Set(Array.from({ length: 40 }, (_, i) => variantOf(base, `node-${i}`, 0.6)));
    expect(distinct.size).toBeGreaterThan(30);
  });
  it('strength 越大偏移越大(0.1 的结果更接近基准色)', () => {
    const h0 = hexToHsl(base)!;
    const small = hexToHsl(variantOf(base, 'n-x', 0.1))!;
    const big = hexToHsl(variantOf(base, 'n-x', 1))!;
    const d0 = Math.abs(small.h - h0.h) + Math.abs(small.l - h0.l);
    const d1 = Math.abs(big.h - h0.h) + Math.abs(big.l - h0.l);
    expect(d1).toBeGreaterThanOrEqual(d0);
  });
  it('双路独立:色相抖动与明度抖动相关性弱(单路会呈斜色带)', () => {
    // 取 60 个点的 (hueDelta, lightDelta),相关系数应明显小于 1
    const h0 = hexToHsl(base)!;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 60; i++) {
      const id = `corr-${i}`;
      const v = hexToHsl(variantOf(base, id, 1))!;
      xs.push(v.h - h0.h);
      ys.push(v.l - h0.l);
    }
    const mx = xs.reduce((a, b) => a + b) / xs.length;
    const my = ys.reduce((a, b) => a + b) / ys.length;
    const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0);
    const sx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
    const sy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
    const corr = cov / (sx * sy);
    expect(Math.abs(corr)).toBeLessThan(0.5);
  });
  it('非法基准色原样返回,不抛', () => {
    expect(variantOf('garbage', 'n', 0.5)).toBe('garbage');
  });
});
