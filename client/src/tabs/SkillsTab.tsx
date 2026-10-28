/**
 * Tab：技能库（轨2 SkillsTab，人工审阅面）。
 *
 * 技能是 L1 之上的派生投影（不是 memory type）；这里列出候选/活跃技能，供人工
 * 晋升、固定、改注入档、归档。整块受 cfg.skills.enabled 门控（默认关时后端返回
 * enabled=false、列表空，本 Tab 显示"未启用"提示）。写动作需面板开启「高权限模式」。
 * 手动晋升仍需证据会话数达阈（后端把关，不受自动闸 allowPromote 约束）。
 *
 * **空态必须说真话**（issue #15 的教训）：以前这里无条件写"暂无技能"，而 0.26.13
 * 之前实际是**根本没有生产者**（候选检测零调用点，skills.json 永远不生成），用户
 * 只能猜是自己操作错了。现在按 `producer` 字段分三态：旧宿主（无此字段）不谎报、
 * 池里没原料、有原料但未跨会话重复到成候选。
 */
import { useCallback, useEffect, useState } from 'react';
import type { SkillView, SkillsListResponse } from '../../../src/contract.js';
import type { RpcFn } from '../rpc.js';
import { S } from '../styles.js';
import { NButton } from '../ui/primitives.js';

function errMsg(r: { ok?: boolean; error?: { message?: string } } | undefined): string {
  return r && r.error && r.error.message ? r.error.message : 'RPC 错误';
}

const TITLES: Record<SkillView['status'], string> = { candidate: '候选', active: '活跃', archived: '已归档' };

/** 空态文案：拿不到生产者健康态（旧宿主）时不谎报已接线。 */
function emptyHint(data: SkillsListResponse): string {
  const p = data.producer;
  if (!p) return '暂无技能。技能从重复出现的"工作方法"记忆结晶而来。';
  if (p.workMethodCount === 0) {
    return '暂无技能：记忆池里还没有「工作方法」类记录。技能是从重复出现的工作方法结晶来的，请先到概览页确认蒸馏在正常产出记忆。';
  }
  return `暂无技能：池中已有 ${p.workMethodCount} 条「工作方法」，但还没重复到成候选的程度（需跨 ≥${p.minSessions} 个不同会话）。存量可点「立即检测历史」回灌。`;
}

export function SkillsTab(props: { rpc: RpcFn }) {
  const rpc = props.rpc;
  const [data, setData] = useState<SkillsListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    rpc('dsh-memory/skills-list', {})
      .then((r) => {
        if (r && r.ok) {
          setData(r.value);
          setError(null);
        } else setError(errMsg(r));
      })
      .catch((e: unknown) => setError(String((e as Error)?.message || e)));
  }, [rpc]);

  useEffect(() => {
    load();
  }, [load]);

  const act = (id: string, action: 'promote' | 'archive' | 'pin' | 'unpin' | 'set-tier', tier?: SkillView['tier']) => {
    if (busy) return;
    setBusy(true);
    rpc('dsh-memory/skills-action', { id, action, tier })
      .then((r) => {
        if (r && r.ok) {
          setError(r.value.changed ? null : r.value.notice || null);
          load();
        } else setError(errMsg(r));
      })
      .catch((e: unknown) => setError(String((e as Error)?.message || e)))
      .finally(() => setBusy(false));
  };

  /** 一次性回灌存量：扫历史 work_method，从会话锚点复原归属。 */
  const detect = () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    rpc('dsh-memory/skills-detect', {})
      .then((r) => {
        if (r && r.ok) {
          setError(r.value.error ? `部分失败：${r.value.error}` : null);
          setNotice(r.value.notice || null);
          load();
        } else setError(errMsg(r));
      })
      .catch((e: unknown) => setError(String((e as Error)?.message || e)))
      .finally(() => setBusy(false));
  };

  if (data && !data.enabled) {
    return <p style={S.intro}>技能结晶（程序性记忆）未启用。到「概览」页开启「技能」开关（或部署配置 skills.enabled）：开启后，跨会话重复出现的「工作方法」记忆会累积为技能候选，在此审阅并手动晋升。</p>;
  }

  const mutateHint = data && !data.memoryMutate ? <div style={S.hint}>提示：晋升/归档/固定/检测历史需在面板开启「高权限模式」。</div> : null;

  // 证据已达阈但因自动晋升关着而停在候选：这是"该有人拍板"的信号，得主动说。
  const promotable = data && data.producer
    ? data.skills.filter((s) => s.status === 'candidate' && s.sessionCount >= data.producer!.minSessions).length
    : 0;

  return (
    <div>
      <div style={{ ...S.flexRow, marginBottom: 10 }}>
        <span style={S.muted}>{data ? `${data.skills.length} 个技能 · 自动晋升${data.allowPromote ? '开' : '关(人工审阅)'} · 需证据会话达阈` : '加载中…'}</span>
        <div style={S.grow} />
        <NButton onClick={detect} disabled={busy || !data?.memoryMutate}>立即检测历史</NButton>
        <NButton onClick={load} style={{ marginLeft: 6 }}>刷新</NButton>
      </div>
      {mutateHint}
      {notice ? <div style={S.hint}>{notice}</div> : null}
      {error ? <div style={S.error}>{error}</div> : null}
      {data && promotable > 0 && !data.allowPromote ? (
        <div style={S.hint}>{promotable} 个候选的证据会话数已达阈，但自动晋升关闭——确认无误后可手动「晋升」。</div>
      ) : null}
      {data && data.skills.length === 0 ? <p style={S.intro}>{emptyHint(data)}</p> : null}
      {(data?.skills || []).map((s) => (
        <div key={s.id} className="dsh-mem-card" style={S.card}>
          <div style={S.cardHead}>
            <strong>{s.title}</strong>
            <span className="dsh-mem-tag" style={{ marginLeft: 6 }}>{TITLES[s.status]}</span>
            <span style={S.muted}>{` · 档:${s.tier}${s.pinned ? ' · 已固定' : ''} · 覆盖 ${s.sessionCount} 会话 / 证据 ${s.evidenceCount} 条`}</span>
            <div style={S.grow} />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {s.status === 'candidate' ? (
              <NButton onClick={() => act(s.id, 'promote')} disabled={busy}>晋升</NButton>
            ) : null}
            <select
              className="dsh-mem-select"
              style={{ width: 'auto', padding: '5px 10px' }}
              value={s.tier}
              onChange={(e) => act(s.id, 'set-tier', e.target.value as SkillView['tier'])}
            >
              <option value="full">全文档</option>
              <option value="excerpt">摘录档</option>
              <option value="hint">提示档</option>
            </select>
            <NButton onClick={() => act(s.id, s.pinned ? 'unpin' : 'pin')} disabled={busy}>
              {s.pinned ? '取消固定' : '固定'}
            </NButton>
            {s.status !== 'archived' ? (
              <NButton onClick={() => act(s.id, 'archive')} disabled={busy}>归档</NButton>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
