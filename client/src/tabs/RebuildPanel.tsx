/** 重建面板：从 L0 重导 L1/L2/L3（确认弹窗 + 进度条 + 取消；Light/Dark 双主题靠 class）。 */
import { useCallback, useEffect, useState } from 'react';
import type { RebuildStatus, RebuildStatusResponse } from '../../../src/contract.js';
import { fmtTime } from '../format.js';
import { ensureThemeStyle } from '../theme.js';
import { NButton, NModal } from '../ui/primitives.js';
import type { RpcFn } from '../rpc.js';

/** 运行阶段 → 面文。 */
const RB_PHASE_LABEL: Record<string, string> = {
  preparing: '准备中（归档旧数据 · 清空检索库）',
  distilling: '分块蒸馏中',
  finalizing: '收尾（强制 L2 场景 + L3 画像）',
};

export function RebuildPanel(props: { rpc: RpcFn }) {
  const rpc = props.rpc;
  const [rbRaw, setRb] = useState<RebuildStatusResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rbError, setRbError] = useState<string | null>(null);
  /** 错误是否属于“需二次确认”类（水位落差超阈值）—— 只有这类才给 force 入口。 */
  const [canForce, setCanForce] = useState(false);

  const refresh = useCallback(() => {
    rpc('dsh-memory/rebuild-status', {})
      .then((r) => {
        if (r && r.ok) setRb(r.value);
      })
      .catch(() => {});
  }, [rpc]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 进度轮询只在运行中开（1.5s 高频）；空闲不轮询，重开 Tab 时挂载刷一次
  const running = !!(rbRaw && rbRaw.running);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(refresh, 1500);
    return () => {
      clearInterval(timer);
    };
  }, [running, refresh]);

  // 存储降级（rebuild 通道未建）时整块不渲染
  if (!rbRaw || (rbRaw as { supported?: boolean }).supported === false) return null;
  const rb = rbRaw as RebuildStatus;
  ensureThemeStyle();

  /**
   * 启动重建。
   *
   * `force` 只在用户看过“水位落差”警告后手动触发：L0 已停写，晚于水位的记录
   * 会被**原样保留**而不是重蒸，这一步必须让人知情而不是默默降级。
   */
  const start = (force = false) => {
    setBusy(true);
    setRbError(null);
    setCanForce(false);
    rpc('dsh-memory/rebuild-start', force ? { force: true } : {})
      .then((r) => {
        setBusy(false);
        if (r && r.ok) {
          setConfirmOpen(false);
          setRb(r.value);
        } else {
          const msg = r && r.error ? r.error.message : '启动失败';
          setRbError(msg);
          // 文案契约：可 force 的拒绝一定带“带 force 重试”字样（见 rebuild.start）。
          setCanForce(/force/.test(msg));
        }
      })
      .catch((e: unknown) => {
        setBusy(false);
        const msg = String((e && (e as Error).message) || e);
        setRbError(msg);
        setCanForce(/force/.test(msg));
      });
  };
  const cancel = () => {
    setBusy(true);
    rpc('dsh-memory/rebuild-cancel', {})
      .then((r) => {
        setBusy(false);
        if (r && r.ok) setRb(r.value);
      })
      .catch(() => {
        setBusy(false);
      });
  };

  const empty = !running && (rb.messageCount === 0 || rb.estCalls === 0);
  const pct = rb.total > 0 ? Math.round((rb.done / rb.total) * 100) : 0;

  // 非运行态收尾摘要：按 phase 给「上次重建」一行
  let lastNote: string | null = null;
  if (!running && rb.phase === 'done') {
    lastNote =
      '上次重建：完成（' +
      rb.done +
      '/' +
      rb.total +
      ' 会话，产出 ' +
      rb.recordsBuilt +
      ' 条记录）' +
      (rb.finishedAt ? ' · ' + fmtTime(new Date(rb.finishedAt).toISOString()) : '');
  } else if (!running && rb.phase === 'cancelled') {
    lastNote = '上次重建：已取消（完成 ' + rb.done + '/' + rb.total + ' 会话，已重建部分保留）';
  } else if (!running && rb.phase === 'failed') {
    lastNote = '上次重建：失败：' + (rb.error || '未知错误');
  }

  return (
    <div className="dsh-mem-rb-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>重建记忆</div>
        <div className="dsh-mem-rb-muted" style={{ flex: 1, minWidth: 180 }}>
          {running
            ? (RB_PHASE_LABEL[rb.phase] || rb.phase) + ' · ' + rb.done + '/' + rb.total + ' 会话（' + pct + '%）'
            : '从 L0 原始对话重新蒸馏 L1/L2/L3；旧数据先归档（不删除）'}
        </div>
        {running ? (
          <NButton disabled={busy || rb.cancelRequested} onClick={cancel}>
            {rb.cancelRequested ? '取消中…' : '取消重建'}
          </NButton>
        ) : (
          <NButton
            disabled={busy || empty}
            title={empty ? 'L0 无消息，无可重建内容' : '重新蒸馏全部记忆'}
            style={{ color: 'var(--dsh-mem-danger)' }}
            onClick={() => {
              setConfirmOpen(true);
            }}
          >
            {busy ? '…' : '开始重建'}
          </NButton>
        )}
      </div>
      {running ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <div className="dsh-mem-rb-bar">
            <div className="dsh-mem-rb-fill" style={{ width: pct + '%' }} />
          </div>
          <span className="dsh-mem-rb-muted" style={{ whiteSpace: 'nowrap' }}>
            {'产出 ' + rb.recordsBuilt + ' 条'}
          </span>
        </div>
      ) : null}
      {lastNote ? (
        <div className="dsh-mem-rb-muted" style={{ marginTop: 8 }}>
          {lastNote}
        </div>
      ) : null}
      {rb.rederivableCount !== null || rb.preserveCount !== null ? (
        <div className="dsh-mem-rb-muted" style={{ marginTop: 6 }}>
          {'本次计划：可重造 ' + (rb.rederivableCount ?? 0) + ' 条 · 原样保留 ' + (rb.preserveCount ?? 0) + ' 条（无来源或来源不在本次快照）'}
        </div>
      ) : null}
      {rbError ? (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dsh-mem-danger)' }}>
          {rbError}
          {canForce ? (
            <div style={{ marginTop: 6 }}>
              <NButton disabled={busy} onClick={() => { start(true); }}>
                {busy ? '启动中…' : '我已了解，仍要继续（不重蒸水位后的记录）'}
              </NButton>
            </div>
          ) : null}
        </div>
      ) : null}
      {confirmOpen ? (
        <NModal
          open={true}
          onClose={() => {
            setConfirmOpen(false);
          }}
          title="确认重建全部记忆？"
          footer={[
            <NButton
              key="cancel"
              onClick={() => {
                setConfirmOpen(false);
              }}
            >
              取消
            </NButton>,
            <NButton key="confirm" variant="primary" disabled={busy} onClick={() => { start(); }}>
              {busy ? '启动中…' : '开始重建'}
            </NButton>,
          ]}
        >
          <div>
            将以 L0 原始对话为事实源重新蒸馏：
            <b>{rb.sessionCount + ' 个会话 · ' + rb.messageCount + ' 条消息'}</b>
            {'，预计 ≥' + rb.estCalls + ' 次蒸馏调用。'}
          </div>
          {/* 水位行：这个按钮会不会“倒退”全靠它说清楚。L0 停写后不再前移， */}
          {/* 停写之后的记忆会在重建后被原样保留，而不是重新蒸馏。 */}
          <div style={{ marginTop: 8 }}>
            {'事实源覆盖到：'}
            <b>{rb.factWatermark ? fmtTime(rb.factWatermark) : '无（本地 L0 没有任何正文）'}</b>
            {rb.factWatermark ? '；晚于此时刻的记忆会被原样保留、不重新蒸馏（不会丢）。' : '。'}
          </div>
          <div style={{ marginTop: 8 }}>
            现有 L1 记忆 / L2 场景 / L3 画像会整体归档（*.bak.时间戳，可手工找回），随后清空重建；重建期间可正常对话，新对话的蒸馏优先进行；中途可取消，已重建部分保留。
          </div>
        </NModal>
      ) : null}
    </div>
  );
}
