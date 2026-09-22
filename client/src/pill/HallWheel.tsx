/**
 * 八边形域轮（hall 主题轴门面，v6 换挡版）。
 *
 * 几何：八边形为**固定规则正八边形**（顶点半径恒定，无鼓起/无连续半径形变）。
 * 交互：拖动 = 在 8 个顶点间**离散换挡**（档位只能是整数 0-7，绝不停在边中）。
 *   - 边正中 14° 死区 = 阻尼（档位被吸在原角，不抖动）；
 *   - 越过中点后 target 切到邻角，弹簧 needle 从旧角弹入新角（类似换挡）。
 * 语义：点角 / 拖动松手 = 以该角为主题（会话级域锁定），其余角由服务端硬过滤抑制；
 *       点中心 = 回全域（智能档）。权重只与"停在哪个顶点"有关，不再做连续配额。
 *
 * 数据：角计数来自 dsh-memory/hall-overview（打开时拉取一次）。
 * 层级：设置页全局闸 ⊃ 会话闸（图形外）⊃ 域范围（图形内）。
 */
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { ActionButton, Segmented } from '../ui/controls.js';
import type { RpcFn } from '../rpc.js';
import type { HallOverviewResponse } from '../../../src/contract.js';
import { ensureThemeStyle } from '../theme.js';
import { SessionInfoArea } from './SessionInfoArea.js';

/** 轮盘几何（px）：容器边长 / 中心 / 固定半径。 */
const SIZE = 196;
const CENTER = SIZE / 2;
const R = 64; // 八边形顶点到中心（无鼓起、连续形变）
const DRAG_SLOP = 4; // 位移小于它算点击（切换锁定），否则算拖动（换挡）
const DEAD = 14 * (Math.PI / 180); // 边中点阻尼死区（度数 → 弧度）
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** 第 i 角的角度（i=0 从正上开始，顺时针与 HALL_CATALOG 词表序一致）。 */
function cornerAngle(i: number): number {
  return (-90 + i * 45) * DEG;
}

/** 第 i 角的坐标。 */
function cornerPos(i: number): { left: number; top: number } {
  const a = cornerAngle(i);
  return { left: CENTER + R * Math.cos(a), top: CENTER + R * Math.sin(a) };
}

/** 把任意角归一化到 [-π, π)。 */
function normAngle(a: number): number {
  while (a < -Math.PI) a += TAU;
  while (a >= Math.PI) a -= TAU;
  return a;
}

/** 指针角度 → 最近角索引（结果永远是整数 0-7）。 */
function angleIndex(a: number): number {
  let t = a + 90 * DEG;
  while (t < 0) t += TAU;
  while (t >= TAU) t -= TAU;
  return Math.round(t / (45 * DEG)) % 8;
}

/** 带边中点阻尼的换挡 snap。当前停在 cur，指针角度 p；
 *  越过中点但未出死区时保持 cur（阻尼），过死区后 snap 到邻角。 */
function snapIndex(p: number, cur: number): number {
  const cand = angleIndex(p);
  if (cand === cur) return cur;
  const curA = cornerAngle(cur);
  const candA = cornerAngle(cand);
  const dir = Math.sign(normAngle(candA - curA)) || 1;
  const edge = curA + dir * (22.5 * DEG);
  // 死区覆盖边中点：指针在边中点 ±DEAD 内时保持原角（阻尼大）
  if (Math.abs(normAngle(p - edge)) < DEAD) return cur;
  return cand;
}

export function HallWheel(props: {
  mode: string;
  /** 会话级域锁定（单选语义）：空数组 = 中心（智能档）；[id] = 以该角为主题。 */
  halls: string[];
  hallIncludeUnlabeled: boolean;
  hallIncludeGeneral: boolean;
  onCommit(key: string): void;
  /** 锁定提交：[id] = 以该角为主题；null = 回中心（清除锁定）。 */
  onCommitHall(halls: string[] | null): void;
  onCommitHallBoundaries(patch: { includeUnlabeled?: boolean; includeGeneral?: boolean }): void;
  /** 会话级注入覆盖（复用既有控件）：缺省 = 浮层不渲染注入行。 */
  recall?: boolean | null;
  onCommitRecall?(next: boolean | null): void;
  rpc: RpcFn;
  sessionId: string;
  error?: string | null;
}) {
  ensureThemeStyle();
  const isOff = props.mode === 'off';
  const [overview, setOverview] = useState<HallOverviewResponse | null>(null);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // 回填后的轮询计时器（卸载时统一清除）
  const timersRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const t of timersRef.current) window.clearTimeout(t);
    },
    [],
  );

  // 角计数与词表随打开拉取一次
  useEffect(() => {
    let alive = true;
    props
      .rpc('dsh-memory/hall-overview', {})
      .then((r) => {
        if (!alive) return;
        if (r && r.ok) setOverview(r.value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [props.rpc]);

  const cornerCount = (id: string): number | null => {
    if (!overview) return null;
    if (id === 'general') return overview.general;
    return overview.corners.find((c) => c.id === id)?.count ?? 0;
  };

  /** 一键回填：对存量未打标记忆批量补打 hall 标签。 */
  const backfill = () => {
    if (backfillBusy || !overview || overview.unlabeled === 0) return;
    setBackfillBusy(true);
    setLocalError(null);
    let polls = 0;
    const finish = () => setBackfillBusy(false);
    const tick = () => {
      polls++;
      props
        .rpc('dsh-memory/hall-overview', {})
        .then((r) => {
          const v = r && r.ok ? r.value : null;
          if (v) setOverview(v);
          if ((v && v.unlabeled === 0) || polls >= 20) finish();
          else {
            const t = window.setTimeout(tick, 3000);
            timersRef.current.push(t);
          }
        })
        .catch(() => finish());
    };
    props
      .rpc('dsh-memory/hall-backfill', {})
      .then((r) => {
        if (!r || !r.ok) {
          setLocalError(r && r.error ? '回填失败：' + r.error.message : '回填失败');
          finish();
          return;
        }
        timersRef.current.push(window.setTimeout(tick, 3000));
      })
      .catch((e: unknown) => {
        setLocalError('回填失败：' + String((e && (e as Error).message) || e));
        finish();
      });
  };

  // ── 离散换挡：档位永远是整数角，弹簧 needle 负责视觉弹入 ──
  const boxRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const downIndexRef = useRef<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const lockedIndex =
    props.halls.length === 1
      ? (overview?.corners.findIndex((c) => c.id === props.halls[0]) ?? null)
      : null;
  const activeIndex = dragIndex ?? lockedIndex ?? null;

  // 弹簧 needle：target 随 activeIndex 切角，过中点后弹向新角
  const needleRef = useRef(activeIndex != null ? cornerAngle(activeIndex) : -Math.PI / 2);
  const targetRef = useRef(needleRef.current);
  const velRef = useRef(0);
  const [needle, setNeedle] = useState(needleRef.current);
  useEffect(() => {
    targetRef.current = activeIndex != null ? cornerAngle(activeIndex) : -Math.PI / 2;
  }, [activeIndex]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const cur = needleRef.current;
      const tgt = targetRef.current;
      const diff = Math.atan2(Math.sin(tgt - cur), Math.cos(tgt - cur));
      velRef.current += diff * 0.12; // 弹簧刚度
      velRef.current *= 0.78; // 阻尼
      needleRef.current += velRef.current;
      if (Math.abs(diff) > 0.002 || Math.abs(velRef.current) > 0.002) {
        setNeedle(needleRef.current);
      } else if (Math.abs(diff) > 0.0001) {
        needleRef.current = tgt;
        setNeedle(tgt);
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  const pointAngle = (clientX: number, clientY: number) => {
    const box = boxRef.current;
    if (!box) return { angle: 0, dist: 0 };
    const r = box.getBoundingClientRect();
    const scale = r.width / SIZE || 1;
    const dx = (clientX - (r.left + CENTER * scale)) / scale;
    const dy = (clientY - (r.top + CENTER * scale)) / scale;
    return { angle: Math.atan2(dy, dx), dist: Math.hypot(dx, dy) };
  };

  const onBoxDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isOff) return;
    const { angle, dist } = pointAngle(e.clientX, e.clientY);
    if (dist < 24) return; // 中心区由中心按钮处理
    e.currentTarget.setPointerCapture?.(e.pointerId);
    movedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    const idx = angleIndex(angle);
    downIndexRef.current = idx;
    setDragIndex(idx);
  };
  const onBoxMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const s = startRef.current;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > DRAG_SLOP) movedRef.current = true;
    if (!movedRef.current) return;
    const { angle } = pointAngle(e.clientX, e.clientY);
    const cur = dragIndex ?? lockedIndex ?? 0;
    const cand = snapIndex(angle, cur);
    if (cand !== dragIndex) setDragIndex(cand);
  };
  const onBoxUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const moved = movedRef.current;
    const di = downIndexRef.current;
    startRef.current = null;
    downIndexRef.current = null;
    setDragIndex(null);
    const id = di != null ? overview?.corners[di]?.id : undefined;
    if (!id) return;
    if (!moved) {
      // 点击：切换该角锁定
      const active = props.halls.includes(id);
      props.onCommitHall(active ? null : [id]);
    } else {
      // 拖动换挡：以最终档位为主题
      if (!props.halls.includes(id)) props.onCommitHall([id]);
    }
  };

  // 固定正八边形顶点
  const polyPoints = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const p = cornerPos(i);
    return `${p.left},${p.top}`;
  }).join(' ');

  const grayStyle: CSSProperties = isOff
    ? { opacity: 0.45, pointerEvents: 'none' as const }
    : {};

  return (
    <div style={{ width: SIZE }}>
      {/* ── 图形内：固定正八边形 + 弹簧 needle ── */}
      <div
        ref={boxRef}
        style={{ position: 'relative', width: SIZE, height: SIZE, ...grayStyle }}
        onPointerDown={onBoxDown}
        onPointerMove={onBoxMove}
        onPointerUp={onBoxUp}
        onPointerCancel={onBoxUp}
      >
        <svg
          width={SIZE}
          height={SIZE}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          aria-hidden="true"
        >
          {/* 中性基线参考八边形（虚线） */}
          <polygon
            points={polyPoints}
            fill="none"
            stroke="var(--dsh-mem-hall-line)"
            strokeWidth="1"
            strokeDasharray="3 3"
            opacity={0.45}
          />
          {/* 实线八边形 */}
          <polygon
            points={polyPoints}
            fill="none"
            stroke="var(--dsh-mem-hall-line)"
            strokeWidth="1"
          />
          {/* 8 条固定辐条 */}
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
            const p = cornerPos(i);
            return (
              <line
                key={'spoke' + i}
                x1={CENTER}
                y1={CENTER}
                x2={p.left}
                y2={p.top}
                stroke="var(--dsh-mem-hall-line)"
                strokeWidth="1"
              />
            );
          })}
          {/* 弹簧 needle：过中点后从旧角弹入新角（类似换挡指针） */}
          <line
            x1={CENTER}
            y1={CENTER}
            x2={CENTER + R * Math.cos(needle)}
            y2={CENTER + R * Math.sin(needle)}
            stroke="var(--dsh-mem-hall-corner-on)"
            strokeWidth="2.5"
            strokeLinecap="round"
            opacity={activeIndex != null ? 0.9 : 0.25}
          />
        </svg>
        {/* 中心 = 智能档：点击回中心 = 全域 */}
        <button
          type="button"
          title="智能档：自动判断召回各域（回中心 = 全域）"
          onClick={() => props.onCommitHall(null)}
          style={{
            position: 'absolute',
            left: CENTER,
            top: CENTER,
            transform: 'translate(-50%, -50%)',
            width: 46,
            height: 46,
            borderRadius: '50%',
            border:
              props.halls.length === 0
                ? '1.5px solid var(--dsh-mem-hall-corner-on)'
                : '1px solid var(--dsh-mem-hall-line)',
            background: 'var(--dsh-mem-bg-card)',
            color:
              props.halls.length === 0
                ? 'var(--dsh-mem-hall-corner-on)'
                : 'var(--dsh-mem-hall-corner)',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          智能
        </button>
        {/* 8 角 = 域：视觉层，pointerEvents none（命中统一由 box 处理） */}
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
          const corner = overview?.corners[i];
          const id = corner?.id;
          const label = corner?.label ?? LABEL_FALLBACK[i] ?? `域${i + 1}`;
          const count = id ? cornerCount(id) : null;
          const active = activeIndex === i;
          const dim = activeIndex != null && !active;
          const empty = count === 0;
          const p = cornerPos(i);
          return (
            <div
              key={id ?? i}
              title={
                id
                  ? `「${label}」${count ?? 0} 条\n点按/拖动 = 以该角为主题（抑制其他角）`
                  : '词表加载中'
              }
              style={{
                position: 'absolute',
                left: p.left,
                top: p.top,
                transform: 'translate(-50%, -50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 0,
                padding: '1px 4px',
                borderRadius: 8,
                border: active
                  ? '1.5px solid var(--dsh-mem-hall-corner-on)'
                  : '1px solid transparent',
                background: active ? 'var(--dsh-mem-accent-weak)' : 'transparent',
                color: active
                  ? 'var(--dsh-mem-hall-corner-on)'
                  : empty
                    ? 'var(--dsh-mem-hall-empty)'
                    : 'var(--dsh-mem-hall-corner)',
                fontSize: 9.5,
                lineHeight: '12px',
                fontWeight: active ? 600 : 400,
                whiteSpace: 'nowrap',
                maxWidth: 58,
                opacity: dim ? 0.45 : 1,
                pointerEvents: 'none',
              }}
            >
              <span>{label}</span>
              {/* 空角诚实展示：不写"0 条" */}
              <span style={{ fontSize: 8, opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>
                {count === null ? ' ' : empty ? '空角' : `${count} 条`}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── 图形外：垂直堆叠以收敛宽度 ── */}
      {/* 锁角时的边界开关（D1）：未打标默认包含 / 跨域 general 默认不含；off 时禁用 */}
      {props.halls.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            marginTop: 10,
            opacity: isOff ? 0.45 : undefined,
            pointerEvents: isOff ? 'none' : undefined,
          }}
        >
          <span
            style={{ fontSize: 11, color: 'var(--dsh-mem-text-3)' }}
            title="锁定域时两类无角记忆是否参与召回"
          >
            {overview ? `另有 ${overview.unlabeled} 条未打标` : '未打标'}
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Segmented
              value={props.hallIncludeUnlabeled ? 'in' : 'ex'}
              options={[
                { key: 'in', label: '含未打标', title: '未打标记忆默认包含' },
                { key: 'ex', label: '不含', title: '锁定域时排除未打标记忆' },
              ]}
              onChange={(key) => props.onCommitHallBoundaries({ includeUnlabeled: key === 'in' })}
            />
            <Segmented
              value={props.hallIncludeGeneral ? 'in' : 'ex'}
              options={[
                { key: 'in', label: '含跨域', title: '跨域（general）兜底记忆也参与召回' },
                { key: 'ex', label: '不含', title: '跨域与单主题相悖，默认不含' },
              ]}
              onChange={(key) => props.onCommitHallBoundaries({ includeGeneral: key === 'in' })}
            />
          </div>
        </div>
      ) : null}

      {/* 会话闸：off = 本会话完全隐身 */}
      <Row label="会话">
        <Segmented
          value={isOff ? 'off' : 'on'}
          options={[
            { key: 'on', label: '启用', title: '本会话正常捕获/蒸馏/注入记忆' },
            {
              key: 'off',
              label: '关闭',
              title: '本会话对记忆系统隐身：不捕获、不蒸馏、不注入（数据保留）',
            },
          ]}
          onChange={(key) => props.onCommit(key === 'off' ? 'off' : 'auto')}
        />
      </Row>

      {/* 是否注入三态（off 档禁用） */}
      {props.recall !== undefined && props.onCommitRecall ? (
        <Row label="注入">
          <Segmented
            value={props.recall === null ? 'follow' : props.recall ? 'on' : 'off'}
            disabled={isOff}
            options={[
              { key: 'follow', label: '跟随全局', title: '清除本会话覆盖，跟随全局召回开关' },
              { key: 'on', label: '开', title: '本会话强制注入记忆' },
              { key: 'off', label: '关', title: '只写：记忆照常沉淀，但不注入本会话' },
            ]}
            onChange={(key) => props.onCommitRecall!(key === 'on' ? true : key === 'off' ? false : null)}
          />
        </Row>
      ) : null}

      {/* 未打标回填 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          marginTop: 10,
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--dsh-mem-text-3)' }}>
          {overview ? `未打标 ${overview.unlabeled} 条` : '未打标计数加载中'}
        </span>
        <ActionButton
          label={backfillBusy ? '回填中…' : '回填'}
          title="对存量未打标记忆批量补打 hall 标签"
          disabled={!overview || overview.unlabeled === 0 || backfillBusy}
          onClick={() => backfill()}
        />
      </div>

      {props.error || localError ? (
        <div style={{ fontSize: 11, color: 'var(--dsh-mem-danger)', marginTop: 8 }}>
          {props.error || localError}
        </div>
      ) : null}

      {/* 会话信息区 */}
      <SessionInfoArea rpc={props.rpc} sessionId={props.sessionId} />
    </div>
  );
}

/** label 在上、控件在下的紧凑行（宽度收敛用）。 */
function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginTop: 10,
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>{props.label}</span>
      {props.children}
    </div>
  );
}

/** 词表未送达时的兜底显示（正常路径由 hall-overview 下发的 label 取代）。 */
const LABEL_FALLBACK = ['工作', '人际', '学习', '创作娱乐', '居家', '健康', '财务', '出行'];

/** 水平视口夹持（手机端适配）：浮层以 pill 中心为轴悬浮，窄视口下贴边平移。 */
export function useViewportClamp(popRef: RefObject<HTMLDivElement | null>): number {
  const shiftRef = useRef(0);
  const [shiftX, setShiftX] = useState(0);
  useEffect(() => {
    const clamp = () => {
      const el = popRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      const left = r.left - shiftRef.current;
      const edge = 8;
      let next = 0;
      if (left < edge) next = edge - left;
      else if (left + r.width > window.innerWidth - edge) {
        next = window.innerWidth - edge - (left + r.width);
      }
      if (next !== shiftRef.current) {
        shiftRef.current = next;
        setShiftX(next);
      }
    };
    clamp();
    window.addEventListener('resize', clamp);
    const iv = window.setInterval(clamp, 100);
    return () => {
      window.removeEventListener('resize', clamp);
      window.clearInterval(iv);
    };
  }, [popRef]);
  return shiftX;
}
