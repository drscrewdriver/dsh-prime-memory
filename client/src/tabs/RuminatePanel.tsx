/** 反刍整理面板：按需冲刷未蒸馏缓冲 → L1 抽取 → L2 场景整合 → L3 画像轻刷新 → 标注重标定。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuminateStatus, RuminateStatusResponse } from '../../../src/contract.js';
import { fmtTime } from '../format.js';
import { ensureThemeStyle } from '../theme.js';
import { NButton, NModal } from '../ui/primitives.js';
import type { RpcFn } from '../rpc.js';

/** 运行阶段 → 面文。 */
const RM_PHASE_LABEL: Record<string, string> = {
  refreshing: '轻量刷新中',
  distilling: 'L1 蒸馏中',
  consolidating: 'L2 场景整合中',
  updating: 'L3 画像更新中',
  relabeling: '标注校验/重标定中',
};

/** 已进入运行态的阶段(用于"运行中却声称空闲"的兜底判定)。 */
const RM_RUNNING_PHASES = ['refreshing', 'distilling', 'consolidating', 'updating', 'relabeling'];

/** 分级轮询基线(毫秒):按阶段的真实节奏取频——快变阶段高频,分钟级 LLM 阶段低频。 */
const RM_PHASE_INTERVAL: Record<string, number> = {
  refreshing: 4000,
  distilling: 1500,
  consolidating: 6000,
  updating: 6000,
  relabeling: 3000, // 重标定按批次推进,detail 每批都变,可稍密
};
/** detail 无变化时的退避:×2 递增,封顶 15s(阶段没动就不浪费请求)。 */
const RM_BACKOFF_CAP = 5;
/** 空闲态低频轮询(仍要感知外部状态变化,如一键回填/其他入口触发)。 */
const RM_IDLE_INTERVAL = 30000;

export function RuminatePanel(props: { rpc: RpcFn }) {
  const rpc = props.rpc;
  const [rmRaw, setRm] = useState<RuminateStatusResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rmError, setRmError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return rpc('dsh-memory/ruminate-status', {})
      .then((r) => {
        if (r && r.ok) {
          const st = r.value as RuminateStatus;
          // 分级轮询:阶段基线 + detail 无变化退避(同一 detail 连续出现说明处于长 LLM 调用中)
          const base = RM_PHASE_INTERVAL[st.phase] ?? 3000;
          if (st.detail && st.detail === lastDetailRef.current) backoffRef.current = Math.min(backoffRef.current * 2, RM_BACKOFF_CAP);
          else backoffRef.current = 1;
          lastDetailRef.current = st.detail ?? null;
          pollRef.current = Math.min(base * backoffRef.current, 15000);
          setRm(st);
        }
        return r;
      })
      .catch(() => {});
  }, [rpc]);

  const pollRef = useRef(1500);
  const backoffRef = useRef(1);
  const lastDetailRef = useRef<string | null>(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 进度轮询(分级):自调度 setTimeout——间隔由最近一次状态决定,phase 切换即时生效
  const running = !!(rmRaw && (rmRaw.running || RM_RUNNING_PHASES.indexOf(rmRaw.phase) >= 0));
  useEffect(() => {
    if (!running) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      void Promise.resolve(refresh()).finally(() => {
        if (!alive) return;
        timer = setTimeout(loop, pollRef.current);
      });
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
      pollRef.current = 1500;
      backoffRef.current = 1;
      lastDetailRef.current = null;
    };
  }, [running, refresh]);

  // 空闲态低频轮询:保持对外部触发的感知,又不空转
  useEffect(() => {
    if (running) return;
    const timer = setInterval(refresh, RM_IDLE_INTERVAL);
    return () => clearInterval(timer);
  }, [running, refresh]);

  // 已用时长：L2/L3 单次 LLM 调用可达分钟级，不显示耗时用户无法判断"在跑还是在卡"
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // 反刍通道未建时整块不渲染
  if (!rmRaw || (rmRaw as { supported?: boolean }).supported === false) return null;
  const rm = rmRaw as RuminateStatus;
  ensureThemeStyle();

  const start = () => {
    setBusy(true);
    setRmError(null);
    rpc('dsh-memory/ruminate-start', {})
      .then((r) => {
        setBusy(false);
        if (r && r.ok) {
          setConfirmOpen(false);
          setRm(r.value);
        } else {
          setRmError(r && r.error ? r.error.message : '启动失败');
        }
      })
      .catch((e: unknown) => {
        setBusy(false);
        setRmError(String((e && (e as Error).message) || e));
      });
  };
  const cancel = () => {
    setBusy(true);
    rpc('dsh-memory/ruminate-cancel', {})
      .then((r) => {
        setBusy(false);
        if (r && r.ok) setRm(r.value);
      })
      .catch(() => {
        setBusy(false);
      });
  };

  const pct = rm.total > 0 ? Math.round((rm.done / rm.total) * 100) : 0;
  // 子进度(relabeling 等非会话阶段):进度条由重标批次驱动,而不是卡死的会话计数
  const sub = rm.sub && rm.sub.total > 0 ? rm.sub : null;
  const barPct = sub ? Math.round((sub.done / sub.total) * 100) : pct;
  // 无位移阶段(L2/L3/重标定的单次 LLM 调用可达分钟级):进度条转呼吸动画,避免"卡死在 x%"观感
  const indet = running && !sub && (rm.phase === 'consolidating' || rm.phase === 'updating' || rm.phase === 'relabeling');
  // 运行中与上周期的收尾摘要互斥；phase 已进入运行阶段时不得声称空闲
  const idleLike = !running;
  const elapsed = running && rm.startedAt ? Math.max(0, Date.now() - rm.startedAt) : 0;
  const elapsedText =
    elapsed > 0 ? (elapsed >= 60000 ? Math.floor(elapsed / 60000) + '分' + Math.floor((elapsed % 60000) / 1000) + '秒' : Math.floor(elapsed / 1000) + '秒') : '';

  // 非运行态收尾摘要
  let lastNote: string | null = null;
  if (idleLike && rm.phase === 'done') {
    const rl = rm.relabel;
    lastNote =
      '上次反刍整理：完成（' +
      rm.done +
      '/' +
      rm.total +
      ' 步' +
      (rm.recordsBuilt > 0 ? '，产出 ' + rm.recordsBuilt + ' 条记录' : '，无待消化缓冲') +
      '）' +
      (rl ? ' · 重标定：补 cogHall ' + rl.cogHallFixed + '，补 wing ' + rl.wingLabeled + '，打 tags ' + rl.tagged + (rl.deferred > 0 ? '，让出 ' + rl.deferred : '') : '') +
      (rm.finishedAt ? ' · ' + fmtTime(new Date(rm.finishedAt).toISOString()) : '');
  } else if (idleLike && rm.phase === 'cancelled') {
    lastNote = '上次反刍整理：已取消（完成 ' + rm.done + '/' + rm.total + ' 会话，已蒸馏部分保留）';
  } else if (idleLike && rm.phase === 'failed') {
    lastNote = '上次反刍整理：失败：' + (rm.error || '未知错误');
  }

  // 轻量刷新/重标定阶段计的是"步骤"，蒸馏阶段计的是"会话"
  const unit = rm.phase === 'refreshing' || rm.phase === 'relabeling' ? '步' : '会话';
  const progressText = sub
    ? sub.label + ' ' + sub.done + '/' + sub.total + '（' + Math.round((sub.done / sub.total) * 100) + '%）'
    : rm.total > 0
      ? rm.done + '/' + rm.total + ' ' + unit + '（' + pct + '%）'
      : '进行中…';

  return (
    <div className="dsh-mem-rb-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>反刍整理</div>
        <div className="dsh-mem-rb-muted" style={{ flex: 1, minWidth: 180 }}>
          {running
            ? (RM_PHASE_LABEL[rm.phase] || rm.phase) +
              ' · ' +
              progressText +
              (elapsedText ? ' · 已用 ' + elapsedText : '')
            : '冲刷未蒸馏缓冲，跑一轮 L1→L2→L3 消化；不清库不改 L0'}
        </div>
        {running ? (
          <NButton disabled={busy || rm.cancelRequested} onClick={cancel}>
            {rm.cancelRequested ? '取消中…' : '取消整理'}
          </NButton>
        ) : (
          <NButton
            disabled={busy}
            title="消化未蒸馏的记忆缓冲"
            style={{ color: 'var(--dsh-mem-accent)' }}
            onClick={() => {
              setConfirmOpen(true);
            }}
          >
            {busy ? '…' : '反刍整理'}
          </NButton>
        )}
      </div>
      {running ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <div className="dsh-mem-rb-bar">
            <div
              className={'dsh-mem-rb-fill' + (indet ? ' dsh-mem-rb-fill-indet' : '')}
              style={{ width: indet ? '100%' : barPct + '%' }}
            />
          </div>
          <span className="dsh-mem-rb-muted" style={{ whiteSpace: 'nowrap' }}>
            {sub
              ? sub.label + ' ' + sub.done + '/' + sub.total
              : '产出 ' + rm.recordsBuilt + ' 条'}
          </span>
        </div>
      ) : null}
      {running && rm.detail ? (
        <div className="dsh-mem-rb-muted" style={{ marginTop: 6, whiteSpace: 'normal' }}>
          {'当前：' + rm.detail}
        </div>
      ) : null}
      {lastNote ? (
        <div className="dsh-mem-rb-muted" style={{ marginTop: 8 }}>
          {lastNote}
        </div>
      ) : null}
      {rmError ? (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dsh-mem-danger)' }}>{rmError}</div>
      ) : null}
      {confirmOpen ? (
        <NModal
          open={true}
          onClose={() => setConfirmOpen(false)}
          title="确认反刍整理？"
          footer={[
            <NButton
              key="cancel"
              onClick={() => setConfirmOpen(false)}
            >
              取消
            </NButton>,
            <NButton key="confirm" variant="primary" disabled={busy} onClick={start}>
              {busy ? '启动中…' : '反刍整理'}
            </NButton>,
          ]}
        >
          <div>
            将扫描未蒸馏缓冲，按会话逐个跑蒸馏管线，完成后强制 L2 场景整合与 L3 画像更新。
          </div>
          <div style={{ marginTop: 8 }}>
            与重建不同：不清空 L1 检索库、不归档旧产物、不改 L0；仅消化攒而未蒸馏的切片，无缓冲时做轻量 L2/L3 刷新。
          </div>
        </NModal>
      ) : null}
    </div>
  );
}
