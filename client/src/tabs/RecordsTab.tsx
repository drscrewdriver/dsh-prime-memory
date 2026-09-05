/** Tab：L1 记忆浏览器（搜索/筛选/分页 + 展开详情 + 高权限删除：单条与批量勾选）。 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ListRecordsRequest, UiRecord } from '../../../src/contract.js';
import { TYPE_LABELS, fmtTime } from '../format.js';
import type { RpcFn } from '../rpc.js';
import { S } from '../styles.js';
import { NSel, type NSelOption } from '../ui/NSel.js';
import { NButton, NInput } from '../ui/primitives.js';

interface QueryConds {
  query: string;
  type: string;
  scene: string;
  hall: string;
}

// 两族混合视图：筛选器提供全部 7 种类型
const TYPE_CHOICES = [
  'persona',
  'episodic',
  'instruction',
  'work_fact',
  'work_task',
  'work_method',
  'work_artifact',
];

// Hall 属性通道筛选项（粗分类；与 host types.ts 的 HALL_CATALOG 对齐，client 侧不 import 运行时代码）
const HALL_CHOICES = [
  { id: 'work', label: '工作' },
  { id: 'relationships', label: '人际关系' },
  { id: 'general', label: '通用' },
  { id: 'finance', label: '财务' },
  { id: 'journey', label: '旅程' },
];
const HALL_LABEL: Record<string, string> = Object.fromEntries(HALL_CHOICES.map((h) => [h.id, h.label]));

/** records-delete 单次上限（契约：ids ≤200）。 */
const DELETE_LIMIT = 200;

export function RecordsTab(props: { rpc: RpcFn }) {
  const rpc = props.rpc;
  const limit = 50;

  const [items, setItems] = useState<UiRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [sceneOptions, setSceneOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 勾选待删集合（批量删除用）；换页/搜索重置
  const [sel, setSel] = useState<Set<string>>(new Set());
  // 写删权限门（memoryMutate）：开启后模型获得写删工具、面板可删除记忆
  const [hiPriv, setHiPriv] = useState(false);
  const [hiPrivBusy, setHiPrivBusy] = useState(false);

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [sceneFilter, setSceneFilter] = useState('');
  const [hallFilter, setHallFilter] = useState('');

  // 上一次实际生效的查询条件（「加载更多」按它续页）
  const [last, setLast] = useState<QueryConds>({ query: '', type: '', scene: '', hall: '' });

  // 请求序号：快速搜索/翻页时旧响应过期即弃，避免慢响应覆盖新结果
  const seqRef = useRef(0);

  const fetchPage = useCallback(
    (conds: QueryConds, offset: number, append: boolean) => {
      setLoading(true);
      setError(null);
      const token = ++seqRef.current;
      const payload: ListRecordsRequest = { limit, offset };
      if (conds.query) payload.query = conds.query;
      if (conds.type) payload.type = conds.type;
      if (conds.scene) payload.scene = conds.scene;
      if (conds.hall) payload.hall = conds.hall;
      rpc('dsh-memory/list-records', payload)
        .then((r) => {
          if (token !== seqRef.current) return;
          setLoading(false);
          if (!r || !r.ok) {
            setError(r && r.error ? r.error.message : 'RPC error');
            return;
          }
          const v = r.value;
          setItems((prev) => (append ? prev.concat(v.items) : v.items));
          // 换页（非追加）时勾选集作废：列表内容已不是原来那批
          if (!append) setSel(new Set());
          setHasMore(!!v.hasMore);
          setTotal(v.total === undefined || v.total === null ? null : v.total);
          setTruncated(!!v.truncated);
          if (v.scenes) setSceneOptions(v.scenes);
        })
        .catch((e: unknown) => {
          if (token !== seqRef.current) return;
          setLoading(false);
          setError(String((e && (e as Error).message) || e));
        });
    },
    [rpc],
  );

  const search = () => {
    const conds = { query: query.trim(), type: typeFilter, scene: sceneFilter, hall: hallFilter };
    setLast(conds);
    fetchPage(conds, 0, false);
  };

  useEffect(() => {
    fetchPage({ query: '', type: '', scene: '', hall: '' }, 0, false);
  }, [fetchPage]);

  // 读当前写删门状态（settings-get 的 key 均脱敏，memoryMutate 布尔原样）
  const loadHiPriv = useCallback(() => {
    rpc('dsh-memory/settings-get', {})
      .then((r) => {
        if (r && r.ok && r.value) setHiPriv(!!r.value.settings.memoryMutate);
      })
      .catch(() => {});
  }, [rpc]);
  useEffect(() => {
    loadHiPriv();
  }, [loadHiPriv]);

  const toggleHiPriv = () => {
    const next = !hiPriv;
    if (next && !window.confirm('开启高权限模式：模型获得写入/删除记忆工具，记忆库可删除指定记忆。确定开启？')) return;
    setHiPrivBusy(true);
    rpc('dsh-memory/settings-set', { memoryMutate: next })
      .then((r) => {
        if (r && r.ok) setHiPriv(next);
        else if (r) setError(r.error ? r.error.message : '切换高权限模式失败');
        setHiPrivBusy(false);
        loadHiPriv();
      })
      .catch((e: unknown) => {
        setHiPrivBusy(false);
        setError(String((e && (e as Error).message) || e));
      });
  };

  const toggleSel = (id: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 批量删除勾选记忆（records-delete，ids 数组一次 ≤200）。
   *  写删门关闭时不动手：给提示引导先开高权限模式。 */
  const deleteSelected = () => {
    const ids = Array.from(sel);
    if (ids.length === 0) return;
    if (!hiPriv) {
      setError('高权限模式未开启：请在右上「高权限：关」或概览页开关中开启后，再删除记忆。');
      return;
    }
    if (ids.length > DELETE_LIMIT) {
      setError('一次最多删除 ' + DELETE_LIMIT + ' 条（当前勾选 ' + ids.length + ' 条），请分批操作。');
      return;
    }
    if (!window.confirm('删除勾选的 ' + ids.length + ' 条记忆？本操作不可逆（完整重建可能从 L0 复活，为已知边界）。')) return;
    rpc('dsh-memory/records-delete', { ids })
      .then((r) => {
        if (r && r.ok) {
          setSel(new Set());
          if (expandedId && ids.indexOf(expandedId) >= 0) setExpandedId(null);
          fetchPage(last, 0, false);
        } else if (r) setError(r.error ? r.error.message : '删除失败');
      })
      .catch((e: unknown) => setError(String((e && (e as Error).message) || e)));
  };

  /** 单条删除（二次确认；host 侧同样有 memoryMutate 门兜底）。 */
  const deleteRecord = (id: string) => {
    if (!window.confirm('删除该条记忆？本操作不可逆（完整重建可能从 L0 复活，为已知边界）。')) return;
    rpc('dsh-memory/records-delete', { ids: [id] })
      .then((r) => {
        if (r && r.ok) {
          setSel((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          if (expandedId === id) setExpandedId(null);
          fetchPage(last, 0, false);
        } else if (r) setError(r.error ? r.error.message : '删除失败');
      })
      .catch((e: unknown) => setError(String((e && (e as Error).message) || e)));
  };

  const countText = total !== null ? '共 ' + total + ' 条' : items.length + ' 条' + (hasMore ? '+' : '');
  const selCount = sel.size;

  return (
    <div>
      <div style={S.toolbar}>
        <NInput
          style={{ flex: 1, minWidth: 160 }}
          placeholder="搜索记忆内容（BM25 关键词）…"
          value={query}
          onChange={(e: { target: { value: string } }) => {
            setQuery(e.target.value);
          }}
          onKeyDown={(e: ReactKeyboardEvent) => {
            if (e.key === 'Enter') search();
          }}
        />
        <NSel
          style={{ maxWidth: 200 }}
          options={([{ id: '', label: '全部类型' }] as NSelOption[]).concat(
            TYPE_CHOICES.map((t) => {
              return { id: t, label: TYPE_LABELS[t] || t };
            }),
          )}
          value={typeFilter}
          onChange={setTypeFilter}
        />
        <NSel
          style={{ maxWidth: 220 }}
          options={([{ id: '', label: '全部情境' }] as NSelOption[]).concat(
            sceneOptions.map((s) => {
              return { id: s, label: s.length > 24 ? s.slice(0, 24) + '…' : s };
            }),
          )}
          value={sceneFilter}
          onChange={setSceneFilter}
        />
        <NSel
          style={{ maxWidth: 150 }}
          options={([{ id: '', label: '全部 Hall' }] as NSelOption[]).concat(
            HALL_CHOICES.map((h) => {
              return { id: h.id, label: h.label };
            }),
          )}
          value={hallFilter}
          onChange={setHallFilter}
        />
        <NButton onClick={search}>搜索</NButton>
        <NButton
          style={{
            color: hiPriv ? 'var(--dsh-mem-danger)' : undefined,
            border: hiPriv ? '1px solid var(--dsh-mem-danger)' : undefined,
          }}
          disabled={hiPrivBusy}
          title={hiPriv ? '关闭高权限模式（收回模型写删工具与删除权限）' : '开启高权限模式以写删记忆'}
          onClick={toggleHiPriv}
        >
          {hiPriv ? '高权限：开' : '高权限：关'}
        </NButton>
      </div>
      <div style={{ ...S.flexRow, marginBottom: 10 }}>
        <span style={S.muted}>{loading ? '加载中…' : countText}</span>
        {/* 批量删除：勾选后成组调 records-delete；写删门关闭时点击给提示 */}
        <NButton
          style={selCount > 0 ? { color: 'var(--dsh-mem-danger)' } : undefined}
          disabled={selCount === 0}
          title={hiPriv ? '删除勾选的记忆（一次最多 ' + DELETE_LIMIT + ' 条）' : '高权限模式未开启，删除不可用'}
          onClick={deleteSelected}
        >
          {'删除选中' + (selCount > 0 ? '（' + selCount + '）' : '')}
        </NButton>
        {selCount > 0 ? (
          <NButton
            onClick={() => {
              setSel(new Set());
            }}
          >
            清空选择
          </NButton>
        ) : null}
        <div style={S.grow} />
        <NButton
          onClick={() => {
            fetchPage(last, 0, false);
          }}
        >
          刷新
        </NButton>
      </div>
      {!hiPriv ? <div style={S.hint}>提示：删除记忆需先开启高权限模式（右上开关或概览页「高权限模式」），关闭时删除按钮不可用。</div> : null}
      {error ? <div style={S.error}>{error}</div> : null}
      {truncated ? (
        <div style={S.hint}>搜索分页已达检索上限（200 条），更早的结果未显示。请用更精确的关键词或类型/情境过滤。</div>
      ) : null}
      {items.length === 0 && !loading && !error ? (
        <p style={S.intro}>暂无记忆。对话几轮后，蒸馏管线会自动抽取记忆。</p>
      ) : (
        items.map((m) => {
          const open = expandedId === m.id;
          const checked = sel.has(m.id);
          return (
            <div
              key={m.id}
              className="dsh-mem-card dsh-mem-card-hover"
              style={{ ...S.card, cursor: 'pointer', ...(checked ? { borderLeft: '3px solid var(--dsh-mem-danger)' } : null) }}
              onClick={() => {
                setExpandedId(open ? null : m.id);
              }}
            >
              <div style={S.cardHead}>
                {/* 勾选框（阻止冒泡：点勾选不触发展开/收起） */}
                <input
                  type="checkbox"
                  checked={checked}
                  style={{ margin: 0, cursor: 'pointer', flexShrink: 0 }}
                  title="勾选以批量删除"
                  onClick={(e: { stopPropagation(): void }) => {
                    e.stopPropagation();
                  }}
                  onChange={() => {
                    toggleSel(m.id);
                  }}
                />
                <span className={'dsh-mem-tag dsh-mem-tag-' + m.type}>{TYPE_LABELS[m.type] || m.type}</span>
                {m.hall ? <span className="dsh-mem-tag dsh-mem-tag-work-fact">{'Hall · ' + (HALL_LABEL[m.hall] || m.hall)}</span> : null}
                <span style={S.muted}>{'优先级 ' + m.priority}</span>
                {m.score !== null && m.score !== undefined ? (
                  <span style={S.muted}>{'相关度 ' + Number(m.score).toFixed(2)}</span>
                ) : null}
                <div style={S.grow} />
                <span style={S.muted}>{fmtTime(m.updatedAt)}</span>
                {hiPriv ? (
                  <NButton
                    style={{ padding: '0 7px', minWidth: 26, height: 26, fontSize: 12, color: 'var(--dsh-mem-danger)' }}
                    title="删除该记忆（高权限）"
                    onClick={(e: { stopPropagation(): void }) => {
                      e.stopPropagation();
                      deleteRecord(m.id);
                    }}
                  >
                    ✕
                  </NButton>
                ) : null}
              </div>
              <div style={S.content}>{m.content}</div>
              {open ? (
                <div style={S.detail}>
                  {'id: ' +
                    m.id +
                    '\n' +
                    '情境: ' +
                    (m.scene || '-') +
                    '\n' +
                    '版本: v' +
                    m.version +
                    '（去重合并次数 ' +
                    m.version +
                    '）\n' +
                    '创建: ' +
                    fmtTime(m.createdAt) +
                    '\n' +
                    '活跃时间: ' +
                    (m.timestamps && m.timestamps.length > 0 ? m.timestamps.map(fmtTime).join(' → ') : '-') +
                    '\n' +
                    (m.sourceMessageIds && m.sourceMessageIds.length > 0
                      ? '来源消息: ' + m.sourceMessageIds.join(', ')
                      : '来源消息: -')}
                </div>
              ) : null}
            </div>
          );
        })
      )}
      {hasMore ? (
        <div style={S.flexRow}>
          <div style={S.grow} />
          <NButton
            disabled={loading}
            onClick={() => {
              if (!loading) fetchPage(last, items.length, true);
            }}
          >
            {loading ? '加载中…' : '加载更多'}
          </NButton>
        </div>
      ) : null}
    </div>
  );
}
