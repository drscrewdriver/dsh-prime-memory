/**
 * 记忆库主页面：查询模式 / 图模式 两种全屏视图，顶部滑块切换。
 *
 * 布局策略：
 *   - 查询模式：RecordPane 占满（列表浏览的主视觉）；
 *   - 图模式：图占主视觉 + 右侧详情面板（宽度可拖拽）；
 *   - 从查询点记录 → 自动切图模式并展开该记录的关联详情。
 *
 * 它是 `main` 整页（0.1.7+）与 footer dialog（≤0.1.5）共用的**同一个组件**，
 * 只差容器高度——所以两条线看到的图与关联是同一份实现，不存在“老线功能缩水”。
 *
 * 三条数据来源纪律：
 *   1. 图块走 `graph-preview(mode:'full')`，与设置页图谱 tab 同一端点、同一 caps
 *      → 两个入口的元素集合必然一致；
 *   2. 关联走 `record-links`，一次请求带回三层（记录/实体/邻居/相关记忆）；
 *   3. 查询走 `list-records`，与设置页「记忆」tab 同口径。
 * 本页**只读**：不写图、不改投影、不删记忆——写操作仍归各 tab 自己。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphPreviewResponse, RecordLinksResponse } from '../../../src/contract.js';
import type { RpcFn } from '../rpc.js';
import { GraphCanvas } from '../tabs/GraphCanvas.js';
import type { GraphFull } from '../tabs/graph-canvas-data.js';
import { NButton } from '../ui/primitives.js';
import { LinkPane } from './LinkPane.js';
import { RecordPane } from './RecordPane.js';
import { Scene3D } from './Scene3D.js';

// ── 图模式下右侧详情面板常量 ──
const DETAIL_MIN = 260;
const DETAIL_DEFAULT = 380;
const DETAIL_MAX_RATIO = 0.55;

/** 类型图例（与 2D/3D 同一族令牌五色）：只列当前图里真实出现的类型；
 *  令牌按**全表索引**配（先配后筛），筛掉前面的类型不得让后面的变色。 */
const LEGEND_TYPES: Array<[string, string, string]> = [
  ['person', '人', '--dsh-mem-chart-1'],
  ['project', '项目', '--dsh-mem-chart-2'],
  ['organization', '组织', '--dsh-mem-chart-3'],
  ['tool', '工具', '--dsh-mem-chart-4'],
  ['place', '地点', '--dsh-mem-chart-5'],
];

export function ExplorerPage(props: { rpc: RpcFn; onClose?: () => void; canvasHeight?: number }) {
  const { rpc, onClose, canvasHeight = 620 } = props;
  const [full, setFull] = useState<GraphFull | null>(null);
  const [stats, setStats] = useState<GraphPreviewResponse['stats'] | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphLoading, setGraphLoading] = useState(true);

  const [recordId, setRecordId] = useState<string | null>(null);
  const [links, setLinks] = useState<RecordLinksResponse | null>(null);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [emphasisId, setEmphasisId] = useState<string | undefined>(undefined);
  /** 图块视图：2D（G6 星图）/ 3D（自研投影）——默认 3D（用户要求：进图默认 3D + 星空底）。 */
  const [view, setView] = useState<'2d' | '3d'>('3d');
  const linksSeq = useRef(0);

  /** 视图模式：查询（全屏列表）/ 图（图+详情）。 */
  const [mode, setMode] = useState<'query' | 'graph'>('query');
  /** 图模式下右侧详情是否展开。 */
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailW, setDetailW] = useState(DETAIL_DEFAULT);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragWRef = useRef<{ startX: number; startW: number } | null>(null);

  /** 拖拽手柄：向左拖详情变宽。 */
  const startDrag = useCallback((ev: React.MouseEvent) => {
    ev.preventDefault();
    dragWRef.current = { startX: ev.clientX, startW: detailW };
    const onMove = (e: MouseEvent) => {
      const d = dragWRef.current;
      if (!d) return;
      const container = containerRef.current;
      const maxW = container ? Math.round(container.clientWidth * DETAIL_MAX_RATIO) : 600;
      setDetailW(Math.min(maxW, Math.max(DETAIL_MIN, d.startW - (e.clientX - d.startX))));
    };
    const onUp = () => {
      dragWRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [detailW]);

  /** 记录 id → 显示名（关联面板里的 chip 文案；随响应累积，拿不到时回落 id 前缀）。 */
  const labels = useRef(new Map<string, string>());

  const loadGraph = useCallback(() => {
    setGraphLoading(true);
    setGraphError(null);
    rpc('dsh-memory/graph-preview', { mode: 'full' })
      .then((r) => {
        if (!r.ok) throw new Error(r.error.message);
        setStats(r.value.stats);
        setFull(r.value.full ?? { nodes: [], edges: [], truncated: false });
      })
      .catch((e: unknown) => setGraphError(String((e as Error)?.message ?? e)))
      .finally(() => setGraphLoading(false));
  }, [rpc]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  const remember = useCallback((items: Array<{ id: string; content: string }>) => {
    for (const it of items) if (it.content) labels.current.set(it.id, it.content);
  }, []);

  const openRecord = useCallback(
    (id: string) => {
      const token = ++linksSeq.current;
      setRecordId(id);
      setLinksLoading(true);
      setLinksError(null);
      // 选中记录时自动切到图模式并展开详情
      setMode('graph');
      setDetailOpen(true);
      rpc('dsh-memory/record-links', { recordId: id })
        .then((r) => {
          if (token !== linksSeq.current) return;
          if (!r.ok) throw new Error(r.error.message);
          const v = r.value;
          if (v.record) remember([v.record]);
          remember(v.records);
          setLinks(v);
          // 选中记录后把它的第一个实体作为图上强调起点——用户最想知道的
          // 就是"这条记忆挂在图的哪个位置"。
          setEmphasisId(v.entities[0]?.id);
        })
        .catch((e: unknown) => {
          if (token !== linksSeq.current) return;
          setLinksError(String((e as Error)?.message ?? e));
          setLinks(null);
        })
        .finally(() => {
          if (token === linksSeq.current) setLinksLoading(false);
        });
    },
    [rpc, remember],
  );

  /** 图上点实体：优先用已下发的 recordIds（省一次往返），否则回查节点详情。 */
  const onPickNode = useCallback(
    (nodeId: string) => {
      setEmphasisId(nodeId);
      // 无条件展开详情面板（即使解析记录还在路上，用户至少看到“加载中”）
      setDetailOpen(true);
      const known = links?.entities.find((e) => e.id === nodeId) ?? links?.neighbors.find((n) => n.id === nodeId);
      const first = known?.recordIds[0];
      if (first) {
        openRecord(first);
        return;
      }
      rpc('dsh-memory/graph-node-get', { id: nodeId })
        .then((r) => {
          const node = r.ok ? r.value.node : null;
          const id = node?.sourceRecordIds?.[0];
          if (id) openRecord(id);
        })
        .catch(() => {
          /* 点不到来源记录只影响跳转，不影响看图 */
        });
    },
    [links, openRecord, rpc],
  );

  const labelOfRecord = useCallback((id: string) => labels.current.get(id) ?? id.slice(0, 10), []);

  const building = stats && stats.jobsTotal > 0 && stats.pendingJobs > 0;
  const summary = useMemo(() => {
    if (!stats) return '统计未到';
    const drawn = full ? full.nodes.length : 0;
    const cut = full?.truncated ? `（已截断，仅画部分）` : '';
    return `节点 ${drawn}/${stats.nodes} · 边 ${full ? full.edges.length : 0}/${stats.edges} · 因果边 ${stats.causalEdges}${cut}`;
  }, [stats, full]);

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, height: 'calc(100vh - 48px)', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>记忆库</h2>
        <span style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>{summary}</span>
        {building ? (
          <span style={{ fontSize: 12, color: 'var(--dsh-mem-accent)' }} title="图谱投影进行中">
            构建中 {stats ? stats.jobsTotal - stats.pendingJobs : 0}/{stats?.jobsTotal ?? 0}
          </span>
        ) : null}
        {view === '3d' && full && full.nodes.length > 0 ? (
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--dsh-mem-text-3)' }}>
            {LEGEND_TYPES.filter(([t]) => full.nodes.some((n) => n.type === t)).map(([t, zh, token]) => (
              <span key={t}>
                <span
                  style={{ width: 8, height: 8, borderRadius: 8, display: 'inline-block', marginRight: 3, background: `var(${token})` }}
                />
                {zh}
              </span>
            ))}
            <span title="亮度=老化权重（来源记录新鲜度），拉近后依然分得出新旧">亮度=老化</span>
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {/* 视图模式滑块：查询 ↔ 图 */}
        <span style={{ display: 'inline-flex', border: '1px solid var(--dsh-mem-border)', borderRadius: 6, overflow: 'hidden', fontSize: 12 }}>
          <span
            onClick={() => setMode('query')}
            style={{ padding: '3px 12px', cursor: 'pointer', background: mode === 'query' ? 'var(--dsh-mem-accent)' : 'transparent', color: mode === 'query' ? '#fff' : 'var(--dsh-mem-text-2)' }}
          >查询</span>
          <span
            onClick={() => setMode('graph')}
            style={{ padding: '3px 12px', cursor: 'pointer', background: mode === 'graph' ? 'var(--dsh-mem-accent)' : 'transparent', color: mode === 'graph' ? '#fff' : 'var(--dsh-mem-text-2)' }}
          >图</span>
        </span>
        {/* 图模式专属控件 */}
        {mode === 'graph' ? (
          <>
            <NButton
              onClick={() => {
                if (!recordId && emphasisId) {
                  // 无选中记录但有强调节点（如 3D 点击后）：自动解析该节点的来源记录
                  onPickNode(emphasisId);
                }
                setDetailOpen((v) => !v);
              }}
              title="展开/收起右侧详情"
              style={detailOpen ? { color: 'var(--dsh-mem-accent)', borderColor: 'var(--dsh-mem-accent)' } : undefined}
            >
              详情
            </NButton>
            <NButton
              onClick={() => setView((v) => (v === '2d' ? '3d' : '2d'))}
              title="切换星图渲染：2D（G6 力导）↔ 3D（Canvas 投影）"
              style={view === '3d' ? { color: 'var(--dsh-mem-accent)', borderColor: 'var(--dsh-mem-accent)' } : undefined}
            >
              {view === '3d' ? '3D' : '2D'}
            </NButton>
          </>
        ) : null}
        <NButton onClick={loadGraph} title="重新拉取图与统计">刷新图</NButton>
        {onClose ? <NButton onClick={onClose} title="关闭">关闭</NButton> : null}
      </div>

      {/* 主体：查询模式全屏列表 / 图模式 = 图 + 右侧详情(可调宽) */}
      {mode === 'query' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <RecordPane rpc={rpc} activeId={recordId} onPick={openRecord} />
        </div>
      ) : (
        <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 0 }}>
          {/* 图区域——吃满剩余宽高 */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {graphError ? (
            <div style={{ fontSize: 12, color: 'var(--dsh-mem-accent)', padding: 8 }}>
              图数据读取失败：{graphError} <NButton onClick={loadGraph}>重试</NButton>
            </div>
          ) : graphLoading ? (
            <div style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)', padding: 8 }}>图加载中…</div>
          ) : full && full.nodes.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)', padding: 8 }}>
              图里还没有节点。图谱投影默认关闭——在设置页「概览 → 知识图谱」打开开关后，存量记忆会逐批投影成实体与关系。
            </div>
          ) : full ? (
            view === '3d' ? (
              <Scene3D full={full} onPick={onPickNode} emphasisId={emphasisId} height={canvasHeight} />
            ) : (
              <GraphCanvas full={full} onPick={onPickNode} emphasisId={emphasisId} fit="view" height="fill" />
            )
          ) : null}
          </div>

          {/* 右侧详情面板（拖拽手柄 + 内容） */}
          {detailOpen ? (
            <>
              <div
                onMouseDown={startDrag}
                style={{ width: 5, cursor: 'col-resize', flexShrink: 0, background: 'var(--dsh-mem-border)', borderRadius: 2, margin: '0 2px', alignSelf: 'stretch' }}
                title="拖动调整详情宽度"
              />
              <div style={{ width: detailW, minWidth: DETAIL_MIN, flexShrink: 0, overflow: 'auto', minHeight: 0, borderLeft: '1px solid var(--dsh-mem-border)', paddingLeft: 10 }}>
                <LinkPane
                  recordId={recordId}
                  links={links}
                  loading={linksLoading}
                  error={linksError}
                  onPickRecord={openRecord}
                  onEmphasisNode={setEmphasisId}
                  labelOfRecord={labelOfRecord}
                />
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
