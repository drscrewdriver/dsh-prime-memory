/** Tab：运行日志（log-tail 尾读 + 自动贴底）。§F:可切换召回/蒸馏追踪事件流。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RpcFn } from '../rpc.js';
import { S } from '../styles.js';
import { NButton } from '../ui/primitives.js';

type TraceKind = '' | 'recall_turn' | 'distill_run';

const SOURCES: Array<{ id: string; label: string }> = [
  { id: '', label: '系统日志' },
  { id: 'recall_turn', label: '召回追踪' },
  { id: 'distill_run', label: '蒸馏追踪' },
];

function fmtEvent(ev: Record<string, unknown>): string {
  if (ev.kind === 'recall_turn') {
    const outcome = String(ev.outcome ?? '?');
    const hits = (ev.hitIds as string[] | undefined)?.length ?? 0;
    const injected = (ev.injectedIds as string[] | undefined)?.length ?? 0;
    const q = ev.queryText ? ` query="${String(ev.queryText).slice(0, 40)}"` : ` sha=${String(ev.querySha ?? '')}`;
    return `[${new Date(Number(ev.ts)).toLocaleTimeString()}] recall ${outcome}${q} hits=${hits} injected=${injected} suppressed=${String(ev.suppressedCount ?? 0)} ${String(ev.durationMs ?? 0)}ms`;
  }
  if (ev.kind === 'distill_run') {
    const by = ev.byKind ? ' byKind=' + JSON.stringify(ev.byKind) : '';
    const err = ev.errorKind ? ' error=' + String(ev.errorKind) : '';
    return `[${new Date(Number(ev.ts)).toLocaleTimeString()}] distill ${String(ev.layer)}${ev.runId ? ' run=' + String(ev.runId) : ''} ok=${String(ev.ok)} in=${String(ev.inputChars ?? 0)}ch new=${String(ev.newRecords ?? 0)} ${String(ev.durationMs ?? 0)}ms${by}${err}`;
  }
  return JSON.stringify(ev);
}

export function LogTab(props: { rpc: RpcFn }) {
  const rpc = props.rpc;
  const [source, setSource] = useState<TraceKind>('');
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(() => {
    setError(null);
    if (source === '') {
      rpc('dsh-memory/log-tail', { lines: 200 })
        .then((r) => {
          if (r && r.ok) setLines(r.value.lines);
          else setError(r && r.error ? r.error.message : 'RPC error');
        })
        .catch((e: unknown) => setError(String((e && (e as Error).message) || e)));
      return;
    }
    rpc('dsh-memory/trace-tail', { lines: 200, kind: source })
      .then((r) => {
        if (r && r.ok) setLines((r.value.events as unknown as Array<Record<string, unknown>>).map(fmtEvent));
        else setError(r && r.error ? r.error.message : 'RPC error');
      })
      .catch((e: unknown) => setError(String((e && (e as Error).message) || e)));
  }, [rpc, source]);

  useEffect(() => {
    load();
  }, [load]);
  // tail 语义：加载/刷新后滚动贴底，保证最新一条可见
  useEffect(() => {
    if (lines && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [lines]);

  return (
    <div>
      <div style={{ ...S.flexRow, marginBottom: 10, gap: 8 }}>
        {SOURCES.map((s) => (
          <NButton key={s.id} onClick={() => setSource(s.id as TraceKind)}>
            {source === s.id ? '● ' + s.label : s.label}
          </NButton>
        ))}
        <div style={S.grow} />
        <NButton onClick={load}>刷新</NButton>
      </div>
      <div style={{ ...S.muted, marginBottom: 10 }}>
        {error ? '加载失败' : lines === null ? '加载中…' : `最近 ${lines.length} 条（${SOURCES.find((s) => s.id === source)?.label}）`}
      </div>
      {error ? (
        <div style={{ ...S.error, marginBottom: 10 }}>{'读取失败：' + error + '（点右上“刷新”重试）'}</div>
      ) : (
        <pre style={S.pre} ref={preRef}>
          {(lines || []).join('\n') || '(暂无记录)'}
        </pre>
      )}
    </div>
  );
}
