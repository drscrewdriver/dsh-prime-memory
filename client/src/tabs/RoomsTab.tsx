/** Tab:Hall —— Room 大类/小类分类管理(beta.7,room-classification-management T15)。
 *
 *  术语:UI 层 大类=Hall、小类/条目=Room;代码仍叫 major/minor(与注册表一致)。
 *  Hall 与 Wing(metadata.hall,域)及认知 hall 无关 —— 只是 Room 词表的分组视图。
 *  - Hall 分组:slug 无 '/' 自成 hall(它既是 hall 又是其下唯一 room);'major/minor' 归其前缀。
 *  - 操作:两级注册 / 收编自生长(source=grown)/ 改名 / 合并(dryRun 预览→确认实跑)/
 *    退役·恢复 / 每 room 记录 CSV 导出。破坏性操作统一走 dsh-memory/room-admin,
 *    高权限(memoryMutate)门控,与 memory_room_admin 工具同一编排(备份+入队场景重算)。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { RpcFn } from '../rpc.js';
import { S } from '../styles.js';

/** 大类归属(slug 首段;与 src/store/rooms-registry.ts majorOf 同义,客户端本地复刻
 *  ——该模块依赖 node:fs,不可进客户端 bundle)。 */
function majorOf(slug: string): string {
  const i = slug.indexOf('/');
  return i === -1 ? slug : slug.slice(0, i);
}

function downloadCsv(csv: string, name: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

interface RegEntry {
  slug: string;
  label?: string;
  description?: string;
  source: 'pre-registered' | 'grown';
  aliases?: string[];
  status: 'active' | 'retired';
}

const btn: CSSProperties = {
  cursor: 'pointer', fontSize: 12, padding: '2px 8px', borderRadius: 6,
  border: '1px solid var(--dsh-mem-border)', background: 'transparent',
  color: 'var(--dsh-mem-text-2)',
};

export function RoomsTab(props: { rpc: RpcFn }) {
  const rpc = props.rpc;

  const [registry, setRegistry] = useState<RegEntry[]>([]);
  const [rooms, setRooms] = useState<Array<{ room: string; count: number; label?: string }>>([]);
  const [orphanCount, setOrphanCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 高权限门(与记忆页同一 memoryMutate 键;两页各自同步显示)
  const [hiPriv, setHiPriv] = useState(false);
  const [hiPrivBusy, setHiPrivBusy] = useState(false);
  // 注册表单(受控;「+小类」预填 hall 前缀)
  const [regSlug, setRegSlug] = useState('');
  const [regLabel, setRegLabel] = useState('');
  const [regDesc, setRegDesc] = useState('');
  // 行内合并/改名表单 + dryRun 预览态(预览 → 确认执行)
  const [form, setForm] = useState<{ action: 'merge' | 'rename'; from: string; to: string } | null>(null);
  const [preview, setPreview] = useState<{ action: 'merge' | 'rename'; from: string; to: string; notice: string } | null>(null);
  // 未注册自生长区收拢态
  const [grownOpen, setGrownOpen] = useState(false);

  const loadAll = useCallback(() => {
    rpc('dsh-memory/rooms-get', {})
      .then((r) => {
        if (r && r.ok) {
          setRooms(r.value.rooms ?? []);
          setRegistry(r.value.registry ?? []);
          setOrphanCount(r.value.orphanCount ?? 0);
        }
      })
      .catch(() => undefined); /* 端点不可用:留空态,不阻塞面板 */
  }, [rpc]);

  const loadHiPriv = useCallback(() => {
    rpc('dsh-memory/settings-get', {})
      .then((r) => {
        if (r && r.ok && r.value) setHiPriv(!!r.value.settings.memoryMutate);
      })
      .catch(() => {});
  }, [rpc]);

  useEffect(() => {
    loadAll();
    loadHiPriv();
  }, [loadAll, loadHiPriv]);

  const toggleHiPriv = () => {
    const next = !hiPriv;
    if (next && !window.confirm('开启高权限模式:模型获得写入/删除记忆工具,并解锁 Hall 页的分类管理操作。确定开启?')) return;
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

  /** 统一操作壳:串行 + 提示复位。 */
  const run = (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    fn().finally(() => setBusy(false));
  };

  const register = () =>
    run(async () => {
      const r = await rpc('dsh-memory/room-register', {
        slug: regSlug.trim(),
        label: regLabel.trim() || undefined,
        description: regDesc.trim() || undefined,
      });
      if (r && r.ok) {
        setMsg(r.value?.notice ?? `已注册:${regSlug.trim()}`);
        setRegSlug('');
        setRegLabel('');
        setRegDesc('');
        loadAll();
      } else setError(r && r.error ? r.error.message : '注册失败');
    });

  /** 收编自生长 slug(source=grown;词表挂靠优先级与预注册同)。 */
  const adopt = (slug: string) =>
    run(async () => {
      const r = await rpc('dsh-memory/room-register', { slug, source: 'grown' });
      if (r && r.ok) {
        setMsg(`已收编:${slug}(source=grown)`);
        loadAll();
      } else setError(r && r.error ? r.error.message : '收编失败');
    });

  const previewMerge = () =>
    run(async () => {
      if (!form) return;
      const to = form.to.trim();
      if (!to) { setError('目标 slug 不能为空'); return; }
      if (to === form.from) { setError('目标与源相同'); return; }
      const r = await rpc('dsh-memory/room-admin', { action: form.action, from: form.from, to });
      if (r && r.ok) {
        setPreview({ action: form.action, from: form.from, to, notice: String(r.value?.notice ?? '') });
      } else setError(r && r.error ? r.error.message : '预览失败');
    });

  const execMerge = () =>
    run(async () => {
      if (!preview) return;
      const r = await rpc('dsh-memory/room-admin', { action: preview.action, from: preview.from, to: preview.to, dryRun: false });
      if (r && r.ok) {
        setMsg(String(r.value?.notice ?? '完成'));
        setPreview(null);
        setForm(null);
        loadAll();
      } else setError(r && r.error ? r.error.message : '执行失败');
    });

  const retire = (slug: string, active: boolean) =>
    run(async () => {
      if (!active && !window.confirm(`退役 Room:${slug}?\n\n存量记录的 tags 不动,仅词表不再推荐;可随时恢复。`)) return;
      const r = await rpc('dsh-memory/room-admin', { action: 'retire', slug, active });
      if (r && r.ok) {
        setMsg(String(r.value?.notice ?? '完成'));
        loadAll();
      } else setError(r && r.error ? r.error.message : '操作失败');
    });

  const exportRecords = (slug: string) =>
    run(async () => {
      const r = await rpc('dsh-memory/rooms-export', { kind: 'records', tag: slug });
      if (!r.ok) { setError(r.error.message); return; }
      if (r.value.csv) downloadCsv(r.value.csv, `dsh-memory-room-${slug.replace(/\//g, '-')}-records.csv`);
      else setError('导出为空');
    });

  // ── 视图模型:hall 分组 + 未注册自生长区 ──
  const groups = useMemo(() => {
    const countOf = new Map(rooms.map((r) => [r.room, r.count]));
    const byHall = new Map<string, RegEntry[]>();
    for (const e of registry) {
      const hall = majorOf(e.slug);
      const list = byHall.get(hall);
      if (list) list.push(e);
      else byHall.set(hall, [e]);
    }
    return [...byHall.entries()]
      .map(([hall, entries]) => ({
        hall,
        label: registry.find((e) => e.slug === hall)?.label,
        entries: [...entries].sort((a, b) => a.slug.localeCompare(b.slug)),
        total: entries.reduce((s2, e) => s2 + (countOf.get(e.slug) ?? 0), 0),
      }))
      .sort((a, b) => a.hall.localeCompare(b.hall));
  }, [registry, rooms]);

  const grownOnly = useMemo(() => rooms.filter((r) => !registry.some((e) => e.slug === r.room)), [rooms, registry]);

  return (
    <div>
      <div style={{ ...S.flexRow, marginBottom: 8 }}>
        <span style={S.muted}>Hall = Room 大类 · 大类上限 200,小类「大类/小类」细分不占额度 · 与 Wing(域)筛选无关</span>
        <div style={S.grow} />
        <button
          type="button"
          title="导出分类数据 CSV(Room 词表+计数)"
          onClick={() =>
            run(async () => {
              const r = await rpc('dsh-memory/rooms-export', { kind: 'rooms' });
              if (!r.ok) { setError(r.error.message); return; }
              if (r.value.csv) downloadCsv(r.value.csv, 'dsh-memory-rooms.csv');
            })
          }
          style={btn}
        >导出词表</button>
        <button
          type="button"
          title="导出无 Room 绑定的孤儿清单(含候选)"
          onClick={() =>
            run(async () => {
              const r = await rpc('dsh-memory/rooms-export', { kind: 'orphans' });
              if (!r.ok) { setError(r.error.message); return; }
              if (r.value.csv) downloadCsv(r.value.csv, 'dsh-memory-room-orphans.csv');
            })
          }
          style={btn}
        >导出孤儿 · {orphanCount}</button>
        <button
          type="button"
          style={{
            ...btn,
            color: hiPriv ? 'var(--dsh-mem-danger)' : undefined,
            border: hiPriv ? '1px solid var(--dsh-mem-danger)' : btn.border,
          }}
          disabled={hiPrivBusy}
          title={hiPriv ? '关闭高权限模式(收回模型写删工具与管理操作)' : '开启高权限模式以解锁分类管理操作'}
          onClick={toggleHiPriv}
        >{hiPriv ? '高权限:开' : '高权限:关'}</button>
        <button type="button" style={btn} onClick={loadAll} title="重拉注册表与计数">刷新</button>
      </div>

      {/* 注册表单(高权限):两级 slug 一次注册 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 10 }}>
        <input
          value={regSlug}
          onChange={(e) => setRegSlug(e.target.value)}
          placeholder="slug(如 dsh-plugin 或 dsh-plugin/merge)"
          disabled={!hiPriv || busy}
          style={{ ...S.input, width: 210, fontSize: 12 }}
        />
        <input
          value={regLabel}
          onChange={(e) => setRegLabel(e.target.value)}
          placeholder="名称(可中文)"
          disabled={!hiPriv || busy}
          style={{ ...S.input, width: 110, fontSize: 12 }}
        />
        <input
          value={regDesc}
          onChange={(e) => setRegDesc(e.target.value)}
          placeholder="归类说明(喂标注器)"
          disabled={!hiPriv || busy}
          style={{ ...S.input, width: 170, fontSize: 12 }}
        />
        <button
          type="button"
          disabled={!hiPriv || busy || !regSlug.trim()}
          onClick={register}
          style={{ ...btn, color: 'var(--dsh-mem-accent)', borderColor: 'var(--dsh-mem-accent)', opacity: !hiPriv || busy || !regSlug.trim() ? 0.5 : 1 }}
        >注册</button>
        {!hiPriv && <span style={S.muted}>管理操作需先开启高权限模式</span>}
      </div>

      {msg ? <div style={S.hint}>{msg}</div> : null}
      {error ? <div style={S.error}>{error}</div> : null}

      {/* Hall 分组树 */}
      {groups.length === 0 ? (
        <p style={S.intro}>{'注册表为空。在上方注册 Hall/Room(如 dsh-plugin),或把自生长 slug「收编」进词表 —— 之后候选标注器会优先把相关记忆挂到这些 slug 上。'}</p>
      ) : (
        groups.map((g) => (
          <div key={g.hall} style={{ marginBottom: 10, border: '1px solid var(--dsh-mem-border)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: 'var(--dsh-mem-bg-inset)' }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                {g.hall}
                {g.label ? <span style={S.muted}>{' (' + g.label + ')'}</span> : null}
              </span>
              <span style={S.muted}>{`合计 ${g.total} 条 · ${g.entries.length} 个 room`}</span>
              <div style={S.grow} />
              <button
                type="button"
                disabled={!hiPriv || busy}
                title={`预填注册表单为 ${g.hall}/…(注册该 hall 下的小类)`}
                onClick={() => setRegSlug(g.hall + '/')}
                style={btn}
              >+小类</button>
            </div>
            {g.entries.map((e) => {
              const standalone = e.slug === g.hall;
              const count = rooms.find((r) => r.room === e.slug)?.count ?? 0;
              const retired = e.status === 'retired';
              return (
                <div key={e.slug} style={{ padding: '4px 10px', borderTop: '1px solid var(--dsh-mem-border)', opacity: retired ? 0.55 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12 }} title={e.description ? `${e.slug} — ${e.description}` : e.slug}>
                      {standalone ? e.slug : '· ' + e.slug.slice(g.hall.length + 1)}
                      {e.source === 'pre-registered' ? ' ⭐' : ''}
                    </span>
                    {e.label ? <span style={S.muted}>{e.label}</span> : null}
                    <span style={S.muted}>{count + ' 条'}</span>
                    {retired ? <span style={{ ...S.muted, color: 'var(--dsh-mem-danger)' }}>已退役</span> : null}
                    {(e.aliases ?? []).length > 0 ? <span style={S.muted}>{'别名: ' + (e.aliases ?? []).join(', ')}</span> : null}
                    <div style={S.grow} />
                    {!hiPriv ? null : (
                      <>
                        <button type="button" disabled={busy} title={`改名(= merge 1:1 + 注册表改名)`} onClick={() => { setForm({ action: 'rename', from: e.slug, to: '' }); setPreview(null); }} style={btn}>改名</button>
                        <button type="button" disabled={busy} title="合并到另一个 Room(dryRun 预览→确认实跑)" onClick={() => { setForm({ action: 'merge', from: e.slug, to: '' }); setPreview(null); }} style={btn}>合并</button>
                        <button type="button" disabled={busy} title={retired ? '恢复该 Room 到词表' : '退役该 Room(存量 tags 不动)'} onClick={() => retire(e.slug, retired)} style={{ ...btn, ...(retired ? { color: 'var(--dsh-mem-accent)', borderColor: 'var(--dsh-mem-accent)' } : { color: 'var(--dsh-mem-danger)', borderColor: 'var(--dsh-mem-danger)' }) }}>{retired ? '恢复' : '退役'}</button>
                      </>
                    )}
                    <button type="button" disabled={busy} title="导出该 Room 的记录清单 CSV" onClick={() => exportRecords(e.slug)} style={btn}>导出</button>
                  </div>
                  {/* 行内合并/改名表单 + dryRun 预览 */}
                  {form && form.from === e.slug ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                      <span style={S.muted}>{form.action === 'merge' ? '合并' : '改名'} {form.from} →</span>
                      <input
                        value={form.to}
                        onChange={(ev) => setForm({ ...form, to: ev.target.value })}
                        placeholder="目标 slug"
                        disabled={busy}
                        style={{ ...S.input, width: 180, fontSize: 12 }}
                      />
                      <button type="button" disabled={busy} onClick={previewMerge} style={{ ...btn, color: 'var(--dsh-mem-accent)', borderColor: 'var(--dsh-mem-accent)' }}>预览</button>
                      <button type="button" disabled={busy} onClick={() => { setForm(null); setPreview(null); }} style={btn}>取消</button>
                      <span style={S.muted}>合并/改名与反刍并发会互相覆盖,请在反刍空闲时执行。</span>
                    </div>
                  ) : null}
                  {preview && (form ? form.from === e.slug : false) ? (
                    <div style={{ marginTop: 4, padding: '6px 8px', border: '1px solid var(--dsh-mem-accent)', borderRadius: 6, fontSize: 12 }}>
                      <div>{preview.notice}</div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        <button type="button" disabled={busy} onClick={execMerge} style={{ ...btn, color: 'var(--dsh-mem-danger)', borderColor: 'var(--dsh-mem-danger)' }}>确认执行{preview.action === 'merge' ? '合并' : '改名'}</button>
                        <button type="button" disabled={busy} onClick={() => setPreview(null)} style={btn}>再改改</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))
      )}

      {/* 未注册自生长区 */}
      {grownOnly.length > 0 ? (
        <div style={{ marginTop: 4 }}>
          <button type="button" onClick={() => setGrownOpen(!grownOpen)} style={btn} title={grownOpen ? '收起未注册自生长 Room' : '展开未注册自生长 Room'}>
            {grownOpen ? '▾' : '▸'} 自生长未注册 · 共 {grownOnly.length}
          </button>
          <span style={S.muted}>{'(只在 tags 里涌现,不在词表 —— 收编后标注器才会优先挂靠)'}</span>
          {grownOpen ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 6 }}>
              {grownOnly.map((r) => (
                <span key={r.room} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ ...btn, cursor: 'default', borderRadius: 999, padding: '2px 8px' }} title="自生长 slug(未注册)">
                    {r.room + ' · ' + r.count}
                  </span>
                  <button type="button" disabled={!hiPriv || busy} title="收编进注册表(source=grown)" onClick={() => adopt(r.room)} style={{ ...btn, color: 'var(--dsh-mem-accent)', borderColor: 'var(--dsh-mem-accent)', opacity: !hiPriv || busy ? 0.5 : 1 }}>收编</button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
