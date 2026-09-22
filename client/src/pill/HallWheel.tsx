/**
 * 八边形域轮（hall 主题轴门面，Phase 1 单选）。
 *
 * 图形内：8 角 = 域（该域 N 条；0 条为空角态）+ 中心 = 智能档（自动判断过滤）。
 *   点角 = 会话级锁定该域（召回硬过滤，手动挡）；点中心 = 回全域（智能档软门禁）。
 * 图形外（同浮层排布，不新建 RPC）：① 会话关闭闸（off = 完全隐身）；
 *   ② 是否注入三态（复用既有会话覆盖）；③ 未打标 / 跨域边界开关（仅锁角时有效）；
 *   ④ "强制单族"覆写滑轨（ModeSlider 降级后的载体）；⑤ 未打标计数 + 一键回填入口。
 *
 * 数据：角计数来自 dsh-memory/hall-overview（打开时拉取，词表单一事实源随之下发）。
 * 层级：设置页全局闸 ⊃ 会话闸（图形外）⊃ 域范围（图形内）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Segmented, ActionButton } from '../ui/controls.js';
import type { RpcFn } from '../rpc.js';
import type { HallOverviewResponse } from '../../../src/contract.js';
import { ensureThemeStyle } from '../theme.js';
import { ModeSlider } from './ModeSlider.js';
import { SessionInfoArea } from './SessionInfoArea.js';

/** 轮盘几何（px）：容器边长 / 角点轨道半径 / 中心圆半径。 */
const SIZE = 236;
const CENTER = SIZE / 2;
const R_CORNER = 86;
const R_POLY = 66;

/** 第 i 角的坐标（i=0 从正上开始，顺时针与 HALL_CATALOG 词表序一致）。 */
function cornerPos(i: number, radius: number): { left: number; top: number } {
  const a = ((-90 + i * 45) * Math.PI) / 180;
  return { left: CENTER + radius * Math.cos(a), top: CENTER + radius * Math.sin(a) };
}

export function HallWheel(props: {
  mode: string;
  /** 会话级域锁定（多选）：空数组 = 中心（智能档）。 */
  halls: string[];
  hallIncludeUnlabeled: boolean;
  hallIncludeGeneral: boolean;
  onCommit(key: string): void;
  /** 锁定提交：角 id 数组 = 多选锁定；null = 回中心（清除全部锁定）。 */
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
  const labelOf = (id: string): string =>
    overview?.corners.find((c) => c.id === id)?.label ?? id;

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

  // 八边形骨架（连线 + 外框）：纯装饰层，pointer-events none 不挡角点按钮
  const polyPoints = [0, 1, 2, 3, 4, 5, 6, 7]
    .map((i) => {
      const p = cornerPos(i, R_POLY);
      return `${p.left},${p.top}`;
    })
    .join(' ');

  const grayStyle: CSSProperties = isOff
    ? { opacity: 0.45, pointerEvents: 'none' as const }
    : {};

  return (
    <div>
      {/* ── 图形内：八边形 ── */}
      <div style={{ position: 'relative', width: SIZE, height: SIZE, ...grayStyle }}>
        <svg
          width={SIZE}
          height={SIZE}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          aria-hidden="true"
        >
          <polygon
            points={polyPoints}
            fill="none"
            stroke="var(--dsh-mem-hall-line)"
            strokeWidth="1"
          />
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
            const p = cornerPos(i, R_CORNER);
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
            width: 52,
            height: 52,
            borderRadius: '50%',
            border: props.halls.length === 0 ? '1.5px solid var(--dsh-mem-hall-corner-on)' : '1px solid var(--dsh-mem-hall-line)',
            background: 'var(--dsh-mem-bg-card)',
            color: props.halls.length === 0 ? 'var(--dsh-mem-hall-corner-on)' : 'var(--dsh-mem-hall-corner)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          智能
        </button>
        {/* 8 角 = 域：点击锁定（会话级硬过滤）；选中角高亮 */}
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
          const corner = overview?.corners[i];
          const id = corner?.id;
          const label = corner?.label ?? LABEL_FALLBACK[i] ?? `域${i + 1}`;
          const count = id ? cornerCount(id) : null;
          const active = id !== undefined && props.halls.includes(id);
          const empty = count === 0;
          const p = cornerPos(i, R_CORNER);
          // Phase 2 多选：点击切换该角在锁定集里的存在；回中心 = 清空
          return (
            <button
              key={id ?? i}
              type="button"
              title={
                id
                  ? `锁定「${label}」域：本会话只召回该域${empty ? '（当前空角）' : `（${count} 条）`}`
                  : '词表加载中'
              }
              disabled={!id}
              onClick={() => {
                if (!id) return;
                const next = active ? props.halls.filter((x) => x !== id) : [...props.halls, id];
                props.onCommitHall(next.length > 0 ? next : null);
              }}
              style={{
                position: 'absolute',
                left: p.left,
                top: p.top,
                transform: 'translate(-50%, -50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 0,
                padding: '2px 6px',
                borderRadius: 8,
                border: active ? '1.5px solid var(--dsh-mem-hall-corner-on)' : '1px solid transparent',
                background: active ? 'var(--dsh-mem-accent-weak)' : 'transparent',
                color: active
                  ? 'var(--dsh-mem-hall-corner-on)'
                  : empty
                    ? 'var(--dsh-mem-hall-empty)'
                    : 'var(--dsh-mem-hall-corner)',
                fontSize: 11,
                lineHeight: '14px',
                fontWeight: active ? 600 : 400,
                cursor: id ? 'pointer' : 'default',
                whiteSpace: 'nowrap',
              }}
            >
              <span>{label}</span>
              {/* 空角诚实展示（R11）：不写"0 条"，直接标"空角"，避免与"有数据但未打标"混淆 */}
              <span style={{ fontSize: 9, opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>
                {count === null ? ' ' : empty ? '空角' : `${count} 条`}
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
          <span style={{ fontSize: 11, color: 'var(--dsh-mem-text-3)' }} title="锁定域时两类无角记忆是否参与召回">
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>会话</span>
        <Segmented
          value={isOff ? 'off' : 'on'}
          options={[
            { key: 'on', label: '启用', title: '本会话正常捕获/蒸馏/注入记忆' },
            { key: 'off', label: '关闭', title: '本会话对记忆系统隐身：不捕获、不蒸馏、不注入（数据保留，不改全局）' },
          ]}
          onChange={(key) => props.onCommit(key === 'off' ? 'off' : 'auto')}
        />
      </div>
      {/* 是否注入三态（复用既有会话覆盖控件；off 档禁用——完全隐身包含注入） */}
      {props.recall !== undefined && props.onCommitRecall ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 8 }}>
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
        <span style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }} title="覆写蒸馏族判定；默认跟随智能档">
          强制单族
        </span>
        <ModeSlider mode={props.mode === 'off' ? 'auto' : props.mode} onCommit={props.onCommit} />
      </div>
      {/* 未打标 M + 一键回填入口（task_15 接线；空角/存量不回填则门面立着显空） */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--dsh-mem-text-3)' }}>
          {overview ? `未打标 ${overview.unlabeled} 条（抽取只跑新消息，存量需回填）` : '未打标计数加载中'}
        </span>
        {/* 动作而非选择：Segmented 对已选中项有 `!on` 守卫（点不动），故用 ActionButton */}
        <ActionButton
          label={backfillBusy ? '回填中…' : '一键回填'}
          title="对存量未打标记忆批量补打 hall 标签（复用抽取打标路径）"
          disabled={!overview || overview.unlabeled === 0 || backfillBusy}
          onClick={() => backfill()}
        />
      </div>
      {(props.error || localError) ? (
        <div style={{ fontSize: 11, color: 'var(--dsh-mem-danger)', marginTop: 8, whiteSpace: 'nowrap' }}>
          {props.error || localError}
        </div>
      ) : null}
      {/* 会话信息区（session-stats 热路径端点；宿主不支持时整体不渲染） */}
      <SessionInfoArea rpc={props.rpc} sessionId={props.sessionId} />
    </div>
  );
}

/** 词表未送达时的兜底显示（正常路径由 hall-overview 下发的 label 取代）。 */
const LABEL_FALLBACK = ['工作', '人际', '学习', '创作娱乐', '健康', '居家', '财务', '出行'];

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
