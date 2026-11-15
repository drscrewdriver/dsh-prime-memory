/**
 * buildClusterShapeLayout 验收面(星系盘/8 字回环):
 * ① shape='sphere' 与 buildClusterLayoutByAxis 逐位一致(回归钉);
 * ② 确定性:同输入两次逐位一致、与入参顺序无关(逐 id 对齐);
 * ③ disk 盘状:法向(y)散布 < 盘面(x-z)散布——横向盘观感,竖向偏多根治;
 * ④ lemniscate 8 字:x 长轴,y/z 薄层;
 * ⑤ 同 hall 点仍彼此更近(形态不改分组语义)。
 */
import { describe, expect, it } from 'vitest';
import { buildClusterLayoutByAxis, buildClusterShapeLayout } from '../client/src/explorer/projection.js';

const mk = (id: string, type: string, hall?: string) => ({ id, type, ...(hall != null ? { hall } : {}) });
const dist = (L: Map<string, { x: number; y: number; z: number }>, a: string, b: string) => {
  const p = L.get(a)!; const q = L.get(b)!;
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
};
const span = (vals: number[]) => Math.max(...vals) - Math.min(...vals);

describe('buildClusterShapeLayout —— disk / lemniscate', () => {
  const nodes = [
    mk('w1', 'person', 'work'), mk('w2', 'person', 'work'), mk('w3', 'tool', 'work'),
    mk('f1', 'tool', 'finance'), mk('g1', 'tool'), mk('j1', 'person', 'journey'),
    mk('l1', 'person', 'learning'), mk('h1', 'tool', 'health'),
  ];

  it('sphere 与 buildClusterLayoutByAxis 逐位一致(回归钉)', () => {
    const a = buildClusterLayoutByAxis(nodes, 'hall');
    const b = buildClusterShapeLayout(nodes, 'hall', 'sphere');
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('确定性:两次逐位一致;打乱顺序逐 id 对齐不变(disk/lemniscate)', () => {
    for (const shape of ['disk', 'lemniscate'] as const) {
      const r1 = buildClusterShapeLayout(nodes, 'hall', shape);
      const r2 = buildClusterShapeLayout(nodes, 'hall', shape);
      expect([...r1.entries()]).toEqual([...r2.entries()]);
      const r3 = buildClusterShapeLayout([...nodes].reverse(), 'hall', shape);
      for (const [id, v] of r1) expect(r3.get(id)).toEqual(v);
    }
  });

  it('disk:work 簇 y 跨度 < 盘面跨度(横向盘);全图 y 值域 < x 值域一半', () => {
    const L = buildClusterShapeLayout(nodes, 'hall', 'disk');
    const ws = ['w1', 'w2', 'w3'].map((id) => L.get(id)!);
    expect(span(ws.map((p) => p.y))).toBeLessThan(Math.max(span(ws.map((p) => p.x)), span(ws.map((p) => p.z))));
    const ys = [...L.values()].map((p) => p.y);
    const xs = [...L.values()].map((p) => p.x);
    expect(span(ys)).toBeLessThan(span(xs) * 0.5);
  });

  it('lemniscate:x 长轴,y/z 均为薄层', () => {
    const L = buildClusterShapeLayout(nodes, 'hall', 'lemniscate');
    const xs = [...L.values()].map((p) => p.x);
    const ys = [...L.values()].map((p) => p.y);
    const zs = [...L.values()].map((p) => p.z);
    expect(span(ys)).toBeLessThan(span(xs));
    expect(span(zs)).toBeLessThan(span(xs));
  });

  it('形态不改分组语义:disk 下同 hall 点仍彼此更近', () => {
    const L = buildClusterShapeLayout(nodes, 'hall', 'disk');
    const inner = Math.min(dist(L, 'w1', 'w2'), dist(L, 'w1', 'w3'), dist(L, 'w2', 'w3'));
    const cross = dist(L, 'w1', 'f1');
    expect(inner).toBeLessThan(cross);
  });
});
