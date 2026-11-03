/**
 * 记忆库右栏：三层关联导航（层1 记录 → 层2 实体 → 层3 关系/邻居 → 回到记录）。
 *
 * 为什么必须三层而不是"记录直连记录"：`l1_records` 的 DDL 是逐字节冻结的磁盘契约，
 * 记录行里没有任何 relation/edges 字段，L1 也**不是图的顶点**。所以"这条记忆和谁相关"
 * 只能经图投影的 `sourceRecordIds` 反查——记录→实体是反查，实体→邻居是边走一步，
 * 邻居→记录是回链。三层是投影结构决定的，不是为了 UI 好看而发明的层级。
 *
 * 取代链方向容易写反：`dsh_superseded` marker 写在**退场的旧行**上、`by` 指向新行，
 * 故 `prevIds`（本记录取代掉的旧行）是数组、`nextId`（取代本记录的新行）是单值。
 */
import { tr } from '../i18n.js';
import type { RecordLinksResponse } from '../../../src/contract.js';
import { NButton } from '../ui/primitives.js';
import { fmtTime } from '../format.js';

/** 邻居行：一条关系一行（平行关系不合并，合并就丢关系）。 */
function relLine(n: RecordLinksResponse['neighbors'][number]): string {
  return tr("{p1}{p2} · {p3} 跳 · 经由 {p4}", { p1: n.relation, p2: n.causal ? '（因果）' : '', p3: n.hop, p4: n.viaEntityId });
}

export function LinkPane(props: {
  recordId: string | null;
  links: RecordLinksResponse | null;
  loading: boolean;
  error: string | null;
  onPickRecord: (id: string) => void;
  onEmphasisNode: (id: string) => void;
  /** 记录 id → 显示名（回落列表已有项；拿不到就显示 id 前 8 位）。 */
  labelOfRecord: (id: string) => string;
}) {
  const { recordId, links, loading, error, onPickRecord, onEmphasisNode, labelOfRecord } = props;

  if (!recordId) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>
        {tr("从左侧选一条记忆，这里会列出它涉及的实体、这些实体的关系邻居、以及邻居们的来源记忆——可以一路跳下去。")} </div>
    );
  }
  if (error) {
    return <div style={{ padding: 14, fontSize: 12, color: 'var(--dsh-mem-accent)' }}>{tr("关联查询失败：")}{error}</div>;
  }
  if (loading || !links) {
    return <div style={{ padding: 14, fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>{loading ? tr("加载中…") : ' '}</div>;
  }

  const { record, entities, neighbors, records, supersede, truncated } = links;
  const sec = (title: string, count?: number) => (
    <div style={{ fontSize: 11, letterSpacing: '.06em', color: 'var(--dsh-mem-text-3)', margin: '12px 0 6px' }}>
      {title}
      {count != null ? ` (${count})` : ''}
    </div>
  );
  const chip = (id: string, text: string, title: string, onClick: () => void) => (
    <button
      key={id + text}
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-block',
        margin: '0 6px 6px 0',
        padding: '1px 8px',
        borderRadius: 999,
        border: '1px solid var(--dsh-mem-border-strong)',
        background: 'var(--dsh-mem-accent-weak)',
        color: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      }}
    >
      {text}
    </button>
  );

  return (
    <div style={{ height: '100%', overflowY: 'auto', paddingRight: 2 }}>
      {sec(tr("层1 · 当前记录"))}
      {record ? (
        <div
          style={{
            border: '1px solid var(--dsh-mem-border)',
            borderRadius: 8,
            padding: '8px 10px',
            background: 'var(--dsh-mem-bg-inset)',
            fontSize: 13,
            lineHeight: 1.6,
            opacity: record.retired ? 0.6 : 1,
          }}
        >
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{record.content}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--dsh-mem-text-3)', marginTop: 6 }}>
            <span>{record.type}</span>
            {record.scene ? <span>{record.scene}</span> : null}
            {record.agingWeight != null ? <span>{tr("老化")} {Math.round(record.agingWeight * 100)}%</span> : null}
            {record.maturity ? <span>{tr("成熟")} {record.maturity}</span> : null}
            <span>{fmtTime(record.updatedAt)}</span>
            {record.retired ? <span>{tr("已退场")}{record.retiredReason ? `·${record.retiredReason}` : ''}</span> : null}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>
          {tr("这条记忆还没有被投影进图（图谱未开启，或投影尚未跑到）——所以暂时查不到它的关联。")} </div>
      )}

      {supersede.prevIds.length > 0 || supersede.nextId ? sec(tr("取代链")) : null}
      <div>
        {supersede.nextId
          ? chip(supersede.nextId, tr("→ 被新记忆取代"), tr("取代本记录的新行，点击查看"), () => onPickRecord(supersede.nextId!))
          : null}
        {supersede.prevIds.map((id) => chip(id, tr("← 取代了旧记忆"), tr("本记录取代掉的旧行，点击查看"), () => onPickRecord(id)))}
      </div>

      {sec(tr("层2 · 涉及实体"), entities.length)}
      {entities.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>{tr("无（该记录没有抽出实体）。")}</div>
      ) : (
        <div>
          {entities.map((e) => (
            <span key={e.id}>
              {chip(e.id, `${e.name}`, tr("度 {p1} · 因果 {p2} · 点击在图上强调", { p1: e.degree, p2: e.causalDegree }), () => onEmphasisNode(e.id))}
              {e.recordIds.map((rid) =>
                chip(rid, `↳ ${labelOfRecord(rid).slice(0, 12)}`, tr("该实体的其它来源记忆，点击查看"), () => onPickRecord(rid)),
              )}
            </span>
          ))}
        </div>
      )}

      {sec(tr("层3 · 关系邻居"), neighbors.length)}
      {neighbors.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>{tr("无（这些实体目前没有 active 关系的邻居）。")}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {neighbors.map((n, i) => (
            <div
              key={`${n.id}-${n.relation}-${n.viaEntityId}-${i}`}
              style={{ border: '1px solid var(--dsh-mem-border)', borderRadius: 8, padding: '6px 8px' }}
            >
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{n.name}</span>
                <span style={{ fontSize: 11, color: n.causal ? 'var(--dsh-mem-accent)' : 'var(--dsh-mem-text-3)' }}>
                  {relLine(n)}
                </span>
                <NButton onClick={() => onEmphasisNode(n.id)} title={tr("在图上强调该节点")}>
                  {tr("看图")} </NButton>
              </div>
              <div style={{ marginTop: 4 }}>
                {n.recordIds.map((rid) =>
                  chip(rid, `↳ ${labelOfRecord(rid).slice(0, 14)}`, tr("跳到这条邻居的来源记忆"), () => onPickRecord(rid)),
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {sec(tr("相关记忆"), records.length)}
      {records.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>{tr("无。")}</div>
      ) : (
        records.map((r) => (
          <button
            key={r.id}
            onClick={() => onPickRecord(r.id)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '6px 8px',
              marginBottom: 4,
              border: '1px solid var(--dsh-mem-border)',
              borderRadius: 8,
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              opacity: r.retired ? 0.55 : 1,
            }}
          >
            <div style={{ fontSize: 12, lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.content}
            </div>
            <div style={{ fontSize: 11, color: 'var(--dsh-mem-text-3)' }}>
              {r.type}
              {r.agingWeight != null ? tr("· 老化 {p1}%", { p1: Math.round(r.agingWeight * 100) }) : ''} · {fmtTime(r.updatedAt)}
            </div>
          </button>
        ))
      )}

      {truncated ? (
        <div style={{ fontSize: 11, color: 'var(--dsh-mem-accent)', marginTop: 8 }}>
          {tr("邻居或相关记忆过多，此处已截断（不是没有更多）。")} </div>
      ) : null}
    </div>
  );
}
