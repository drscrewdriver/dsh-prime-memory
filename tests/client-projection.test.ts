/**
 * 3D 纯函数层（client/src/explorer/projection.ts）验收面。
 *
 * 钉住的性质（spec S6 / 决策 D1、D3、D6）：
 * ① 确定性：同输入两次调用逐位一致，且与入参顺序无关（用户对"图长什么样"的心智要能积累）；
 * ② ego 语义：焦点在球心、第 k 跳落在第 k 层壳、不可达点不出现、环不死循环、hops 钳制；
 * ③ 透视单调：dist 越小透视系数越大；返回顺序恒为远→近（遮挡正确性的前提）；
 * ④ **亮度双通道**：任何 f 下老化差异都不得被深度通道吞掉（基准页踩过的坑，
 *    单通道写法在拉近后必饱和成 1）；
 * ⑤ 标签 LOD：预算随缩放、远点不标、同格只留高 rank、越界不占名额；
 * ⑥ 过渡插值端点正确、缺项不闪。
 */
import { describe, expect, it } from 'vitest';
import {
  ALPHA_FLOOR,
  AGING_STRETCH_MIN,
  CAM_DEFAULT,
  DEPTH_LIGHT_CAP,
  DIST_MAX,
  DIST_MIN,
  EGO_HOPS_MAX,
  FOCAL,
  SHELL_GAP,
  brightnessFor,
  buildClusterLayout,
  buildEgoLayout,
  clusterOrder,
  labelBudget,
  lerpLayout,
  pickLabels,
  pickNearest,
  phaseOf,
  projectAll,
  radiusFor,
  zoomBy,
  BREATH_PERIOD_MS,
  type LabelCandidate,
  type LayoutNode,
} from '../client/src/explorer/projection.js';

const NODES: LayoutNode[] = [
  { id: 'p1', type: 'person' },
  { id: 'p2', type: 'person' },
  { id: 'j1', type: 'project' },
  { id: 'j2', type: 'project' },
  { id: 't1', type: 'tool' },
  { id: 'x1', type: 'unknown-kind' },
];

const CAM = { ...CAM_DEFAULT };
const VP = { w: 1600, h: 900 };

describe('buildClusterLayout —— 确定性与顺序无关', () => {
  it('同输入两次调用逐位一致', () => {
    const a = buildClusterLayout(NODES);
    const b = buildClusterLayout(NODES);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('打乱入参顺序后每个 id 的坐标不变', () => {
    const a = buildClusterLayout(NODES);
    const b = buildClusterLayout([...NODES].reverse());
    for (const [id, v] of a) expect(b.get(id)).toEqual(v);
  });

  it('同类型点彼此更近（簇存在的判据）', () => {
    const m = buildClusterLayout(NODES);
    const d = (x: { x: number; y: number; z: number }, y: { x: number; y: number; z: number }) =>
      Math.hypot(x.x - y.x, x.y - y.y, x.z - y.z);
    const samePair = d(m.get('p1')!, m.get('p2')!);
    const crossPair = d(m.get('p1')!, m.get('j1')!);
    expect(samePair).toBeLessThan(crossPair);
  });

  it('空输入 → 空 Map，不抛', () => {
    expect(buildClusterLayout([]).size).toBe(0);
  });

  it('clusterOrder：固定表在前、未知类型按 hash 追加，且与入参顺序无关', () => {
    const t = ['tool', 'person', 'zzz', 'aaa'];
    expect(clusterOrder(t).slice(0, 2)).toEqual(['person', 'tool']);
    expect(clusterOrder(t)).toEqual(clusterOrder([...t].reverse()));
  });
});

describe('buildEgoLayout —— 跳数同心壳', () => {
  const adj = new Map<string, readonly string[]>([
    ['a', ['b', 'c']],
    ['b', ['a', 'd']],
    ['c', ['a']],
    ['d', ['b', 'e']],
    ['e', ['d']],
    ['island', []],
  ]);

  it('焦点在球心；第 1 跳半径≈SHELL_GAP、第 2 跳≈2×SHELL_GAP', () => {
    const m = buildEgoLayout(adj, 'a', 2);
    expect(m.get('a')).toEqual({ x: 0, y: 0, z: 0 });
    const r1 = Math.hypot(m.get('b')!.x, m.get('b')!.y, m.get('b')!.z);
    const r2 = Math.hypot(m.get('d')!.x, m.get('d')!.y, m.get('d')!.z);
    // 壳层有 ±9% 抖动，故按区间断言而非精确值
    expect(r1).toBeGreaterThan(SHELL_GAP * 0.85);
    expect(r1).toBeLessThan(SHELL_GAP * 1.15);
    expect(r2).toBeGreaterThan(SHELL_GAP * 1.7);
    expect(r2).toBeLessThan(SHELL_GAP * 2.3);
    expect(r2).toBeGreaterThan(r1);
  });

  it('跳数外的点与不可达点都不出现', () => {
    const m1 = buildEgoLayout(adj, 'a', 1);
    expect([...m1.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(buildEgoLayout(adj, 'a', 5).has('island')).toBe(false);
  });

  it('hops 越界钳制；环状图不死循环', () => {
    const loop = new Map([['x', ['y']], ['y', ['x']]]);
    const m = buildEgoLayout(loop, 'x', 99);
    expect([...m.keys()].sort()).toEqual(['x', 'y']);
    expect(m.get('x')).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('跳数越界钳到上限（3 跳已是主干全貌）', () => {
    const chain = new Map<string, readonly string[]>();
    for (let i = 0; i < 8; i++) chain.set(`c${i}`, [`c${i + 1}`]);
    chain.set('c8', []);
    const m = buildEgoLayout(chain, 'c0', 99);
    expect(m.size).toBe(EGO_HOPS_MAX + 1); // c0..c3
    expect(m.has('c4')).toBe(false);
  });

  it('两次调用逐位一致（确定性）', () => {
    expect([...buildEgoLayout(adj, 'a', 3).entries()]).toEqual([...buildEgoLayout(adj, 'a', 3).entries()]);
  });
});

describe('projectAll —— 透视与深度排序', () => {
  const layout = buildClusterLayout(NODES);

  it('dist 越小透视系数越大（近大远小的单调性）', () => {
    const near = projectAll(layout, { ...CAM, dist: DIST_MIN }, VP);
    const far = projectAll(layout, { ...CAM, dist: DIST_MAX }, VP);
    const avg = (xs: { f: number }[]) => xs.reduce((s, x) => s + x.f, 0) / xs.length;
    expect(avg(near)).toBeGreaterThan(avg(far));
  });

  it('返回顺序恒为 depth 降序（远→近，遮挡正确的前提）', () => {
    const xs = projectAll(layout, CAM, VP);
    for (let i = 1; i < xs.length; i++) expect(xs[i - 1]!.depth).toBeGreaterThanOrEqual(xs[i]!.depth);
  });

  it('drift=false 时时刻 t 不影响结果；true 时 t 会变（活感确实生效）', () => {
    const a = projectAll(layout, CAM, VP, undefined, 0, false);
    const b = projectAll(layout, CAM, VP, undefined, 4321, false);
    expect(a).toEqual(b);
    const c = projectAll(layout, CAM, VP, undefined, 9999, true);
    expect(JSON.stringify(c)).not.toEqual(JSON.stringify(a));
  });

  it('ids 裁剪只投影给定集合（ego 模式用）', () => {
    const xs = projectAll(layout, CAM, VP, ['p1', 'j1']);
    expect(xs.map((x) => x.id).sort()).toEqual(['j1', 'p1']);
  });

  it('未知 id 静默跳过，不抛', () => {
    expect(projectAll(layout, CAM, VP, ['nope'])).toEqual([]);
  });

  it('相机钻进点堆（depth 触到 140 下限）时 f 不炸', () => {
    const tight = new Map([['o', { x: 0, y: 0, z: -DIST_MIN }]]);
    const xs = projectAll(tight, { ...CAM, dist: DIST_MIN }, VP);
    expect(xs[0]!.f).toBeLessThanOrEqual(FOCAL / 140 + 1e-9);
    expect(Number.isFinite(xs[0]!.x)).toBe(true);
  });
});

describe('brightnessFor —— 双通道 + 老化拉伸（基准页踩过的坑钉在这里）', () => {
  it('同一 f 下老化权重必须产生可见差异（拉伸后 0.5 权重→相对亮度 0.45）', () => {
    const fresh = brightnessFor(1.2, 1);
    const stale = brightnessFor(1.2, 0.5);
    expect(stale).toBeLessThan(fresh);
    // 拉伸映射：stretched(a)=0.12+0.88*(a-0.2)/0.8；a=0.5→0.45，a=1→1.0，深度项相消。
    expect(stale / fresh).toBeCloseTo(0.45, 5);
  });

  it('**拉近到透视系数最大时两者仍不相等**（单通道写法就是在这里被吞掉的）', () => {
    const huge = brightnessFor(8, 0.5);      // f 远超日常区间，模拟贴脸
    const hugeBright = brightnessFor(8, 1);
    expect(huge).toBeLessThan(hugeBright);
    expect(hugeBright).toBeCloseTo(DEPTH_LIGHT_CAP, 5);
    expect(huge / hugeBright).toBeCloseTo(0.45, 5);
  });

  it('老化下限 0.2 映射到最暗段（0.12 相对亮度），与剔除线一致', () => {
    const floor = brightnessFor(1.2, AGING_STRETCH_MIN);
    const bright = brightnessFor(1.2, 1);
    expect(floor / bright).toBeCloseTo(0.12, 5);
  });

  it('agingWeight=null（衰减关闭）等价 1；agingOn=false 时忽略权重', () => {
    expect(brightnessFor(1, null)).toBe(brightnessFor(1, undefined));
    expect(brightnessFor(1, null)).toBe(brightnessFor(1, 1));
    expect(brightnessFor(1.5, 0.5, false)).toBe(brightnessFor(1.5, 1, false));
  });

  it('不低于 ALPHA_FLOOR（淡出不是消失）', () => {
    expect(brightnessFor(0.001, 0.5)).toBeGreaterThanOrEqual(ALPHA_FLOOR);
  });
});

describe('半径 / 预算 / 缩放', () => {
  it('半径随 f 单调、强调项放大 1.9 倍、且有下限', () => {
    expect(radiusFor(3, 1.5, false)).toBeGreaterThan(radiusFor(3, 0.8, false));
    expect(radiusFor(3, 1, true) / radiusFor(3, 1, false)).toBeCloseTo(1.9, 5);
    expect(radiusFor(0, 0, false)).toBeGreaterThanOrEqual(0.8);
  });

  it('标签预算：拉近变多、拉远变少，且钳在 [24,280]', () => {
    expect(labelBudget(DIST_MIN)).toBeGreaterThan(labelBudget(DIST_MAX));
    expect(labelBudget(1e9)).toBe(24);
    expect(labelBudget(1)).toBe(280);
    expect(labelBudget(CAM_DEFAULT.dist)).toBe(72);
  });

  it('滚轮缩放钳进 [DIST_MIN, DIST_MAX]', () => {
    let d = CAM_DEFAULT.dist;
    for (let i = 0; i < 80; i++) d = zoomBy(d, -100);
    expect(d).toBe(DIST_MIN);
    for (let i = 0; i < 200; i++) d = zoomBy(d, 100);
    expect(d).toBe(DIST_MAX);
  });
});

describe('pickLabels —— LOD 与网格避让', () => {
  const widthOf = (id: string) => id.length * 6;
  const cand = (id: string, x: number, y: number, rank: number, f = 1): LabelCandidate => ({ id, x, y, f, rank });

  it('预算截断：只留 rank 高者', () => {
    const got = pickLabels([cand('a', 10, 10, 1), cand('b', 900, 400, 9), cand('c', 300, 200, 5)], 2, widthOf, 1600);
    expect(got).toEqual(['b', 'c']);
  });

  it('同格只留一个（高 rank 优先），跨格都留', () => {
    const got = pickLabels([cand('a', 100, 100, 9), cand('b', 104, 100, 1)], 10, widthOf, 1600);
    expect(got).toEqual(['a']);
    const two = pickLabels([cand('a', 100, 100, 9), cand('b', 900, 500, 1)], 10, widthOf, 1600);
    expect(two).toHaveLength(2);
  });

  it('远点（f < 0.55）不标；越右界的标签不占名额', () => {
    expect(pickLabels([cand('far', 100, 100, 9, 0.4)], 10, widthOf, 1600)).toEqual([]);
    expect(pickLabels([cand('edge', 1598, 100, 9)], 10, widthOf, 1600)).toEqual([]);
  });
});

describe('pickNearest / lerpLayout', () => {
  it('阈值内取投影序里第一个命中（序即近→远的反向，故先命中即最近）', () => {
    const xs = [
      { id: 'near', x: 100, y: 100, f: 2, depth: 10 },
      { id: 'far', x: 104, y: 102, f: 0.5, depth: 900 },
    ];
    expect(pickNearest(xs, 101, 101)).toBe('near');
    expect(pickNearest(xs, 700, 700)).toBeNull();
  });

  it('k=0 落在起点、k=1 落在终点、越界钳制', () => {
    const a = new Map([['x', { x: 0, y: 0, z: 0 }]]);
    const b = new Map([['x', { x: 10, y: -20, z: 30 }]]);
    expect(lerpLayout(a, b, 0).get('x')).toEqual({ x: 0, y: 0, z: 0 });
    expect(lerpLayout(a, b, 1).get('x')).toEqual({ x: 10, y: -20, z: 30 });
    expect(lerpLayout(a, b, 5).get('x')).toEqual({ x: 10, y: -20, z: 30 });
    expect(lerpLayout(a, b, -1).get('x')).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('只在目标侧出现的点直接落位（不闪、不从 0 长出来）', () => {
    const a = new Map<string, { x: number; y: number; z: number }>();
    const b = new Map([['new', { x: 5, y: 5, z: 5 }]]);
    expect(lerpLayout(a, b, 0.3).get('new')).toEqual({ x: 5, y: 5, z: 5 });
  });
});

describe('phaseOf / BREATH_PERIOD_MS —— 激活元素呼吸的错相门禁', () => {
  it('呼吸周期 260ms（反光节奏，不是加载动画）', () => {
    expect(BREATH_PERIOD_MS).toBe(260);
  });

  it('反相位门禁（齐闪反例）：相位差 π 的两点 sin 项互补，峰点时刻差 > 0.5', () => {
    const a = (t: number) => 0.5 + 0.5 * Math.sin(t / BREATH_PERIOD_MS + 0);
    const b = (t: number) => 0.5 + 0.5 * Math.sin(t / BREATH_PERIOD_MS + Math.PI);
    // 互补：任意时刻 a+b = 1（一个亮另一个必暗）。
    for (const t of [0, 200, 700, 3000]) {
      expect(a(t) + b(t)).toBeCloseTo(1, 5);
    }
    // 取 sin 峰点（周期×π/2）做拉开断言；t=0 是交点不能做反例。
    expect(Math.abs(a(408.4) - b(408.4))).toBeGreaterThan(0.5);
  });

  it('phaseOf 确定性且落在 [0, 2π)：同 id 恒同相位，不同 id 错相', () => {
    expect(phaseOf('abc')).toBe(phaseOf('abc'));
    expect(phaseOf('abc')).toBeGreaterThanOrEqual(0);
    expect(phaseOf('abc')).toBeLessThan(Math.PI * 2);
    // 批量不同 id 不应全同相位（齐闪即此处失守）。
    const set = new Set(Array.from({ length: 50 }, (_, i) => Math.round(phaseOf(`node-${i}`) * 100)));
    expect(set.size).toBeGreaterThan(40);
  });
});
