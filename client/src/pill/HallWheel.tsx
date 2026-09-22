/**
 * 八边形域轮（hall 主题轴门面，Phase 2 多选 + 可拖动配额）。
 *
 * 图形内：8 角 = 域（该域 N 条；0 条为空角态）+ 中心 = 智能档（自动判断过滤）。
 *   - **点角** = 会话级锁定：以该角为主题，其他角被抑制（召回硬过滤，手动挡）；
 *   - **拖角** = 调该域召回配额/权重（0 = 抑制 / 1 = 中性 / 1.5 = 上限），写回会话级，
 *     在智能档（中心）的软门禁上生效；
 *   - **点中心** = 回全域（智能档软门禁）。
 * 几何：多边形顶点与辐条**都由各角当前半径推导** → 拖动时相邻两条边与辐条同帧跟随
 *   （不存在"只有辐条动、边不动"的错位）；中性基线另画一圈虚线参考八边形。
 * 尺寸：容器边长压到 196px（原 236），适配窄栏输入栏浮层。
 * 图形外：会话关闭闸 / 注入三态 / 边界开关 / 强制单族覆写 / 未打标回填 / 权重复位。
 *
 * 数据：角计数来自 dsh-memory/hall-overview（打开时拉取，词表单一事实源随之下发）。
 * 层级：设置页全局闸 ⊃ 会话闸（图形外）⊃ 域范围（图形内）。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { Segmented, ActionButton } from '../ui/controls.js';
import type { RpcFn } from '../rpc.js';
import type { HallOverviewResponse } from '../../../src/contract.js';
import { HALL_WEIGHT_MAX, HALL_WEIGHT_NEUTRAL } from '../../../src/domain-gate.js';
import { ensureThemeStyle } from '../theme.js';
import { ModeSlider } from './ModeSlider.js';
import { SessionInfoArea } from './SessionInfoArea.js';

/** 轮盘几何（px）：容器边长 / 中心 / 半径区间（权重 0 → MAX 的映射端点）。 */
const SIZE = 196;
const CENTER = SIZE / 2;
const R_MIN = 28;
const R_MAX = 74;
/** 拖动判定阈值（px）：位移小于它算点击（切主题），否则算拖动（调配额）。 */
const DRAG_SLOP = 4;

/** 第 i 角的坐标（i=0 从正上开始，顺时针与 HALL_CATALOG 词表序一致）。 */
function cornerPos(i: number, radius: number): { left: number; top: number } {
  const a = ((-90 + i * 45) * Math.PI) / 180;
  return { left: CENTER + radius * Math.cos(a), top: CENTER + radius * Math.sin(a) };
}

/** 权重 → 半径（clamp 到 [0, MAX]）。 */
function radiusOfWeight(w: number): number {
  const c = Math.max(0, Math.min(HALL_WEIGHT_MAX, w));
  return R_MIN + (R_MAX - R_MIN) * (c / HALL_WEIGHT_MAX);
}

/** 半径 → 权重（clamp 到 [0, MAX]，量化到 0.05 步长，避免写盘抖出一堆小数）。 */
function weightOfRadius(r: number): number {
  const raw = ((r - R_MIN) / (R_MAX - R_MIN)) * HALL_WEIGHT_MAX;
  return Math.round(Math.max(0, Math.min(HALL_WEIGHT_MAX, raw)) * 20) / 20;
}

/** 权重标记（中性不显）：加权 ▲ / 减权 ▼ / 抑制 ⊘。 */
function weightMark(w: number): string {
  if (Math.abs(w - HALL_WEIGHT_NEUTRAL) < 0.02) return '';
  if (w <= 0) return '⊘';
  return w > HALL_WEIGHT_NEUTRAL ? '▲' : '▼';
}

export function HallWheel(props: {
  mode: string;
  /** 会话级域锁定（多选）：空数组 = 中心（智能档）；非空 = 以这些角为主题、抑制其余。 */
  halls: string[];
  hallIncludeUnlabeled: boolean;
  hallIncludeGeneral: boolean;
  /** 会话级域权重（角 id → 权重；未拖过的角不落键 = 中性）。 */
  hallWeights: Record<string, number>;
  onCommit(key: string): void;
  /** 锁定提交：角 id 数组 = 多选锁定；null = 回中心（清除全部锁定）。 */
  onCommitHall(halls: string[] | null): void;
  onCommitHallBoundaries(patch: { includeUnlabeled?: boolean; includeGeneral?: boolean }): void;
  /** 权重提交（全量替换；空对象 = 全部复位中性）。 */
  onCommitHallWeights(weights: Record<string, number>): void;
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
  // 回填后的轮询计时器（卸载时统一清除，避免对已卸载组件 setState）
  const timersRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const t of timersRef.current) window.clearTimeout(t);
    },
    [],
  );

  // 角计数与词表随打开拉取一次（非热路径端点；失败降级为只画角不显计数）
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

  /** 一键回填（task_15）：从"未打标 M"入口触发存量 null 记录的批量打标（后台任务）。
   *  端点立即返回；启动后轮询 hall-overview 让角计数与"未打标 M"渐进更新。 */
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
          // 结束条件：未打标清零，或轮询次数用尽（后台任务单飞，端点不暴露进度）
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
        // 端点立即返回（单飞后台任务），"回填中…"由轮询负责收尾
        timersRef.current.push(window.setTimeout(tick, 3000));
      })
      .catch((e: unknown) => {
        setLocalError('回填失败：' + String((e && (e as Error).message) || e));
        finish();
      });
  };

  // ── 拖动状态：拖动中的角用本地值渲染，松手才提交（避免每帧打 RPC） ──
  const [drag, setDrag] = useState<{ i: number; w: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const movedRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const weights = props.hallWeights ?? {};

  const weightAt = (id: string | undefined, i: number): number => {
    if (drag && drag.i === i) return drag.w;
    if (!id) return HALL_WEIGHT_NEUTRAL;
    return weights[id] ?? HALL_WEIGHT_NEUTRAL;
  };
  const radiusAt = (i: number, id?: string): number => radiusOfWeight(weightAt(id, i));
  const commitWeight = (id: string, w: number) => {
    props.onCommitHallWeights({ ...weights, [id]: Math.round(w * 20) / 20 });
  };

  const onCornerDown =
    (i: number, id: string | undefined) => (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (!id || isOff) return;
      movedRef.current = false;
      startRef.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDrag({ i, w: weightAt(id, i) });
    };
  const onCornerMove = (i: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.i !== i) return;
    const box = boxRef.current;
    if (!box) return;
    const s = startRef.current;
    if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > DRAG_SLOP) movedRef.current = true;
    if (!movedRef.current) return;
    const r = box.getBoundingClientRect();
    // 浮层可能被 transform 平移/缩放：按 rect 尺寸换算回布局坐标
    const scale = r.width / SIZE || 1;
    const dx = (e.clientX - (r.left + CENTER * scale)) / scale;
    const dy = (e.clientY - (r.top + CENTER * scale)) / scale;
    setDrag({ i, w: weightOfRadius(Math.hypot(dx, dy)) });
  };
  const onCornerUp =
    (i: number, id: string | undefined) => (e: ReactPointerEvent<HTMLButtonElement>) => {
      const d = drag;
      if (!d || d.i !== i) return;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      setDrag(null);
      startRef.current = null;
      if (!id) return;
      if (movedRef.current) commitWeight(id, d.w);
      else {
        // 未越过阈值 = 点击：切换该角的主题锁定（多选；清空 = 回中心）
        const active = props.halls.includes(id);
        const next = active ? props.halls.filter((x) => x !== id) : [...props.halls, id];
        props.onCommitHall(next.length > 0 ? next : null);
      }
    };
  /** 键盘可达：↑/↓ 调权重（±0.1），Home 回中性。 */
  const onCornerKey =
    (id: string | undefined, i: number) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!id || isOff) return;
      const cur = weightAt(id, i);
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        commitWeight(
          id,
          Math.max(0, Math.min(HALL_WEIGHT_MAX, cur + (e.key === 'ArrowUp' ? 0.1 : -0.1))),
        );
      } else if (e.key === 'Home') {
        e.preventDefault();
        commitWeight(id, HALL_WEIGHT_NEUTRAL);
      }
    };

  // 骨架：实时多边形（顶点 = 各角当前半径）+ 中性基线虚线参考八边形
  const polyPoints = [0, 1, 2, 3, 4, 5, 6, 7]
    .map((i) => {
      const p = cornerPos(i, radiusAt(i, overview?.corners[i]?.id));
      return `${p.left},${p.top}`;
    })
    .join(' ');
  const neutralPoints = [0, 1, 2, 3, 4, 5, 6, 7]
    .map((i) => {
      const p = cornerPos(i, radiusOfWeight(HALL_WEIGHT_NEUTRAL));
      return `${p.left},${p.top}`;
    })
    .join(' ');

  const grayStyle: CSSProperties = isOff
    ? { opacity: 0.45, pointerEvents: 'none' as const }
    : {};
  // 主题锁定态：非主题的角整体淡化（"以该角为主题、抑制其他角"的可视表达）
  const themed = props.halls.length > 0;

  return (
    <div style={{ width: SIZE }}>
      {/* ── 图形内：八边形 ── */}
      <div ref={boxRef} style={{ position: 'relative', width: SIZE, height: SIZE, ...grayStyle }}>
        <svg
          width={SIZE}
          height={SIZE}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          aria-hidden="true"
        >
          {/* 中性基线（权重 1 的参考八边形）：看得出某角是加权还是减权 */}
          <polygon
            points={neutralPoints}
            fill="none"
            stroke="var(--dsh-mem-hall-line)"
            strokeWidth="1"
            strokeDasharray="3 3"
            opacity={0.5}
          />
          {/* 实时多边形：顶点随拖动半径走 → 相邻两条边同步形变 */}
          <polygon points={polyPoints} fill="none" stroke="var(--dsh-mem-hall-line)" strokeWidth="1" />
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
            const p = cornerPos(i, radiusAt(i, overview?.corners[i]?.id));
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
        </svg>
        {/* 中心 = 智能档：点击回中心 = 全域（清除会话级域锁定） */}
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
        {/* 8 角 = 域：点击锁定（主题）/ 拖动调配额；权重 0 = 抑制 */}
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
          const corner = overview?.corners[i];
          const id = corner?.id;
          const label = corner?.label ?? LABEL_FALLBACK[i] ?? `域${i + 1}`;
          const count = id ? cornerCount(id) : null;
          const w = weightAt(id, i);
          const active = id !== undefined && props.halls.includes(id);
          const suppressed = w <= 0;
          const empty = count === 0;
          const dim = themed && !active;
          const p = cornerPos(i, radiusAt(i, id));
          return (
            <button
              key={id ?? i}
              type="button"
              title={
                id
                  ? `「${label}」${count ?? 0} 条 · 权重 ×${w.toFixed(2)}${suppressed ? '（已抑制：本会话不召回）' : ''}\n点按=以该角为主题（抑制其他角）／拖动=调配额／↑↓ 微调`
                  : '词表加载中'
              }
              disabled={!id}
              onPointerDown={onCornerDown(i, id)}
              onPointerMove={onCornerMove(i)}
              onPointerUp={onCornerUp(i, id)}
              onPointerCancel={onCornerUp(i, id)}
              onKeyDown={onCornerKey(id, i)}
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
                  : suppressed
                    ? '1px dashed var(--dsh-mem-hall-empty)'
                    : '1px solid transparent',
                background: active ? 'var(--dsh-mem-accent-weak)' : 'transparent',
                color: active
                  ? 'var(--dsh-mem-hall-corner-on)'
                  : empty || suppressed
                    ? 'var(--dsh-mem-hall-empty)'
                    : 'var(--dsh-mem-hall-corner)',
                fontSize: 9.5,
                lineHeight: '12px',
                fontWeight: active ? 600 : 400,
                cursor: id ? (drag && drag.i === i ? 'grabbing' : 'grab') : 'default',
                whiteSpace: 'nowrap',
                touchAction: 'none',
                maxWidth: 60,
                opacity: dim ? 0.42 : 1,
              }}
            >
              <span>
                {label}
                {weightMark(w) ? (
                  <span style={{ fontSize: 8, opacity: 0.9 }}> {weightMark(w)}</span>
                ) : null}
              </span>
              {/* 空角诚实展示（R11）：不写"0 条"；抑制态优先标"抑制" */}
              <span style={{ fontSize: 8, opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>
                {count === null ? ' ' : suppressed ? '抑制' : empty ? '空角' : `${count} 条`}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── 图形外：会话闸 + 边界开关 + 覆写滑轨 ── */}
      {/* 锁角时的边界开关（D1）：未打标默认包含 / 跨域 general 默认不含；off 时禁用 */}
      {props.halls.length > 0 ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            marginTop: 8,
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
          <span style={{ display: 'flex', gap: 8 }}>
            <Segmented
              value={props.hallIncludeUnlabeled ? 'in' : 'ex'}
              options={[
                { key: 'in', label: '含未打标', title: '未打标记忆默认包含（默认排除会静默丢掉一半语料）' },
                { key: 'ex', label: '不含', title: '锁定域时排除未打标记忆' },
              ]}
              onChange={(key) => props.onCommitHallBoundaries({ includeUnlabeled: key === 'in' })}
            />
            <Segmented
              value={props.hallIncludeGeneral ? 'in' : 'ex'}
              options={[
                { key: 'in', label: '含跨域', title: '跨域（general）兜底记忆也参与召回' },
                { key: 'ex', label: '不含', title: '跨域与单主题相悖，默认不含（可切换）' },
              ]}
              onChange={(key) => props.onCommitHallBoundaries({ includeGeneral: key === 'in' })}
            />
          </span>
        </div>
      ) : null}

      {/* 会话闸（图形外，复用既有语义）：off = 本会话完全隐身（不捕获/不蒸馏/不注入，数据保留） */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          marginTop: 10,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>会话</span>
        <Segmented
          value={isOff ? 'off' : 'on'}
          options={[
            { key: 'on', label: '启用', title: '本会话正常捕获/蒸馏/注入记忆' },
            {
              key: 'off',
              label: '关闭',
              title: '本会话对记忆系统隐身：不捕获、不蒸馏、不注入（数据保留，不改全局）',
            },
          ]}
          onChange={(key) => props.onCommit(key === 'off' ? 'off' : 'auto')}
        />
      </div>
      {/* 是否注入三态（复用既有会话覆盖控件；off 档禁用——完全隐身包含注入） */}
      {props.recall !== undefined && props.onCommitRecall ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            marginTop: 8,
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>注入</span>
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
        </div>
      ) : null}
      {/* 强制单族覆写（档位降级后的覆写面板；off 档整体置灰禁用） */}
      <div
        style={{
          borderTop: '1px solid var(--dsh-mem-border)',
          marginTop: 10,
          paddingTop: 10,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          opacity: isOff ? 0.45 : undefined,
          pointerEvents: isOff ? 'none' : undefined,
        }}
      >
        <span
          style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}
          title="覆写蒸馏族判定；默认跟随智能档"
        >
          强制单族
        </span>
        <ModeSlider mode={props.mode === 'off' ? 'auto' : props.mode} onCommit={props.onCommit} />
      </div>
      {/* 未打标 M + 一键回填入口（task_15 接线；空角/存量不回填则门面立着显空） */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          marginTop: 10,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: 'var(--dsh-mem-text-3)',
            flex: 1,
            minWidth: 0,
            marginRight: 8,
          }}
        >
          {overview
            ? `未打标 ${overview.unlabeled} 条（存量待回填）`
            : '未打标计数加载中'}
        </span>
        {/* 动作而非选择：Segmented 对已选中项有 `!on` 守卫（点不动），故用 ActionButton */}
        <ActionButton
          label={backfillBusy ? '回填中…' : '一键回填'}
          title="对存量未打标记忆批量补打 hall 标签（复用抽取打标路径）"
          disabled={!overview || overview.unlabeled === 0 || backfillBusy}
          onClick={() => backfill()}
        />
      </div>
      {/* 权重复位：拖过才出现（回中性 = 全部交还给智能档自动判定） */}
      {Object.keys(weights).length > 0 ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            marginTop: 8,
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--dsh-mem-text-3)' }}>
            已手动调整 {Object.keys(weights).length} 个域配额
          </span>
          <ActionButton
            label="权重复位"
            title="清除本会话的全部域配额偏置，交还智能档自动判定"
            disabled={isOff}
            onClick={() => props.onCommitHallWeights({})}
          />
        </div>
      ) : null}
      {props.error || localError ? (
        <div style={{ fontSize: 11, color: 'var(--dsh-mem-danger)', marginTop: 8 }}>
          {props.error || localError}
        </div>
      ) : null}
      {/* 会话信息区（session-stats 热路径端点；宿主不支持时整体不渲染） */}
      <SessionInfoArea rpc={props.rpc} sessionId={props.sessionId} />
    </div>
  );
}

/** 词表未送达时的兜底显示（正常路径由 hall-overview 下发的 label 取代）。 */
const LABEL_FALLBACK = ['工作', '人际', '学习', '创作娱乐', '居家', '健康', '财务', '出行'];

/** 水平视口夹持（手机端适配）：浮层以 pill 中心为轴悬浮，窄视口下贴边平移。 */
export function useViewportClamp(popRef: RefObject<HTMLDivElement | null>): number {
  const shiftRef = useRef(0);
  const [shiftX, setShiftX] = useState(0);
  useLayoutEffect(() => {
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
