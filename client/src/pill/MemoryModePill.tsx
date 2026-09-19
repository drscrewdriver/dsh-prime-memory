/** 输入栏 pill：点击展开八边形域轮（HallWheel）；props 来自 conversation.input.left 的 zone 注入。 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { currentMeterSnapshot, initOccupancyIndicator, noteOccupancySession, watchContextMeter } from '../meter/occupancy-indicator.js';
import { initPanelSection } from '../meter/panel-section.js';
import type { RpcFn } from '../rpc.js';
import { watchSidebarIcon } from '../sidebar-icon.js';
import { ensureThemeStyle } from '../theme.js';
import { HallWheel, useViewportClamp } from './HallWheel.js';
import { modeInfo } from './modes.js';

export function MemoryModePill(props: {
  rpc: RpcFn;
  sessionId?: string;
  session?: { sessionId?: string };
}) {
  const rpc = props.rpc;
  const sessionId = props.sessionId || (props.session && props.session.sessionId);
  const [mode, setMode] = useState<string | null>(null);
  // 会话级注入覆盖（#38 只写不读）：null = 跟随全局；recallResolved = host 解析后的
  // 生效值（面文直接消费——client 不另知全局开关，解析权威在 host）
  const [recall, setRecall] = useState<boolean | null>(null);
  const [recallResolved, setRecallResolved] = useState(true);
  // 会话级域锁定（hall 八边形手动挡）：null = 中心（智能档）；角 id = 锁定单域
  const [hall, setHall] = useState<string | null>(null);
  const [hallIncludeUnlabeled, setHallIncludeUnlabeled] = useState(true);
  const [hallIncludeGeneral, setHallIncludeGeneral] = useState(false);
  // 面文域显示名（hall-overview 下发，词表单一事实源在服务端）
  const [hallLabels, setHallLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const shiftX = useViewportClamp(popRef);
  // 请求序列号：快速切换会话时丢弃旧会话的过期响应（慢响应不得覆盖新会话档位）
  const seqRef = useRef(0);

  const load = useCallback(() => {
    if (!sessionId || !rpc) return;
    const token = ++seqRef.current;
    setError(null);
    rpc('dsh-memory/session-mode-get', { sessionId })
      .then((r) => {
        if (token !== seqRef.current) return;
        if (r && r.ok && r.value) {
          setMode(r.value.mode);
          setRecall(r.value.recall);
          setRecallResolved(r.value.recallResolved);
          setHall(r.value.hall);
          setHallIncludeUnlabeled(r.value.hallIncludeUnlabeled);
          setHallIncludeGeneral(r.value.hallIncludeGeneral);
        } else setError(r && !r.ok ? r.error.message : 'RPC error');
      })
      .catch((e: unknown) => {
        if (token !== seqRef.current) return;
        setError(String((e && (e as Error).message) || e));
      });
    // 域显示名（角计数端点顺带下发词表；失败降级为角 id 原样显示）
    rpc('dsh-memory/hall-overview', {})
      .then((r) => {
        if (r && r.ok && r.value) {
          setHallLabels(Object.fromEntries(r.value.corners.map((c) => [c.id, c.label])));
        }
      })
      .catch(() => {});
  }, [sessionId, rpc]);

  useEffect(() => {
    load();
  }, [load]);

  // 侧边栏书本 icon 补丁由常驻 pill 驱动（MemoryPanel 只在记忆分节激活时挂载，
  // 覆盖不了"打开设置第一眼"的场景）；body 级观察器全局单例，多实例幂等
  useEffect(() => {
    watchSidebarIcon();
  }, []);

  // 占用指示器（官方环外圈记忆光晕弧）同款驱动：观察器单例常驻，数据通道与会话在此
  // 接线；sessionId 变化即冷启动检查（无缓存才发首次拉取），rpc 端点为 session-stats
  useEffect(() => {
    initOccupancyIndicator((endpoint, payload) =>
      rpc(endpoint as Parameters<RpcFn>[0], payload as Parameters<RpcFn>[1]),
    );
    initPanelSection(currentMeterSnapshot);
    watchContextMeter();
    noteOccupancySession(sessionId ?? null);
  }, [sessionId, rpc]);

  // 展开期间：外点收起（pointerdown 三类指针通吃）+ Esc 收起
  useEffect(() => {
    if (!open) return;
    // pointerdown 而非 mousedown（手机端适配）：iOS 触点纯文本区不合成 mouse 事件，
    // mousedown 会漏关浮层；pointerdown 三类指针通吃，桌面语义不变
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** 乐观提交：立即更新 UI，RPC 失败回滚并提示。token 比对丢弃过期会话的迟到响应。 */
  const commit = (next: string) => {
    if (!rpc || !sessionId || mode === null || next === mode) return;
    const prev = mode;
    const token = seqRef.current;
    setMode(next);
    setError(null);
    rpc('dsh-memory/session-mode-set', { sessionId, mode: next as 'auto' })
      .then((r) => {
        if (token !== seqRef.current) return;
        if (!r || !r.ok) {
          setMode(prev);
          setError(r && r.error ? '档位写入失败：' + r.error.message : '档位写入失败');
        }
      })
      .catch((e: unknown) => {
        if (token !== seqRef.current) return;
        setMode(prev);
        setError('档位写入失败：' + String((e && (e as Error).message) || e));
      });
  };

  /** 注入覆盖提交（#38）：null = 清除覆盖（跟随全局）；显式传 mode（host 侧缺省
   *  recall 不动现值）。清除后的解析值（= 全局）只有 host 知道，以 set 响应回填。
   *  mode 未加载时拒绝提交——请求必带 mode，缺省发射会把会话实际档位顶成 auto。 */
  const commitRecall = (next: boolean | null) => {
    if (!rpc || !sessionId || mode === null || next === recall) return;
    const prevRecall = recall;
    const prevResolved = recallResolved;
    const token = seqRef.current;
    setRecall(next);
    if (next !== null) setRecallResolved(next);
    setError(null);
    rpc('dsh-memory/session-mode-set', { sessionId, mode: mode as 'auto', recall: next })
      .then((r) => {
        if (token !== seqRef.current) return;
        if (!r || !r.ok) {
          setRecall(prevRecall);
          setRecallResolved(prevResolved);
          setError(r && r.error ? '注入设置失败：' + r.error.message : '注入设置失败');
        } else {
          setRecall(r.value.recall);
          setRecallResolved(r.value.recallResolved);
        }
      })
      .catch((e: unknown) => {
        if (token !== seqRef.current) return;
        setRecall(prevRecall);
        setRecallResolved(prevResolved);
        setError('注入设置失败：' + String((e && (e as Error).message) || e));
      });
  };

  /** 域锁定提交（R12 手动挡）：角 id = 锁定；null = 回中心（清除锁定）。
   *  mode 未加载时拒绝提交（请求必带 mode，同 commitRecall 的口径）。 */
  const commitHall = (next: string | null) => {
    if (!rpc || !sessionId || mode === null || next === hall) return;
    const prevHall = hall;
    const token = seqRef.current;
    setHall(next);
    setError(null);
    rpc('dsh-memory/session-mode-set', { sessionId, mode: mode as 'auto', hall: next })
      .then((r) => {
        if (token !== seqRef.current) return;
        if (!r || !r.ok) {
          setHall(prevHall);
          setError(r && r.error ? '域设置失败：' + r.error.message : '域设置失败');
        } else {
          setHall(r.value.hall);
        }
      })
      .catch((e: unknown) => {
        if (token !== seqRef.current) return;
        setHall(prevHall);
        setError('域设置失败：' + String((e && (e as Error).message) || e));
      });
  };

  /** 锁定域边界开关（未打标 / 跨域是否参与召回）。 */
  const commitHallBoundaries = (patch: { includeUnlabeled?: boolean; includeGeneral?: boolean }) => {
    if (!rpc || !sessionId || mode === null) return;
    const prev = { unlabeled: hallIncludeUnlabeled, general: hallIncludeGeneral };
    const token = seqRef.current;
    if (patch.includeUnlabeled !== undefined) setHallIncludeUnlabeled(patch.includeUnlabeled);
    if (patch.includeGeneral !== undefined) setHallIncludeGeneral(patch.includeGeneral);
    setError(null);
    rpc('dsh-memory/session-mode-set', {
      sessionId,
      mode: mode as 'auto',
      hall: hall,
      hallIncludeUnlabeled: patch.includeUnlabeled,
      hallIncludeGeneral: patch.includeGeneral,
    })
      .then((r) => {
        if (token !== seqRef.current) return;
        if (!r || !r.ok) {
          setHallIncludeUnlabeled(prev.unlabeled);
          setHallIncludeGeneral(prev.general);
          setError(r && r.error ? '域设置失败：' + r.error.message : '域设置失败');
        } else {
          setHall(r.value.hall);
          setHallIncludeUnlabeled(r.value.hallIncludeUnlabeled);
          setHallIncludeGeneral(r.value.hallIncludeGeneral);
        }
      })
      .catch((e: unknown) => {
        if (token !== seqRef.current) return;
        setHallIncludeUnlabeled(prev.unlabeled);
        setHallIncludeGeneral(prev.general);
        setError('域设置失败：' + String((e && (e as Error).message) || e));
      });
  };

  if (!sessionId || !rpc) return null;
  const info = modeInfo(mode);
  const loaded = mode !== null;
  // 关闭档与其余档二分：关闭 = dsh 透明按钮（无边框无底无光晕）；
  // 其余 = 同款流光 + 光晕，区分靠蓝阶文字色与流光内底混色深度
  const isOff = loaded && mode === 'off';
  const isFlow = loaded && !isOff;
  // 面文换字：off → 「关闭」；注入关 → 「只写」；锁角 → 「记忆 · <域>」（词表下发
  // 的显示名，未送达时原样显示角 id）；否则档位名。域锁定是最新的用户意图，优先上脸。
  const hallText = hall ? hallLabels[hall] ?? hall : null;
  const faceLabel = !loaded
    ? error
      ? '⚠'
      : '…'
    : isOff
      ? info.label
      : !recallResolved
        ? '只写'
        : hallText
          ? hallText
          : info.label;

  ensureThemeStyle();

  const pillStyle = {
    position: 'relative', // dsh-mem-pill-hit 的 ::after 隐形热区以此为定位基准
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 24,
    padding: '0 10px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 500,
    lineHeight: '20px',
    cursor: 'pointer',
    // 流光档的边框/背景由 .dsh-mem-flow 的双层背景提供（流光边 + 不透明内底），
    // inline 只给文字色 / 光晕 / 流光内底混色通道（--dsh-mem-pill-tint）
    color: isFlow ? info.color : 'var(--dsh-mem-text-2)',
  } as CSSProperties & Record<string, string | number>;
  if (isFlow) {
    pillStyle.boxShadow = '0 0 12px color-mix(in srgb, ' + info.color + ' 30%, transparent)';
    pillStyle['--dsh-mem-pill-tint'] = info.color;
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        title={error ? '档位读取失败：' + error + '（点击重试）' : '本会话记忆域与档位（点击切换）'}
        onClick={() => {
          if (error) load();
          setOpen(!open);
        }}
        className={(isFlow ? 'dsh-mem-flow' : 'dsh-mem-pill-off') + ' dsh-mem-pill-hit'}
        style={pillStyle}
      >
        记忆 · <span>{faceLabel}</span>
      </button>
      {open ? (
        <div
          // 外壳只负责定位（带 transform 居中悬浮在按钮上方，水平中轴对齐 pill 中心）；
          // shiftX = 水平视口夹持的贴边平移量（桌面恒 0）
          ref={popRef}
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: '50%',
            transform: 'translateX(calc(-50% + ' + shiftX + 'px))',
            zIndex: 1000,
          }}
        >
          <div
            // dsh 原生菜单同配方浮层：不透明实底 + inverted 描边 + lv3 阴影
            className="dsh-mem-popover"
            style={{ position: 'relative', padding: '14px 16px' }}
          >
            <HallWheel
              mode={mode || 'auto'}
              hall={hall}
              hallIncludeUnlabeled={hallIncludeUnlabeled}
              hallIncludeGeneral={hallIncludeGeneral}
              onCommit={commit}
              onCommitHall={commitHall}
              onCommitHallBoundaries={commitHallBoundaries}
              recall={loaded ? recall : undefined}
              onCommitRecall={commitRecall}
              error={error}
              rpc={rpc}
              sessionId={sessionId}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
