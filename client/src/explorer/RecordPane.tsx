/**
 * 记忆库左栏：L1 记忆查询。
 *
 * 检索**不新造缝**：直接复用 `dsh-memory/list-records`（服务端 BM25 唯一入口），
 * 所以这里看到的结果与设置页「记忆」tab 必然同口径——两套检索结果迟早会漂。
 *
 * 三条纪律沿用 RecordsTab 的实测结论：
 *   1. 请求序号防过期：快速翻页/连改筛选时，慢响应不得覆盖新结果；
 *   2. 词表不手抄：类型目录随首屏（offset===0）由服务端下发，缺席时从已加载项派生；
 *   3. 列表只在**表单提交**时变化，不做输入即查（动态重发会把软超时打满）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ListRecordsRequest, UiRecord } from '../../../src/contract.js';
import type { RpcFn } from '../rpc.js';
import { NButton, NInput } from '../ui/primitives.js';
import { fmtTime } from '../format.js';

/** 单页条数（与服务端 limit 上限 200 同量级，取小值保证首屏快）。 */
const PAGE = 40;

interface Conds {
  query: string;
  type: string;
  /** 退场三态：'' = 全部混排 / 'active' = 仅活跃 / 'retired' = 仅退场。 */
  retired: '' | 'active' | 'retired';
}

const CONDS0: Conds = { query: '', type: '', retired: '' };

export function RecordPane(props: {
  rpc: RpcFn;
  /** 当前聚焦的记录 id（高亮用）。 */
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  const { rpc, activeId, onPick } = props;
  const [input, setInput] = useState('');
  const [typeSel, setTypeSel] = useState('');
  const [retiredSel, setRetiredSel] = useState<'' | 'active' | 'retired'>('');
  const [conds, setConds] = useState<Conds>(CONDS0);
  const [items, setItems] = useState<UiRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [typeCatalog, setTypeCatalog] = useState<Array<{ id: string; label: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offsetRef = useRef(0);
  const seqRef = useRef(0);

  const fetchPage = useCallback(
    (next: Conds, offset: number, append: boolean) => {
      const token = ++seqRef.current;
      setLoading(true);
      setError(null);
      // 用真类型而非 `as never`：as never 会把“请求字段与契约不匹配”连错误一起掉。[1,200]/[0,1e6] 的钳制在服务端做。
      const payload: ListRecordsRequest = { limit: PAGE, offset };
      if (next.query) payload.query = next.query;
      if (next.type) payload.type = next.type;
      if (next.retired !== '') payload.retired = next.retired === 'active';
      rpc('dsh-memory/list-records', payload)
        .then((r) => {
          if (token !== seqRef.current) return; // 过期响应即弃
          if (!r.ok) throw new Error(r.error.message);
          const v = r.value;
          setItems((prev) => (append ? [...prev, ...v.items] : v.items));
          setHasMore(v.hasMore);
          setTotal(v.total);
          setTruncated(v.truncated);
          if (v.typeCatalog && offset === 0) setTypeCatalog(v.typeCatalog);
          offsetRef.current = offset + v.items.length;
        })
        .catch((e: unknown) => {
          if (token !== seqRef.current) return;
          setError(String((e as Error)?.message ?? e));
        })
        .finally(() => {
          if (token === seqRef.current) setLoading(false);
        });
    },
    [rpc],
  );

  /** 提交查询：三个条件一起进 conds，回到第一页。 */
  const search = () => {
    const next: Conds = { query: input.trim(), type: typeSel, retired: retiredSel };
    setConds(next);
    fetchPage(next, 0, false);
  };

  useEffect(() => {
    fetchPage(CONDS0, 0, false);
  }, [fetchPage]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter') search();
    // 清空即一次空查询提交（沿用 RecordsTab 的用户定标：Esc 回全量）
    else if (e.key === 'Escape') {
      setInput('');
      setTypeSel('');
      setRetiredSel('');
      setConds(CONDS0);
      fetchPage(CONDS0, 0, false);
    }
  };

  /** 类型显示名：词表优先，缺席回落原值（旧服务端不下发词表时不至于显示空白）。 */
  const labelOf = (t: string) => typeCatalog.find((c) => c.id === t)?.label ?? t;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <NInput
          style={{ flex: '1 1 160px', minWidth: 140 }}
          placeholder="搜索记忆内容（关键词）…"
          value={input}
          onChange={(e: { target: { value: string } }) => setInput(e.target.value)}
          onKeyDown={onKey}
        />
        <select
          className="dsh-mem-input"
          value={typeSel}
          onChange={(e) => setTypeSel(e.target.value)}
          title="类型筛选"
          style={{ maxWidth: 120 }}
        >
          <option value="">全部类型</option>
          {typeCatalog.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          className="dsh-mem-input"
          value={retiredSel}
          onChange={(e) => setRetiredSel(e.target.value as '' | 'active' | 'retired')}
          title="退场筛选"
          style={{ maxWidth: 96 }}
        >
          <option value="">全部</option>
          <option value="active">仅活跃</option>
          <option value="retired">仅退场</option>
        </select>
        <NButton onClick={search} title="查询（Enter）">
          查询
        </NButton>
      </div>

      <div style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)', padding: '6px 2px' }}>
        {total != null ? `共 ${total} 条 · ` : ''}已列 {items.length} 条
        {truncated ? ' · 检索结果可能不完整' : ''}
        {loading ? ' · 加载中…' : ''}
      </div>

      {error && (
        <div style={{ fontSize: 12, color: 'var(--dsh-mem-accent)', padding: '4px 0' }}>
          查询失败：{error}{' '}
          <NButton onClick={() => fetchPage(conds, Math.max(0, offsetRef.current - items.length), false)}>重试</NButton>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid var(--dsh-mem-border)', borderRadius: 8 }}>
        {items.length === 0 && !loading && !error ? (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>
            没有符合条件的记忆。
          </div>
        ) : null}
        {items.map((r) => {
          const on = r.id === activeId;
          return (
            <button
              key={r.id}
              onClick={() => onPick(r.id)}
              title={r.retired ? '已退场（软删，可恢复）' : undefined}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                borderBottom: '1px solid var(--dsh-mem-border)',
                background: on ? 'var(--dsh-mem-accent-weak)' : 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                opacity: r.retired ? 0.55 : 1,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  textDecoration: r.retired ? 'line-through' : 'none',
                }}
              >
                {r.content}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--dsh-mem-text-3)', marginTop: 4 }}>
                <span>{labelOf(r.type)}</span>
                {r.scene ? <span>{r.scene}</span> : null}
                {r.agingWeight != null ? <span title="老化权重（读路径衰减系数）">老化 {Math.round(r.agingWeight * 100)}%</span> : null}
                {r.maturity ? <span>成熟 {r.maturity}</span> : null}
                {r.usage && r.usage.used > 0 ? <span>被用 {r.usage.used}</span> : null}
                <span>{fmtTime(r.updatedAt)}</span>
                {r.retired ? <span>已退场</span> : null}
              </div>
            </button>
          );
        })}
        {hasMore ? (
          <div style={{ padding: 8, textAlign: 'center' }}>
            <NButton onClick={() => fetchPage(conds, offsetRef.current, true)} disabled={loading}>
              加载更多
            </NButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}
