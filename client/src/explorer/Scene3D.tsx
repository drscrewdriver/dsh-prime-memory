/**
 * 3D 记忆海渲染组件：Canvas 2D 手写三维（yaw/pitch 旋转 + 透视除法 + 深度排序）。
 *
 * 不是 WebGL：千级点 2D context 足够（基准页 1500 点/3000 边全开实测 fps 60，
 * 纯计算单帧 0.534ms），且 client bundle 已被 G6 的 UMD 抬到 2.5MB，不再抬。
 * 所有数学/判据在 projection.ts 纯函数层（可 node 单测），本组件只做
 * 「取投影结果 → 逐帧画 → 派发给 DOM 覆盖层」，不做任何"谁该显示"的判断——
 * 元素集合与 2D 同源（同一个 graph-preview mode:'full' 块）。
 *
 * 视觉三通道严格分离（projection.ts 不变式 3）：
 *   颜色 = 类型（复用 2D 的 --dsh-mem-chart-* 令牌，canvas 不吃 CSS 变量，
 *          先 getComputedStyle 解成实色，与 GraphCanvas 同款处理）；
 *   亮度 = 深度 × 老化（双通道各自封顶再相乘，aging 缺省按 1）；
 *   半径 = 度数（sqrt 压缩）× 透视系数，焦点/悬停再放大。
 *
 * 交互（与用户定的语义对齐）：
 *   左拖 = 旋转（pitch 限位 ±1.35rad）；shift/中键拖 = 平移；滚轮 = 缩放；
 *   悬停 = 只留相关边 + 其余点压暗 + 关系词画在边中点 + DOM 浮层明细；
 *   单击 = 进入 ego（BFS 跳数 = 球壳层数，520ms 插值过渡，相机自动框住壳层）；
 *   ego 中再点焦点 = 回 cluster；双击/Enter = 打开该实体来源记录（onPick）；Esc 退出。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GraphFull } from '../tabs/graph-canvas-data.js';
import { clipByWidth, degreeMapOf, hash32 } from '../tabs/graph-canvas-data.js';
import {
  CAM_DEFAULT,
  DIST_MAX,
  DIST_MIN,
  EGO_HOPS_MAX,
  PICK_PX,
  PITCH_LIMIT,
  SHELL_GAP,
  TRANSITION_MS,
  brightnessFor,
  buildClusterLayout,
  buildEgoLayout,
  labelBudget,
  lerpLayout,
  pickLabels,
  pickNearest,
  projectAll,
  zoomBy,
} from './projection.js';
import type { Projected, Vec3 } from './projection.js';
import { NButton } from '../ui/primitives.js';

/** type → 既有图表系列令牌（与 GraphCanvas / GraphTab 同源五色，不引入新色值）。 */
const TYPE_TOKENS: Record<string, string> = {
  person: '--dsh-mem-chart-1',
  project: '--dsh-mem-chart-2',
  organization: '--dsh-mem-chart-3',
  tool: '--dsh-mem-chart-4',
  place: '--dsh-mem-chart-5',
};
const FALLBACK_TOKEN = '--dsh-mem-chart-6';
const FALLBACK_COLOR = '#8a8f98';

/** CSS 变量 → 实色（与 GraphCanvas 同款：插件自注入的 theme 样式在容器上生效）。 */
function resolveColor(host: HTMLElement, token: string): string {
  const v = getComputedStyle(host).getPropertyValue(token).trim();
  return v.length > 0 ? v : FALLBACK_COLOR;
}

/** 辉光 sprite 的画布边长（预渲染径向渐变，逐帧只 drawImage 缩放——shadowBlur 每帧重算扛不住千点）。 */
const SPRITE_PX = 64;

interface NodeMeta {
  id: string;
  name: string;
  type: string;
  color: string;
  degree: number;
  /** 基础半径（度数控）：投影时再乘透视系数。 */
  base: number;
  aging: number | null;
  /** 出处场景名（provenance fallback）：悬停卡片显示“出处：xxx”。 */
  source: string | null;
}

interface EdgeMeta {
  from: string;
  to: string;
  relation: string;
  causal: boolean;
}

/** onPick 每个父渲染都是新引用（deps 含 links）：用 ref 同步更新，保证事件回调永远拿到最新版。
 *  不用 useEffect 延后写 ref——点击可能比 effect 更早。 */
function useLatest<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn; // 每次渲染同步更新（不用 effect，消除时序窗口）
  return ((...args: Parameters<T>) => ref.current(...args)) as T;
}

export function Scene3D(props: {
  full: GraphFull;
  onPick: (id: string) => void;
  /** 右栏联动强调（与 2D 的 emphasisId 同一来源）。 */
  emphasisId?: string;
  height?: number;
}) {
  const { full, onPick: onPickRaw, emphasisId, height = 620 } = props;
  const onPick = useLatest(onPickRaw);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── 视觉开关（组件 state，刷新即回默认；不写 config/localStorage） ──
  const [glowOn, setGlowOn] = useState(true);
  const [edgesOn, setEdgesOn] = useState(true);
  const [labelsOn, setLabelsOn] = useState(true);
  const [agingOn, setAgingOn] = useState(true);
  const [pointSize, setPointSize] = useState(2.2);
  /** 漂移默认关：开启后密集簇的 lighter 辉光每帧亚像素抖动→“闪烁感”；默认静态更稳。 */
  const [driftOn, setDriftOn] = useState(false);
  /** 主题：星空（暗底+星点，默认）/ 白底（浅色）。 */
  const [starry, setStarry] = useState(true);

  // ── 交互态（ref 为主，避免每帧 setState；hover 走 DOM 浮层才需要 state） ──
  const camRef = useRef({ ...CAM_DEFAULT });
  const modeRef = useRef<'cluster' | 'ego'>('cluster');
  const focusRef = useRef<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ id: string; x: number; y: number } | null>(null);
  const [mode, setMode] = useState<'cluster' | 'ego'>('cluster');
  const dragRef = useRef<{ btn: number; x: number; y: number; panning: boolean } | null>(null);
  const clickRef = useRef<{ id: string; at: number } | null>(null);
  /** emphasisId 用 ref 读取，不进主循环 deps——否则每次点击都重建 rAF 导致闪烁。 */
  const emphasisRef = useRef(emphasisId);
  emphasisRef.current = emphasisId;
  /** 空闲冻结：无交互/无过渡/无漂移时不重绘，消除静态图的持续重绘闪烁。事件回调置 true。 */
  const dirtyRef = useRef(true);

  // ── 数据面：degree 表 / 邻接 / 边表（full 变化才重算，渲染层样式函数不聚合） ──
  const degree = useMemo(() => degreeMapOf(full), [full]);
  const edgeList = useMemo<EdgeMeta[]>(
    () => full.edges.map((e) => ({ from: e.from, to: e.to, relation: e.relation, causal: e.causal })),
    [full],
  );
  const adj = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of edgeList) {
      if (!m.has(e.from)) m.set(e.from, []);
      if (!m.has(e.to)) m.set(e.to, []);
      m.get(e.from)!.push(e.to);
      m.get(e.to)!.push(e.from);
    }
    return m;
  }, [edgeList]);
  const nodeById = useMemo(() => new Map(full.nodes.map((n) => [n.id, n])), [full]);
  /** 星空种子：同一节点集恒同星阵（复用 2D 的 nodeKeyOf 同构思路）。 */
  const nodeKeySeed = useMemo(() => full.nodes.map((n) => n.id).join('|') || 'empty', [full]);

  // ── 布局：cluster 随数据重建；ego 进入时算一次并缓存 ──
  const clusterLayout = useMemo(() => buildClusterLayout(full.nodes.map((n) => ({ id: n.id, type: n.type }))), [full]);
  const layoutRef = useRef<Map<string, Vec3>>(clusterLayout);
  const egoLayoutRef = useRef<Map<string, Vec3> | null>(null);
  const transRef = useRef<{ from: Map<string, Vec3>; to: Map<string, Vec3>; start: number } | null>(null);
  useEffect(() => {
    // 数据换了：过渡作废，直接落到新 cluster 布局（ego 焦点可能已不在新图里）。
    layoutRef.current = clusterLayout;
    egoLayoutRef.current = null;
    transRef.current = null;
    modeRef.current = 'cluster';
    focusRef.current = null;
    setMode('cluster');
  }, [clusterLayout]);

  /** 外部强调变化（如详情面板点「看图」）：自动进入 ego 聚焦该节点。 */
  useEffect(() => {
    if (!emphasisId || emphasisId === focusRef.current) return;
    // 确认该节点在当前图里存在
    if (!clusterLayout.has(emphasisId)) return;
    const egoL = buildEgoLayout(adj, emphasisId, EGO_HOPS_MAX);
    egoLayoutRef.current = egoL;
    modeRef.current = 'ego';
    focusRef.current = emphasisId;
    setMode('ego');
    transRef.current = { from: layoutRef.current, to: egoL, start: performance.now() };
    camRef.current.dist = Math.min(3200, Math.max(380, EGO_HOPS_MAX * 300 * 1.55));
    camRef.current.panX = 0;
    camRef.current.panY = 0;
  }, [emphasisId, adj, clusterLayout]);

  // ── 派生色/半径表：随令牌解析与开关变化重建 ──
  const metasRef = useRef<Map<string, NodeMeta>>(new Map());
  const spritesRef = useRef(new Map<string, HTMLCanvasElement>());
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const colorCache = new Map<string, string>();
    const colorOf = (type: string): string => {
      const token = TYPE_TOKENS[type] ?? FALLBACK_TOKEN;
      let c = colorCache.get(token);
      if (c === undefined) {
        c = resolveColor(host, token);
        colorCache.set(token, c);
      }
      return c;
    };
    metasRef.current = new Map(
      full.nodes.map((n): [string, NodeMeta] => {
        const deg = degree.get(n.id) ?? 0;
        return [
          n.id,
          {
            id: n.id,
            name: n.name,
            type: n.type,
            color: colorOf(n.type),
            degree: deg,
            // 度数 → 基础半径：sqrt 压缩（与 2D radiusForDegree 同一族形状，单位换成 3D 世界）
            base: pointSize * (1 + Math.sqrt(deg) * 0.28),
            aging: n.aging ?? null,
            source: n.source ?? null,
          },
        ];
      }),
    );
  }, [full, degree, pointSize]);

  // ── 主循环：一帧 = 过渡推进 → 投影 → 深度排序绘制 → 标签 LOD ──
  // 用 useLayoutEffect 而非 useEffect：保证首帧在浏览器 paint 前画完，消除“空画布闪烁”。
  useLayoutEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // 任何依赖变化（老化亮度/辉光/主题…）重跑本 effect 时必须强制重画一帧：
    // resize() 会把 canvas 清空成透明，若 dirty 仍停在上轮的 false，首帧会被空闲冻结跳过 → 白屏卡死。
    dirtyRef.current = true;

    // 帧缓存：所有绘制先写离屏 buffer，完成后一次性 blit 到可见 canvas。
    // 消除 Electron GPU 合成器可能提前暴露部分绘制状态导致的“激活点边界闪烁”。
    const buffer = document.createElement('canvas');
    const bctx = buffer.getContext('2d')!;

    let raf = 0;
    let disposed = false;
    let vw = 0;
    let vh = 0;
    /** 当前 DPR：blit 后恢复可见 ctx 的变换用。 */
    const dprRef = { current: 1 };

    const spriteFor = (color: string): HTMLCanvasElement => {
      const hit = spritesRef.current.get(color);
      if (hit) return hit;
      const s = document.createElement('canvas');
      s.width = SPRITE_PX;
      s.height = SPRITE_PX;
      const sc = s.getContext('2d')!;
      const half = SPRITE_PX / 2;
      const g = sc.createRadialGradient(half, half, 0, half, half, half);
      g.addColorStop(0, color);
      g.addColorStop(0.4, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      // 渐变里的 color 停点用实色十六进制可能不带 alpha：先画满再整体乘 globalAlpha
      sc.fillStyle = g;
      sc.beginPath();
      sc.arc(half, half, half, 0, Math.PI * 2);
      sc.fill();
      spritesRef.current.set(color, s);
      return s;
    };

    // 背景离屏缓存：按主题烘一张背景图（星空=暗底+星点，白底=浅色），尺寸/主题变了才重烘。
    let bgCache: HTMLCanvasElement | null = null;
    let bgCacheW = 0;
    let bgCacheH = 0;
    let bgCacheStarry: boolean | null = null;

    /** 烘背景：starry 时蓝黑夜空渐变 + 稀疏星点（劳斯莱斯星空顶观感）；白底吃令牌。 */
    const bakeBg = (w: number, h: number, starryMode: boolean, seedKey: string): HTMLCanvasElement => {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const bc = cv.getContext('2d')!;
      if (starryMode) {
        // 蓝黑夜空：顶部偏蓝、底部沉黑（纯 #05060b 太灰闷，没有夜空方位）。
        const sky = bc.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#0a1226');
        sky.addColorStop(1, '#04070f');
        bc.fillStyle = sky;
        bc.fillRect(0, 0, w, h);
        // 星点：确定性 hash（同种子恒同星阵），密度按面积 ~每 12500px² 一颗、封顶 260——
        // 用户要求“不要太密”；三档亮度，只有少数亮星带微晕，避免均匀点阵的“雪花屏”感。
        // 不复用 2D 的 starField（那是设置页图谱的背层，职责不同不动它）。
        const count = Math.min(260, Math.floor((w * h) / 12_500));
        const rnd = (i: number, tag: string): number => (hash32(`${seedKey}:${tag}:${i}`) % 100000) / 100000;
        for (let i = 0; i < count; i++) {
          const x = rnd(i, 'x') * w;
          const y = rnd(i, 'y') * h;
          const t = rnd(i, 't');
          if (t < 0.05) {
            // 亮星（~5%）：径向微晕 + 白核，光纤束末端的感觉。
            const halo = bc.createRadialGradient(x, y, 0, x, y, 5.5);
            halo.addColorStop(0, 'rgba(214, 226, 255, 0.8)');
            halo.addColorStop(1, 'rgba(214, 226, 255, 0)');
            bc.fillStyle = halo;
            bc.beginPath();
            bc.arc(x, y, 5.5, 0, Math.PI * 2);
            bc.fill();
            bc.fillStyle = 'rgba(230, 238, 255, 0.95)';
            bc.beginPath();
            bc.arc(x, y, 1.1, 0, Math.PI * 2);
            bc.fill();
          } else if (t < 0.22) {
            // 中星（~17%）：不晕，半径/透明度拉开口。
            bc.fillStyle = `rgba(196, 210, 240, ${0.34 + t * 1.2})`;
            bc.beginPath();
            bc.arc(x, y, 0.9, 0, Math.PI * 2);
            bc.fill();
          } else {
            // 暗背景星（~78%）：细淡点，只给“深”不给“多”。
            bc.fillStyle = `rgba(168, 184, 220, ${0.1 + t * 0.9})`;
            bc.beginPath();
            bc.arc(x, y, 0.55, 0, Math.PI * 2);
            bc.fill();
          }
        }
        bc.globalAlpha = 1;
      } else {
        bc.fillStyle = resolveColor(host, '--dsh-mem-bg-card');
        bc.fillRect(0, 0, w, h);
      }
      return cv;
    };

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      dprRef.current = dpr;
      vw = host.clientWidth || 640;
      vh = host.clientHeight || host.offsetHeight || height;
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;
      buffer.width = canvas.width;
      buffer.height = canvas.height;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bgCache = null;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    /** 当前帧的有效布局（过渡中为插值结果）。 */
    const activeLayout = (now: number): Map<string, Vec3> => {
      const tr = transRef.current;
      if (!tr) return layoutRef.current;
      const k = (now - tr.start) / TRANSITION_MS;
      if (k >= 1) {
        layoutRef.current = tr.to;
        transRef.current = null;
        return tr.to;
      }
      return lerpLayout(tr.from, tr.to, k);
    };

    // 上一帧投影结果缓存（拾取用，屏幕坐标是现成的）
    let lastProjected: Projected[] = [];

    const frame = (now: number) => {
      if (disposed) return;
      const cam = camRef.current;
      const layout = activeLayout(now);
      const ego = modeRef.current === 'ego';
      const metas = metasRef.current;
      const hover = hoverRef.current;
      const focus = focusRef.current;

      // hover 邻域集（压暗路线：非邻居 alpha 封到 0.12，不靠加亮焦点）
      let nbSet: Set<string> | null = null;
      if (hover) {
        nbSet = new Set<string>([hover, ...(adj.get(hover) ?? [])]);
        if (focus && focus !== hover) nbSet.add(focus);
      }

      // 漂移：开关控制（默认关）；ego 壳层半径本身是语义（第几跳=第几层），强制不抖。
      const projected = projectAll(layout, cam, { w: vw, h: vh }, undefined, now, driftOn && !ego);
      lastProjected = projected;

      // 所有绘制写到离屏 buffer 而非可见 canvas
      const c = bctx;
      c.clearRect(0, 0, vw, vh);
      // 背景 blit（主题变了或尺寸变了才重烘）
      if (!bgCache || bgCacheW !== vw || bgCacheH !== vh || bgCacheStarry !== starry) {
        bgCache = bakeBg(vw, vh, starry, nodeKeySeed);
        bgCacheW = vw; bgCacheH = vh; bgCacheStarry = starry;
      }
      c.drawImage(bgCache, 0, 0);

      const pos = new Map(projected.map((p) => [p.id, p]));

      // ── 边（先画：点在上方，遮挡自然；远→近顺序对线无所谓，alpha 统一） ──
      if (edgesOn) {
        const edgeBase = resolveColor(host, '--dsh-mem-border-strong');
        const causalC = resolveColor(host, '--dsh-mem-accent');
        c.globalCompositeOperation = 'source-over';
        for (const e of edgeList) {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) continue;
          const related = !hover || (nbSet!.has(e.from) && nbSet!.has(e.to) && (e.from === hover || e.to === hover));
          if (hover && !related) continue;
          const avgF = (a.f + b.f) / 2;
          const alpha = Math.min(0.9, Math.max(0.05, avgF * 0.34));
          c.strokeStyle = e.causal ? causalC : edgeBase;
          c.globalAlpha = hover ? Math.min(0.9, alpha + 0.25) : alpha;
          c.lineWidth = e.causal ? 1.2 : 0.7;
          c.beginPath();
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
          c.stroke();
        }
        c.globalAlpha = 1;
      }

      // ── 点（远→近；辉光走 lighter 叠加，密集簇自然成发光球团） ──
      for (const p of projected) {
        const m = metas.get(p.id);
        if (!m) continue;
        const isFocus = p.id === focus || p.id === emphasisRef.current;
        const isHover = p.id === hover;
        const dim = hover !== null && nbSet !== null && !nbSet.has(p.id) && !isFocus;
        let alpha = brightnessFor(p.f, agingOn ? m.aging : null, true);
        if (dim) alpha = Math.min(alpha, 0.12);
        const r = Math.max(0.8, m.base * p.f * 1.75 * (isFocus || isHover ? 1.9 : 1));
        if (glowOn) {
          c.globalCompositeOperation = 'lighter';
          c.globalAlpha = alpha * 0.5;
          const sp = spriteFor(m.color);
          const gr = r * 3.4;
          c.drawImage(sp, p.x - gr, p.y - gr, gr * 2, gr * 2);
        }
        c.globalCompositeOperation = 'source-over';
        c.globalAlpha = Math.min(1, alpha + 0.15);
        c.fillStyle = m.color;
        c.beginPath();
        c.arc(p.x, p.y, r, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;

      // ── 标签 LOD：预算随缩放；焦点/悬停加权在集外必标 ──
      if (labelsOn) {
        const textColor = resolveColor(host, '--dsh-mem-text-2');
        // 预算单源在 projection.labelBudget（与单测同一函数），这里不另抄一份
        const inSet = new Set<string>();
        const cand = projected
          .filter((p) => metas.has(p.id))
          .map((p) => {
            const m = metas.get(p.id)!;
            const hot = p.id === focus || p.id === hover || p.id === emphasisRef.current;
            if (hot) inSet.add(p.id);
            return {
              id: p.id,
              x: p.x,
              y: p.y,
              f: p.f,
              rank: (hot ? 1e6 : 0) + m.degree * 10 + (m.aging ?? 1) * 5 + hash32(p.id) % 7,
            };
          });
        const widthOf = (id: string): number => {
          const m = metas.get(id);
          return m ? clipByWidth(m.name).length * 6.4 : 0;
        };
        const picked = new Set([...pickLabels(cand, labelBudget(cam.dist), widthOf, vw), ...inSet]);
        c.globalCompositeOperation = 'source-over';
        c.fillStyle = textColor;
        c.font = '11px system-ui, "Microsoft YaHei", sans-serif';
        for (const p of projected) {
          if (!picked.has(p.id)) continue;
          const m = metas.get(p.id)!;
          const dim = hover !== null && nbSet !== null && !nbSet.has(p.id);
          c.globalAlpha = dim ? 0.18 : Math.min(1, Math.max(0.35, p.f));
          c.fillText(clipByWidth(m.name), p.x + 7, p.y - 5);
        }
        c.globalAlpha = 1;
      }

      // ── 关系词：hover 时画在相关边中点（小网格避让，因果优先占格） ──
      if (hover && edgesOn) {
        const causalC = resolveColor(host, '--dsh-mem-accent');
        const edgeBase = resolveColor(host, '--dsh-mem-border-strong');
        c.font = '10px system-ui, "Microsoft YaHei", sans-serif';
        const used = new Set<number>();
        const related = edgeList
          .filter((e) => (e.from === hover || e.to === hover) && pos.has(e.from) && pos.has(e.to))
          .sort((a, b) => Number(b.causal) - Number(a.causal));
        for (const e of related.slice(0, 12)) {
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const cell = Math.floor(mx / 72) * 1000 + Math.floor(my / 13);
          if (used.has(cell)) continue;
          used.add(cell);
          c.fillStyle = e.causal ? causalC : edgeBase;
          c.globalAlpha = 0.92;
          c.fillText(e.relation, mx, my);
        }
        c.globalAlpha = 1;
      }

      // 帧缓存完成：一次性 blit 到可见 canvas，消除中间态闪烁。
      // buffer 已是设备像素尺寸，blit 前必须重置变换——否则 dpr 二次缩放会把画面推偏。
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(buffer, 0, 0);
      ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);

      raf = requestAnimationFrame(frame);
    };
    // 同步画第一帧：避免浏览器在 rAF 回调前 paint 一次“空画布”导致元素闪烁。
    frame(performance.now());

    // ── 事件：旋转/平移/缩放/悬停/点击（原生 listener：wheel 要 passive:false） ──
    const toLocal = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    const onDown = (ev: MouseEvent) => {
      const pt = toLocal(ev);
      dragRef.current = { btn: ev.button, x: pt.x, y: pt.y, panning: ev.shiftKey || ev.button === 1 };
    };
    const onMove = (ev: MouseEvent) => {
      const pt = toLocal(ev);
      const drag = dragRef.current;
      if (drag) {
        const cam = camRef.current;
        if (drag.panning) {
          cam.panX += (pt.x - drag.x) * (cam.dist / CAM_DEFAULT.dist);
          cam.panY += (pt.y - drag.y) * (cam.dist / CAM_DEFAULT.dist);
        } else {
          cam.yaw += (pt.x - drag.x) * 0.006;
          cam.pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, cam.pitch + (pt.y - drag.y) * 0.006));
        }
        drag.x = pt.x;
        drag.y = pt.y;
        dirtyRef.current = true;
        return;
      }
      const hit = pickNearest(lastProjected, pt.x, pt.y, PICK_PX);
      if (hit !== hoverRef.current) {
        hoverRef.current = hit;
        dirtyRef.current = true;
        setHoverInfo(hit ? { id: hit, x: pt.x, y: pt.y } : null);
      } else if (hit) {
        setHoverInfo({ id: hit, x: pt.x, y: pt.y });
      }
    };
    const onUp = (ev: MouseEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || drag.panning || ev.button !== 0) return;
      const pt = toLocal(ev);
      // 位移小于 4px 才算点击（拖了 200px 再松手不是"想选中"）
      if (Math.hypot(pt.x - drag.x, pt.y - drag.y) > 4) return;
      const hit = pickNearest(lastProjected, pt.x, pt.y, PICK_PX);
      if (!hit) return;
      const now = Date.now();
      const prev = clickRef.current;
      if (prev && prev.id === hit && now - prev.at < 380) {
        onPick(hit); // 双击：跳到来源记录
        clickRef.current = null;
        return;
      }
      clickRef.current = { id: hit, at: now };
      // 单击即触发详情（关注点转移 + 右侧面板同步）
      onPick(hit);
      const ego = modeRef.current === 'ego';
      const startTransition = (to: Map<string, Vec3>) => {
        transRef.current = { from: layoutRef.current, to, start: performance.now() };
      };
      if (ego && hit === focusRef.current) {
        // ego 中再点焦点 = 回 cluster
        modeRef.current = 'cluster';
        focusRef.current = null;
        setMode('cluster');
        startTransition(clusterLayout);
        camRef.current.dist = CAM_DEFAULT.dist;
      } else if (!ego) {
        const egoL = buildEgoLayout(adj, hit, EGO_HOPS_MAX);
        egoLayoutRef.current = egoL;
        modeRef.current = 'ego';
        focusRef.current = hit;
        setMode('ego');
        startTransition(egoL);
        // 相机自动框住壳层：3 跳壳 + 余量，钳进距离限位
        camRef.current.dist = Math.min(DIST_MAX, Math.max(DIST_MIN, EGO_HOPS_MAX * SHELL_GAP * 1.55));
        camRef.current.panX = 0;
        camRef.current.panY = 0;
      } else {
        // ego 中点别的节点 = 换焦点重建壳层
        const egoL = buildEgoLayout(adj, hit, EGO_HOPS_MAX);
        egoLayoutRef.current = egoL;
        focusRef.current = hit;
        startTransition(egoL);
      }
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      camRef.current.dist = zoomBy(camRef.current.dist, ev.deltaY);
      dirtyRef.current = true;
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter' && hoverRef.current) onPick(hoverRef.current);
      if (ev.key === 'Escape' && modeRef.current === 'ego') {
        modeRef.current = 'cluster';
        focusRef.current = null;
        setMode('cluster');
        transRef.current = { from: layoutRef.current, to: clusterLayout, start: performance.now() };
        camRef.current.dist = CAM_DEFAULT.dist;
      }
    };
    const onLeave = () => {
      hoverRef.current = null;
      setHoverInfo(null);
      dragRef.current = null;
    };

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mouseleave', onLeave);
    window.addEventListener('keydown', onKey);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('keydown', onKey);
    };
    // clusterLayout 进依赖：数据换了循环要拿到新布局闭包；starry/driftOn/nodeKeySeed 变了循环要重烘背景/改漂移。
  }, [full, edgeList, adj, clusterLayout, glowOn, edgesOn, labelsOn, agingOn, driftOn, starry, nodeKeySeed, height, onPick]);

  const hoverMeta = hoverInfo ? metasRef.current.get(hoverInfo.id) : null;

  /**
   * 控件层调色盘：工具条/HUD 直接贴在画布上且无实底容器，浅色主题下 NButton
   * 默认深字压在暗底上看不见（真机踩过的“回全图/漂移”不可读）。星空态改走
   * 半透暗条 + 亮字；白底态仍吃令牌。canvas 不吃 CSS 变量，DOM 浮层才用这套。
   */
  const ui = starry
    ? {
        barBg: 'rgba(10, 13, 22, 0.72)',
        border: '1px solid rgba(120, 160, 255, 0.22)',
        text: '#c8d2e8',
        dim: '#93a3c4',
        accent: '#7fb1ff',
      }
    : {
        barBg: 'var(--dsh-mem-bg-card)',
        border: '1px solid var(--dsh-mem-border)',
        text: 'var(--dsh-mem-text-2)',
        dim: 'var(--dsh-mem-text-3)',
        accent: 'var(--dsh-mem-accent)',
      };

  const toggle = (label: string, on: boolean, set: (v: boolean) => void) => (
    <NButton
      onClick={() => set(!on)}
      style={on ? { color: ui.accent, borderColor: ui.accent } : { color: ui.text, borderColor: ui.border }}
      title={label}
    >
      {label}
    </NButton>
  );

  return (
    <div ref={hostRef} style={{ position: 'relative', width: '100%', flex: 1, minHeight: height, overflow: 'hidden', background: starry ? '#04070f' : 'var(--dsh-mem-bg-card, #ffffff)' }}>
      <canvas ref={canvasRef} style={{ display: 'block', cursor: dragRef.current ? 'grabbing' : 'grab', background: starry ? '#04070f' : 'var(--dsh-mem-bg-card, #ffffff)' }} />

      {/* 左上：模式与操作提示（ego 态给退出路径，不留死胡同观感） */}
      <div
        style={{ position: 'absolute', top: 8, left: 8, fontSize: 11, color: ui.dim, background: ui.barBg, border: ui.border, borderRadius: 8, padding: '4px 8px', pointerEvents: 'none' }}
      >
        {mode === 'ego' ? (
          <span>
            ego 壳层 · <b style={{ color: ui.accent }}>{(focusRef.current ? nodeById.get(focusRef.current)?.name : null) ?? '焦点'}</b> 在第 0 层，第 k 跳在第 k 层
            <br />
            点焦点/Esc 回全图 · 双击/Enter 打开记录
          </span>
        ) : (
          <span>左拖旋转 · shift 拖平移 · 滚轮缩放 · 单击聚焦成 ego · 双击开记录</span>
        )}
      </div>

      {/* 悬停明细：DOM 浮层（canvas 里没有 DOM，别在 canvas 上排版整段元数据） */}
      {hoverInfo && hoverMeta ? (
        <div
          style={{
            position: 'absolute',
            left: Math.min(hoverInfo.x + 14, (hostRef.current?.clientWidth ?? 640) - 230),
            top: Math.max(6, hoverInfo.y - 10),
            maxWidth: 220,
            fontSize: 11.5,
            lineHeight: 1.5,
            background: 'var(--dsh-mem-bg-card)',
            border: '1px solid var(--dsh-mem-border)',
            borderRadius: 8,
            padding: '6px 9px',
            pointerEvents: 'none',
            color: 'var(--dsh-mem-text-2)',
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--dsh-mem-text-1)' }}>{hoverMeta.name}</div>
          <div>
            {hoverMeta.type} · 关系 {hoverMeta.degree} 条{hoverMeta.aging != null ? ` · 老化 ${hoverMeta.aging.toFixed(2)}` : ''}
          </div>
          {hoverMeta.source ? <div style={{ color: 'var(--dsh-mem-text-3)' }}>出处：{hoverMeta.source}</div> : null}
        </div>
      ) : null}

      {/* 底部：视觉控件（只存组件 state，刷新回默认）。星空态垫半透暗条——
          按钮无实底时浅色主题的深字压在暗底上不可读（真机踩过的“回全图”看不清）。 */}
      <div
        style={{ position: 'absolute', bottom: 8, left: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', background: ui.barBg, border: ui.border, borderRadius: 10, padding: '4px 8px' }}
      >
        {toggle('辉光', glowOn, setGlowOn)}
        {toggle('边', edgesOn, setEdgesOn)}
        {toggle('标签', labelsOn, setLabelsOn)}
        {toggle('老化亮度', agingOn, setAgingOn)}
        {toggle('漂移', driftOn, setDriftOn)}
        {toggle(starry ? '星空底' : '白底', starry, setStarry)}
        <label style={{ fontSize: 11, color: ui.dim, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          点
          <input type="range" min={1.2} max={4} step={0.2} value={pointSize} onChange={(e) => setPointSize(Number(e.target.value))} />
        </label>
        {mode === 'ego' ? (
          <NButton onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))} title="回到全图" style={{ color: ui.text, borderColor: ui.border }}>
            回全图
          </NButton>
        ) : null}
      </div>
    </div>
  );
}
