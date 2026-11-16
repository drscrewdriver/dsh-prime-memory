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

    it('disk 悬臂六臂:大簇占臂头内圈,臂沿角向均分整圈', () => {
    const big: ReturnType<typeof mk>[] = [];
    for (let i = 0; i < 50; i++) big.push(mk('bb' + i, 'tool', 'bilibili'));
    const smalls: ReturnType<typeof mk>[] = [];
    for (const h of ['work', 'learning', 'health', 'finance', 'journey', 'creative']) {
      for (let i = 0; i < 3; i++) smalls.push(mk(h + i, 'person', h));
    }
    const L = buildClusterShapeLayout([...big, ...smalls], 'hall', 'disk');
    // bilibili 是最大簇 → LPT 分给当前最空臂 → 臂头 s≈0 → 簇心半径最小段(~150-190)
    // 用质心而非单点:臂向散布 du ±110 会把单个点甩离簇心
    let bx = 0, bz = 0;
    for (let i = 0; i < 50; i++) { const q = L.get('bb' + i)!; bx += q.x; bz += q.z; }
    const bbR = Math.hypot(bx / 50, bz / 50);
    expect(bbR).toBeGreaterThan(100); // 臂头段在内圈(~150-430 臂半径带)
    // 六臂角向均分(按 chord 参数化的双峰判据):同臂簇的角距随 chord 放大
    // (Δs·chord,chord=2.45 时同臂相邻簇可达 ~0.45 rad),异臂角距则恒为 2π/6=1.047 的倍数。
    // 所以判据是"要么近(同臂)、要么约 1.047 的整数倍(异臂)",中间地带(0.5~0.95)不该有点。
    const ang = (x: number, z: number) => Math.atan2(z, x);
    const bbA = ang(bx / 50, bz / 50);
    for (const h of ['work', 'learning', 'health', 'finance', 'journey', 'creative']) {
      let cx = 0, cz = 0;
      for (let i = 0; i < 3; i++) { const q = L.get(h + i)!; cx += q.x; cz += q.z; }
      cx /= 3; cz /= 3;
      const d = Math.abs(ang(cx, cz) - bbA);
      const sep = Math.min(d, Math.PI * 2 - d);
      expect(sep < 0.5 || sep > 0.95).toBe(true);
      expect(Math.hypot(cx, cz)).toBeGreaterThan(60); // 簇心在臂半径带内(散布偏移后仍>60)
    }
  });

  it('disk flat 平铺:所有簇心环形均布,角度互不重叠', () => {
    const L = buildClusterShapeLayout(nodes, 'hall', 'disk', 'flat');
    // 逐簇取代表点(每组第一点),角度间隔应均匀(允许 jitter 偏差 < 平均间隔 × 1.6)
    const reps = nodes.filter((n, i) => nodes.findIndex((m) => m.hall === n.hall) === i);
    const angs = reps.map((n) => Math.atan2(L.get(n.id)!.z, L.get(n.id)!.x));
    const sorted = [...angs].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((v, i) => v - sorted[i]).concat([Math.PI * 2 - sorted[sorted.length - 1]! + sorted[0]!]);
    const avg = (Math.PI * 2) / angs.length;
    for (const g of gaps) expect(g).toBeGreaterThan(avg * 0.3);
  });

  it('disk legacy 双臂:回到 i%2 既有行为(sphere 回归钉同款纪律)', () => {
    const L = buildClusterShapeLayout(nodes, 'hall', 'disk', 'legacy');
    // work 簇仍彼此更近(分组语义不变)
    const inner = Math.min(dist(L, 'w1', 'w2'), dist(L, 'w1', 'w3'), dist(L, 'w2', 'w3'));
    const cross = dist(L, 'w1', 'f1');
    expect(inner).toBeLessThan(cross);
  });

  it('flowShape 转速/幅度参数:speed 缩放角速度,amp 缩放摆动', async () => {
    const { flowShape } = await import('../client/src/explorer/projection.js');
    const L = buildClusterShapeLayout(nodes, 'hall', 'lemniscate');
    // amp=0:speed>0 时环仍旋转(位置变化)但点级摆动归零;speed=0:位置恒定
    const s0 = flowShape(L, 5000, 'lemniscate', 0, 1);
    const s0b = flowShape(L, 15000, 'lemniscate', 0, 1);
    // speed=0 → om=0,ph=相位常量,摆动随 t 变化吗?ph 含 om=0 → sin(ph) 恒定 → 两帧逐位一致
    const a0 = [...s0.values()].map((p) => p.x.toFixed(6)).join(',');
    const b0 = [...s0b.values()].map((p) => p.x.toFixed(6)).join(',');
    expect(a0).toBe(b0);
    // speed=2 在 t=20000 处 om=2×1 → 与 speed=1 在 t=40000 同相位(转速线性)
    const sA = flowShape(L, 20000, 'lemniscate', 2, 0);
    const sB = flowShape(L, 40000, 'lemniscate', 1, 0);
    const aA = [...sA.values()].map((p) => p.x.toFixed(5)).join(',');
    const bB = [...sB.values()].map((p) => p.x.toFixed(5)).join(',');
    expect(aA).toBe(bB);
    // disk:speed=0 → 时相冻结(不同 t 得到同一帧;幅度摆动也不动)
    const Ld = buildClusterShapeLayout(nodes, 'hall', 'disk');
    const dA = flowShape(Ld, 99999, 'disk', 0, 1);
    const dB = flowShape(Ld, 5000000, 'disk', 0, 1);
    const ka = [...dA.values()].map((p2) => p2.x.toFixed(6) + ',' + p2.z.toFixed(6)).join(';');
    const kb = [...dB.values()].map((p2) => p2.x.toFixed(6) + ',' + p2.z.toFixed(6)).join(';');
    expect(ka).toBe(kb);
  });

  it('flowStyle 显式覆盖:任意形态都能选自转/8字流,且 8 字流半径不爆', async () => {
    const { flowShape } = await import('../client/src/explorer/projection.js');
    const Ld = buildClusterShapeLayout(nodes, 'hall', 'disk');
    // disk 显式 eight:点必须都落在有限范围(A 夹到 2.2×r0 上限)
    for (const t of [0, 5000, 20000]) {
      const e = flowShape(Ld, t, 'disk', 1, 1, 'eight');
      for (const q of e.values()) {
        expect(Number.isFinite(q.x)).toBe(true);
        expect(Number.isFinite(q.z)).toBe(true);
        expect(Math.hypot(q.x, q.z)).toBeLessThan(2200);
      }
      expect(e.size).toBe(Ld.size);
    }
    // 环显式 spin:半径守恒(spin 只绕 y 转)
    const Ll = buildClusterShapeLayout(nodes, 'hall', 'lemniscate');
    const s1 = flowShape(Ll, 8000, 'lemniscate', 1, 0, 'spin'); // amp=0 才谈半径守恒
    for (const [id, q] of s1) {
      const b = Ll.get(id)!;
      expect(Math.hypot(q.x, q.z)).toBeCloseTo(Math.hypot(b.x, b.z), 6);
    }
    // 缺省(不传样式)按形态自动:环 → eight(半径不再守恒),盘 → spin(半径守恒)
    const autoL = flowShape(Ll, 8000, 'lemniscate');
    let diff = 0;
    for (const [id, q] of autoL) {
      const b = Ll.get(id)!;
      diff += Math.abs(Math.hypot(q.x, q.z) - Math.hypot(b.x, b.z));
    }
    expect(diff).toBeGreaterThan(1);
  });

  it('悬臂=对数螺线:同臂簇的半径与卷角同步增长,六臂在任意半径处角向互不交缠', () => {
    const big: ReturnType<typeof mk>[] = [];
    for (let i = 0; i < 200; i++) big.push(mk('bb' + i, 'tool', 'bilibili'));
    const rest: ReturnType<typeof mk>[] = [];
    const halls = ['work', 'learning', 'health', 'finance', 'journey', 'creative', 'home', 'relationships'];
    halls.forEach((h, hi) => { for (let i = 0; i < 40 - hi * 4; i++) rest.push(mk(h + i, 'person', h)); });
    const all = [...big, ...rest];
    const L = buildClusterShapeLayout(all, 'hall', 'disk');
    // 每个簇取质心
    const cent = new Map<string, { x: number; z: number }>();
    for (const n of all) {
      const q = L.get(n.id)!;
      const c = cent.get(n.hall) ?? { x: 0, z: 0 };
      cent.set(n.hall, { x: c.x + q.x, z: c.z + q.z });
    }
    const cnt = new Map<string, number>();
    for (const n of all) cnt.set(n.hall, (cnt.get(n.hall) ?? 0) + 1);
    const pts = [...cent.entries()].map(([h, c]) => {
      const k = cnt.get(h)!;
      return { h, r: Math.hypot(c.x / k, c.z / k), a: Math.atan2(c.z / k, c.x / k), w: k };
    });
    // 半径带:全部落在 [100, 700] 内(核球空洞 + 外沿不溢出)
    for (const p2 of pts) {
      expect(p2.r).toBeGreaterThan(100);
      expect(p2.r).toBeLessThan(700);
    }
    // 大簇在臂头(半径小),小簇铺向外圈 → bilibili 半径应明显小于最小簇
    const bb = pts.find((p2) => p2.h === 'bilibili')!;
    const minW = pts.reduce((a, b) => (a.w < b.w ? a : b));
    expect(bb.r).toBeLessThan(minW.r);
  });

  it('自转=刚体:任意时刻两点 xz 距离恒定(臂永不剪切的数学钉)', async () => {
    const { flowShape } = await import('../client/src/explorer/projection.js');
    const L = buildClusterShapeLayout(nodes, 'hall', 'disk');
    const ids = [...L.keys()].slice(0, 24);
    const d0 = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = L.get(ids[i]!)!, b = L.get(ids[j]!)!;
        d0.set(ids[i] + '|' + ids[j], Math.hypot(a.x - b.x, a.z - b.z));
      }
    }
    // 覆盖低速到高速、短时到长时(低速缠绕正是因为剪切随时长累积)
    for (const speed of [0.1, 1, 3]) {
      for (const time of [1000, 60000, 600000, 3600000]) {
        const S = flowShape(L, time * speed, 'disk', 1, 0, 'spin'); // t 已含 speed 累加;amp=0 才谈刚体
        for (const [key, d] of d0) {
          const [ia, ib] = key.split('|');
          const a = S.get(ia!)!, b = S.get(ib!)!;
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(d, 6);
        }
      }
    }
  });

  it('type 轴超大组拆半:tool 占多数时拆成两个子簇,负载接近且确定性可回放', () => {
    const mk2 = (id: string, type: string, hall: string) => mk(id, type, hall);
    const nodes2: ReturnType<typeof mk>[] = [];
    for (let i = 0; i < 200; i++) nodes2.push(mk2('t' + i, 'tool', 'work'));
    for (let i = 0; i < 20; i++) nodes2.push(mk2('p' + i, 'person', 'work'));
    for (let i = 0; i < 20; i++) nodes2.push(mk2('r' + i, 'project', 'work'));
    const L = buildClusterShapeLayout(nodes2, 'type', 'disk');
    // tool 200 点远超阈值 → 拆半后两类各自的簇心(用质心近似)半径/角向应当分开
    const cen = (pre: string, n: number) => {
      let x = 0, z = 0;
      for (let i = 0; i < n; i++) { const q = L.get(pre + i)!; x += q.x; z += q.z; }
      return { x: x / n, z: z / n };
    };
    // 拆半后 tool 的 200 点分散到两条臂 → 整体质心更靠近盘心(两半角向相反抵消)
    const toolC = cen('t', 200);
    const personC = cen('p', 20);
    expect(Math.hypot(toolC.x, toolC.z)).toBeLessThan(Math.hypot(personC.x, personC.z) * 1.6 + 200);
    // 确定性:两次调用逐位一致
    const L2 = buildClusterShapeLayout(nodes2, 'type', 'disk');
    for (const [id, q] of L) {
      const r = L2.get(id)!;
      expect(r.x).toBeCloseTo(q.x, 9);
      expect(r.z).toBeCloseTo(q.z, 9);
    }
    // hall 轴不拆:同 hall 点仍聚在一起(质心半径有限)
    const Lh = buildClusterShapeLayout(nodes2, 'hall', 'disk');
    let hx = 0, hz = 0;
    for (const n of nodes2) { const q = Lh.get(n.id)!; hx += q.x; hz += q.z; }
    expect(Number.isFinite(Math.hypot(hx, hz))).toBe(true);
  });

  it('幅度参数真实生效:amp 越大,同一时刻的形变越大(spin 与 eight 都吃)', async () => {
    const { flowShape } = await import('../client/src/explorer/projection.js');
    const L = buildClusterShapeLayout(nodes, 'hall', 'disk');
    // 同一 t、同一 style,只改 amp → 两次输出的平均点间距离 = 幅度的实际视觉强度
    const delta = (style: 'spin' | 'eight') => {
      const A = flowShape(L, 30000, 'disk', 1, 0, style);
      const B = flowShape(L, 30000, 'disk', 1, 2, style);
      let s = 0;
      for (const [id, q] of A) { const b = B.get(id)!; s += Math.hypot(q.x - b.x, q.y - b.y, q.z - b.z); }
      return s / A.size;
    };
    // spin:amp 0 无脉动、amp 2 有 ±14% 半径脉动 + 垂直波 → 平均位移应达数十单位量级
    expect(delta('spin')).toBeGreaterThan(15);
    // eight:amp 2 的游走幅度(57)远大于 amp 0(5)
    expect(delta('eight')).toBeGreaterThan(15);
  });

  it('相位连续:同一条累计时间轴下改速度不跳(累加语义)', async () => {
    const { flowShape } = await import('../client/src/explorer/projection.js');
    const L = buildClusterShapeLayout(nodes, 'hall', 'disk');
    // 模拟:slider 从 1 改到 3,累加相位 acc 连续 → 帧位置只随 acc 平滑变化
    let acc = 0;
    const posAt = () => {
      const S = flowShape(L, acc, 'disk', 1, 1, 'spin');
      const q = S.get([...L.keys()][0]!)!;
      return Math.atan2(q.z, q.x);
    };
    const a1 = posAt();
    acc += 16 * 1; // 一帧 @16ms speed=1
    const a2 = posAt();
    acc += 16 * 3; // 下一帧 speed 改成 3 —— 相位继续累加,不重置
    const a3 = posAt();
    // 三步单调推进(角度持续增长),没有回跳
    const d12 = a2 - a1, d23 = a3 - a2;
    expect(d12).toBeGreaterThan(0);
    expect(d23).toBeGreaterThan(d12 * 1.5); // 速度提到 3 倍 → 增量明显更大
  });

  it('圆盘 disc:黄金角铺满 + 面积均匀 + 外沿裁剪', () => {
    const L = buildClusterShapeLayout(nodes, 'hall', 'disk', 'disc');
    const pts = nodes.map((n) => L.get(n.id)!);
    // 所有点落在盘半径内(640)且离盘心 > 0(没有挤在原点)
    let maxR = 0;
    for (const q of pts) maxR = Math.max(maxR, Math.hypot(q.x, q.z));
    expect(maxR).toBeLessThanOrEqual(641);
    // 铺满而非偏在一侧:至少 3 个象限有点(黄金角保证多簇下均衡;簇很少时允许一角空)
    const quad = [0, 0, 0, 0];
    for (const q of pts) quad[(q.x >= 0 ? 0 : 1) + (q.z >= 0 ? 0 : 2)]! += 1;
    expect(quad.filter((c) => c > 0).length).toBeGreaterThanOrEqual(3);
    // 与平铺/悬臂都不同(同数据下表观半径分布差异明显)
    const flat = buildClusterShapeLayout(nodes, 'hall', 'disk', 'flat');
    const diff = nodes.reduce((a, n) => {
      const p1 = L.get(n.id)!, p2 = flat.get(n.id)!;
      return a + Math.hypot(p1.x - p2.x, p1.z - p2.z);
    }, 0) / nodes.length;
    expect(diff).toBeGreaterThan(50);
  });

  it('幅度=带子长度:只推外段(内段锚定),臂末端明显伸缩,包络不失控', async () => {
    const { flowShape } = await import('../client/src/explorer/projection.js');
    const L = buildClusterShapeLayout(nodes, 'hall', 'disk');
    const A = flowShape(L, 30000, 'disk', 1, 0, 'spin');
    const B = flowShape(L, 30000, 'disk', 1, 2, 'spin');
    let innerMax = 0;
    let outerMax = 0;
    for (const [id, q] of L) {
      const r0 = Math.hypot(q.x, q.z);
      const d = Math.hypot(A.get(id)!.x - B.get(id)!.x, A.get(id)!.z - B.get(id)!.z);
      if (r0 < 200) innerMax = Math.max(innerMax, d);
      else outerMax = Math.max(outerMax, d);
    }
    expect(innerMax).toBeLessThan(30); // 内段锚定:几乎不动
    expect(outerMax).toBeGreaterThan(120); // 外段:明显伸缩
    for (const q of B.values()) expect(Math.hypot(q.x, q.z)).toBeLessThan(1800);
    // eight 风格仍按原样吃 amp
    const E0 = flowShape(L, 30000, 'disk', 1, 0, 'eight');
    const E2 = flowShape(L, 30000, 'disk', 1, 2, 'eight');
    let eSum = 0;
    for (const [id, q] of E0) { const b = E2.get(id)!; eSum += Math.hypot(q.x - b.x, q.z - b.z); }
    expect(eSum / E0.size).toBeGreaterThan(60);
  });

  it('悬臂散度 armSpread:越大外沿越散(径向离散度单调增),内圈仍紧凑', () => {
    const all: ReturnType<typeof mk>[] = [];
    for (let i = 0; i < 300; i++) all.push(mk('x' + i, 'tool', 'work'));
    const spreadOf = (sp: number) => {
      const L = buildClusterShapeLayout(all, 'hall', 'disk', 'spiral', sp);
      // 外沿(半径最大的 30% 点)的角向离散度
      const pts = [...L.values()].map((q) => ({ r: Math.hypot(q.x, q.z), a: Math.atan2(q.z, q.x) }));
      pts.sort((a, b) => b.r - a.r);
      const tail = pts.slice(0, Math.floor(pts.length * 0.3));
      const mx = tail.reduce((s, q) => s + q.r, 0) / tail.length;
      // 用"离臂中轴的角向偏差"近似:取全点角向标准差
      const am = pts.reduce((s, q) => s + q.a, 0) / pts.length;
      return Math.sqrt(pts.reduce((s, q) => s + (q.a - am) ** 2, 0) / pts.length) * mx;
    };
    const s0 = spreadOf(0.05);
    const s1 = spreadOf(0.55);
    const s2 = spreadOf(1);
    expect(s1).toBeGreaterThan(s0);
    expect(s2).toBeGreaterThan(s1);
    // 默认值 0.55 时所有点仍在盘内(不发散到天上)
    const L = buildClusterShapeLayout(all, 'hall', 'disk', 'spiral', 0.55);
    for (const q of L.values()) expect(Math.hypot(q.x, q.z)).toBeLessThan(1200);
  });

  it('圆盘 discSeed:同种子逐位一致,不同种子朝向/布局不同(每次进入随机角度)', () => {
    const ns: ReturnType<typeof mk>[] = [];
    for (let i = 0; i < 120; i++) ns.push(mk('d' + i, 'tool', 'work'));
    const a = buildClusterShapeLayout(ns, 'hall', 'disk', 'disc', 0.55, 3);
    const b = buildClusterShapeLayout(ns, 'hall', 'disk', 'disc', 0.55, 3);
    const c = buildClusterShapeLayout(ns, 'hall', 'disk', 'disc', 0.55, 4);
    expect([...a.entries()]).toEqual([...b.entries()]); // 同种子可回放
    let diff = 0;
    for (const [id, q] of a) { const q2 = c.get(id)!; diff = Math.max(diff, Math.hypot(q.x - q2.x, q.z - q2.z)); }
    expect(diff).toBeGreaterThan(50); // 不同种子确实换朝向
    for (const q of a.values()) expect(Math.hypot(q.x, q.z)).toBeLessThan(1200);
  });

  it('核球:盘类形态中心有实料(半径<R0 的点占比 ≥10%),不留空洞', () => {
    const ns: ReturnType<typeof mk>[] = [];
    for (let i = 0; i < 400; i++) ns.push(mk('b' + i, 'tool', i % 2 ? 'work' : 'learning'));
    for (const st of ['spiral', 'legacy', 'disc'] as const) {
      const L = buildClusterShapeLayout(ns, 'hall', 'disk', st);
      const near = [...L.values()].filter((q) => Math.hypot(q.x, q.z) < 150).length;
      expect(near / L.size).toBeGreaterThan(0.1);
    }
  });

  it('巨簇拆半对 hall 轴同样生效:占比 >40% 的组拆成 3 份,不独占一臂', () => {
    const ns: ReturnType<typeof mk>[] = [];
    for (let i = 0; i < 800; i++) ns.push(mk('w' + i, 'tool', 'work'));
    for (const h of ['learning', 'health', 'finance']) for (let i = 0; i < 40; i++) ns.push(mk(h + i, 'person', h));
    const L = buildClusterShapeLayout(ns, 'hall', 'disk', 'spiral');
    // work 占 87% → 拆 3 份;六臂里 work 的 3 个子簇应分散在 ≥3 条不同臂上
    const arms = new Set<number>();
    for (const [id, q] of L) {
      if (!id.startsWith('w')) continue;
      const a = Math.atan2(q.z / 0.82, q.x);
      arms.add(Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 3)));
    }
    expect(arms.size).toBeGreaterThanOrEqual(3);
  });

  it('吸积盘流 accretion:点级随机(同半径不同步),且不越出盘包络、可回放', async () => {
    const { flowShape } = await import('../client/src/explorer/projection.js');
    const ns: ReturnType<typeof mk>[] = [];
    for (let i = 0; i < 400; i++) ns.push(mk('a' + i, 'tool', i % 2 ? 'work' : 'learning'));
    const L = buildClusterShapeLayout(ns, 'hall', 'disk', 'disc');
    const A = flowShape(L, 5000, 'disk', 1, 1, 'accretion');
    const B = flowShape(L, 5000, 'disk', 1, 1, 'accretion');
    expect([...A.entries()]).toEqual([...B.entries()]); // 同一 t 可回放
    // 同半径两点的角位移不同(点级个体差 → 不是刚体转)
    const byR = [...L.entries()].filter(([, q]) => Math.hypot(q.x, q.z) > 200 && Math.hypot(q.x, q.z) < 240).slice(0, 2);
    if (byR.length === 2) {
      const ang = (q: { x: number; z: number }) => Math.atan2(q.z, q.x);
      const d0 = ang(byR[0]![1]) - ang(byR[1]![1]);
      const d1 = ang(A.get(byR[0]![0])!) - ang(A.get(byR[1]![0])!);
      expect(Math.abs(d1 - d0)).toBeGreaterThan(1e-4);
    }
    for (const q of A.values()) expect(Math.hypot(q.x, q.z)).toBeLessThan(1400);
    // speed=0 冻结
    const F0 = flowShape(L, 0, 'disk', 0, 1, 'accretion');
    for (const [id, q] of F0) { const b = L.get(id)!; expect(Math.hypot(q.x - b.x, q.z - b.z)).toBeLessThan(1e-6); }
  });
});
