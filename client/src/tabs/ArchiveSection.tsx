/**
 * 外部存档节（N8）：把 md 投射的三个动作从"只能手调 RPC"变成面板上有手。
 *
 * 为什么在 RecordsTab 底部而不是新开一个 tab：新 tab 要碰家族节契约与 tab 标题，
 * 而这一节的体量只有三枚按钮 + 一行状态，塞进「记忆」页正好和已经住在这里的
 * 「导出孤儿」连续。
 *
 * 三条纪律：
 * - **不弹框、不抢焦点、不自动轮询**：只响应点击，结果就地写在按钮下方；
 * - **一次只跑一批**：后端是有界的（`maxRecords`/`timeBudgetMs`），`remaining > 0`
 *   时明说"再点一次继续"，绝不让一次点击挂死 UI；
 * - **不拿空数据骗人**：功能没开时后端返回的是"未开启（cfg.memExport.enabled）"
 *   这句话，我们把它原样显示出来——比悄悄藏起整节更好回答"我点了怎么没反应"。
 */
import { tr } from '../i18n.js';
import { useEffect, useState } from 'react';
import { NButton, NInput } from '../ui/primitives.js';
import { S } from '../styles.js';
import type { RpcFn } from '../rpc.js';
import type { DshMemoryRequestMap, DshMemoryResponseMap } from '../../../src/contract.js';

/** 本节会发的六个端点（导出 / 对账 / 同步 / 孤儿归档 / 清理预览 / 真清理）。 */
type ArchiveEndpoint =
  | 'dsh-memory/mem-export'
  | 'dsh-memory/mem-reconcile'
  | 'dsh-memory/mem-sync'
  | 'dsh-memory/mem-orphans'
  | 'dsh-memory/cleanup-retired';
type ExportReport = DshMemoryResponseMap['dsh-memory/mem-export'];
type RunStatus = DshMemoryResponseMap['dsh-memory/mem-run-status'];
type ReconcileReport = DshMemoryResponseMap['dsh-memory/mem-reconcile'];
type SyncReport = DshMemoryResponseMap['dsh-memory/mem-sync'];
type OrphanReport = DshMemoryResponseMap['dsh-memory/mem-orphans'];
type CleanupReport = DshMemoryResponseMap['dsh-memory/cleanup-retired'];

const HINT_STYLE = { fontSize: 12, color: 'var(--dsh-mem-text-3)', lineHeight: '18px' } as const;
const ROOT_STYLE = { fontSize: 11, color: 'var(--dsh-mem-text-3)', wordBreak: 'break-all' } as const;

/** 把一次 RPC 的返回拆成 `{report, error}`，envelope 的两种形状都在此收口。 */
async function call<K extends ArchiveEndpoint>(
  rpc: RpcFn,
  method: K,
  payload: DshMemoryRequestMap[K],
): Promise<{ report?: DshMemoryResponseMap[K]; error?: string }> {
  try {
    const r = await rpc(method, payload);
    if (r && r.ok && r.value !== undefined) return { report: r.value };
    const msg = r && !r.ok ? r.error?.message : undefined;
    return { error: typeof msg === 'string' && msg.length > 0 ? msg : tr("端点无响应") };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function lineOf(rep: ExportReport): string {
  const head = tr("已写 {p1} · 未变 {p2} · 跳过 {p3}", { p1: rep.written, p2: rep.unchanged, p3: rep.skipped });
  // 起名回填是这一步顺带做的写库动作（只写 name 列），得让人看得见它动了几条。
  const named = rep.named > 0 ? tr("· 新起名 {p1} 条", { p1: rep.named }) : '';
  const nameBad = rep.nameFailed > 0 ? tr("· 起名失败 {p1} 条(下轮重试)", { p1: rep.nameFailed }) : '';
  // 后缀收敛：退场记录的文件该带 `.disable`、恢复的该掉后缀，这一步对齐了几条要说得出。
  // `rep.suffix` 是后加的字段：客户端 bundle 可能比服务端旧（浏览器缓存），所以先判在。
  const s = rep.suffix;
  const suffix = s && s.renamed + s.revived + s.both + s.edited > 0
    ? tr("· 后缀对齐 改名 {p1}{p2} 改回 {p3}{p4}", { p1: s.renamed, p2: s.edited > 0 ? tr("(人改过 {p1})", { p1: s.edited }) : '', p3: s.revived, p4: s.both > 0 ? tr(" · 冲突 {p1}", { p1: s.both }) : '' })
    : '';
  const suffixMore = s && s.capped && s.remaining > 0 ? tr("· 后缀还有 {p1} 个文件待对齐，再点一次继续", { p1: s.remaining }) : '';
  const tail = rep.remaining > 0 ? tr("· 剩余 {p1} 个文件，再点一次继续", { p1: rep.remaining }) : '';
  // 预算回显：报的是服务端**实际用了**的那个值，不是输入框里的草稿——否则“改了但
  // 没生效”与“改了且生效”在面板上长得一样。
  const budget = typeof rep.appliedMaxRecords === 'number' && rep.appliedMaxRecords > 0 ? tr("· 本次预算 {p1} 个文件", { p1: rep.appliedMaxRecords }) : '';
  // 滚了几轮要说出来：否则“写 912”会让人以为一次只能做 912，而不是“一次点完做了 912”。
  const passes = typeof rep.passes === 'number' && rep.passes > 1 ? tr("· 共滚 {p1} 轮", { p1: rep.passes }) : '';
  return head + named + nameBad + suffix + suffixMore + budget + passes + tail;
}

function lineOfReconcile(rep: ReconcileReport): string {
  const parts = [
    tr("首次 {p1}", { p1: rep.firstTime }),
    tr("一致 {p1}", { p1: rep.same }),
    tr("仅库变 {p1}", { p1: rep.dbOnly }),
    tr("仅文件变 {p1}", { p1: rep.fileOnly }),
    tr("两边都变 {p1}", { p1: rep.both }),
    tr("文件缺失 {p1}", { p1: rep.missingFile }),
  ];
  return parts.join(' · ') + (rep.capped ? tr("（本次只扫了 {p1} 条，未扫全）", { p1: rep.scanned }) : '');
}

function lineOfSync(rep: SyncReport): string {
  const head = tr("回灌 {p1} · 重写文件 {p2} · 退场 {p3} · 一致 {p4}", { p1: rep.imported, p2: rep.rendered, p3: rep.retired, p4: rep.same });
  const tail = rep.pending > 0 ? tr("· 两边都变 {p1} 条已挂账（两侧都没动）", { p1: rep.pending }) : '';
  const extra = rep.newFiles > 0 ? tr("· 新文件 {p1} 个未入库（导入须走写入内核）", { p1: rep.newFiles }) : '';
  // 遍历防护拦下的条目必须说出来：它们落在投射根以外（链接/越界目录），不说就等于静默丢弃，
  // 而“报告说一致”与“实际根本没看那批目录”在人眼里长得一样。
  const links = rep.skippedLinks > 0 ? tr("· 防护拦下 {p1} 个链接/越界条目（未读）", { p1: rep.skippedLinks }) : '';
  // 陈旧根那份既没回灌也没被写，不说出去就会被当成“已经同步过了”：它实际在等孤儿归档。
  const stale = rep.staleRootFiles > 0 ? tr("· 陈旧根 {p1} 个文件未参与同步（交给孤儿归档）", { p1: rep.staleRootFiles }) : '';
  // 同记录多路径且两份都被改：机器不替人挑，但必须说出来——不说就会被当成“同步过了”。
  const multi = rep.multiPath > 0 ? tr("· 同记录多路径 {p1} 份未动（先跑孤儿归档再同步）", { p1: rep.multiPath }) : '';
  // 自校验（N13）：声明 hash 与正文不符 = 文件被外部改动/损坏；老文件没带 hash = 无自校验能力。
  // 两者都不阻断同步，但必须说出来——不说就把“文件已不自洽”伪装成“一切正常”。
  const hashBad = rep.hashMismatch > 0 ? tr("· 自校验不符 {p1} 个（文件被外部改动，已按文件侧处理）", { p1: rep.hashMismatch }) : '';
  const unsigned = rep.unsigned > 0 ? tr("· 未签名 {p1} 个（老投射文件无 hash，下轮导出补盖）", { p1: rep.unsigned }) : '';
  return head + tail + extra + links + stale + multi + hashBad + unsigned + (rep.remaining > 0 ? tr("· 剩余 {p1} 个文件，再点一次继续", { p1: rep.remaining }) : '');
}

function lineOfOrphans(rep: OrphanReport): string {
  const head = rep.dryRun
    ? tr("账本共 {p1} 条 · 仍被认领 {p2} · 无人认领 {p3}（未搬任何东西）", { p1: rep.scanned, p2: rep.claimed, p3: rep.orphans })
    : tr("已搬 {p1} · 失败 {p2} · 仍被认领 {p3}", { p1: rep.moved, p2: rep.failed, p3: rep.claimed });
  const tail = rep.remaining > 0 ? tr("· 剩余 {p1} 条，再点一次继续", { p1: rep.remaining }) : '';
  return head + tail + (rep.dir.length > 0 ? tr("· 归档到 {p1}", { p1: rep.dir }) : '');
}

function lineOfCleanup(rep: CleanupReport): string {
  if (rep.aborted) return tr("清理已中止（未删任何记录）：{p1}", { p1: rep.diffs.join('；') || tr('门禁未通过') });
  if (rep.dryRun) return tr("待删 {p1} 条（预览了前 {p2} 条）——未删除任何东西", { p1: rep.targets, p2: rep.items?.length ?? 0 });
  const f = rep.files ?? { moved: 0, failed: 0, absent: 0 };
  const head = tr("已删 {p1} 条 · 归档正文 {p2} · 文件搬家 {p3}(失败 {p4}) · 图索引 {p5}", { p1: rep.purged, p2: rep.archiveMd === undefined || rep.archiveMd === '' ? tr('未写') : tr('已写'), p3: f.moved, p4: f.failed, p5: rep.graphForgotten ?? 0 });
  return rep.otherChanged && rep.otherChanged > 0 ? tr("{p1} · 本批之外 {p2} 条处于漂移（不影响本批）", { p1: head, p2: rep.otherChanged }) : head;
}

/** 「外部存档」一节。 */
export function ArchiveSection(props: { rpc: RpcFn }) {
  const rpc = props.rpc;
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<ExportReport | undefined>(undefined);
  const [recon, setRecon] = useState<ReconcileReport | undefined>(undefined);
  const [synced, setSynced] = useState<SyncReport | undefined>(undefined);
  const [orphans, setOrphans] = useState<OrphanReport | undefined>(undefined);
  const [cleanup, setCleanup] = useState<CleanupReport | undefined>(undefined);
  // 物理删除不可逆，而本节已有“不弹框”纪律 ⇒ 用两步 arming 当确认门槛：
  // 必须先跑一次预览（否则连要删什么都不知道），再点两次才真删。
  // 归档文件也是不可逆感动作：同样用两步 arming，且必须先看过预览。
  const [orphanArmed, setOrphanArmed] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /**
   * 单次文件更新预算（`live.mdExportMaxRecords`，0 = 跟随部署默认 2000）。
   *
   * 为什么放在本节而不是总开关区：它只在“回填历史 / 一次点完”时用得上，
   * 而那个动作就发生在这排按钮上。住在启动 YAML 里时调一次要改文件 + 重启，
   * 一个临时旋钮不该有那个代价。
   */
  const [budgetDraft, setBudgetDraft] = useState('');
  const [budgetNote, setBudgetNote] = useState('');
  /**
   * 投影长任务的进度快照（导出现在自己滚到完，一次点击可达十几秒）。
   *
   * 为什么需要：没有进度面时人只能靠“再点一下”猜任务还在不在跑（真机反馈就
   * 是“点三下、每次一秒多”）。服务端同一时刻只跑一个投影任务，所以这里只需一份快照。
   */
  const [prog, setProg] = useState<RunStatus | undefined>(undefined);

  /** 读一次进度（点完后再补一次，拿终态的 detail/notice）。 */
  const pullProgress = (): void => {
    void rpc('dsh-memory/mem-run-status', {})
      .then((r) => { const v = r && r.ok ? r.value : undefined; if (v !== undefined) setProg(v); })
      .catch(() => {});
  };

  /** 导出：点击期间轮询进度，回包后停轮并拉一次终态。 */
  const runExport = (): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const timer = setInterval(pullProgress, 500);
    pullProgress();
    void call(rpc, 'dsh-memory/mem-export', {}).then((out) => {
      clearInterval(timer);
      setBusy(false);
      if (out.report !== undefined) { setExported(out.report); pullProgress(); }
      if (out.error !== undefined) setError(out.error);
    });
  };
  useEffect(() => {
    void rpc('dsh-memory/settings-get', {})
      .then((r) => {
        const v = r && r.ok ? r.value : undefined;
        const n = v?.settings?.mdExportMaxRecords;
        if (typeof n === 'number') setBudgetDraft(String(n));
      })
      .catch(() => {});
  }, [rpc]);
  const commitBudget = (): void => {
    const raw = budgetDraft.trim();
    if (raw === '') return;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 0 || n > 10_000) {
      setBudgetNote(tr("预算要 0~10000 的整数（0 = 跟随部署默认）"));
      return;
    }
    void rpc('dsh-memory/settings-set', { mdExportMaxRecords: n })
      .then((r) => {
        setBudgetNote(r && r.ok
          ? (n === 0 ? tr("已改为跟随部署默认") : tr("已设为每次最多 {p1} 个文件，下一次点击生效", { p1: n }))
          : tr("写入失败：预算未改"));
      })
      .catch(() => { setBudgetNote(tr("写入失败：预算未改")); });
  };

  const run = <K extends ArchiveEndpoint>(
    method: K,
    sink: (rep: DshMemoryResponseMap[K]) => void,
    payload: DshMemoryRequestMap[K],
  ): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void call<K>(rpc, method, payload).then((out) => {
      if (out.report !== undefined) sink(out.report);
      if (out.error !== undefined) setError(out.error);
      setBusy(false);
    });
  };

  const root = exported?.root ?? recon?.root;
  // 两阶段各算一遍全表，所以分母是 total×2；上限钳住 100%（多轮累加不会超，但
  // 进度字段来自服务端，不假设它永远自洽）。
  const pct = prog !== undefined && prog.total > 0
    ? Math.min(100, Math.round((prog.done / (prog.total * 2)) * 100))
    : 0;
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--dsh-mem-border)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsh-mem-text-2)', marginBottom: 6 }}>
        {tr("外部存档（markdown 投射）")} </div>
      <div style={S.flexRow}>
        <NButton
          disabled={busy}
          title={tr("把当前全部记忆渲染为 <根>/<类型>/<名称>.memory.md，并记下内容指纹（只写文件，不改库）。一次点完：一轮预算不够时服务端自己续跑下几轮，进度看下方进度条")}
          onClick={runExport}
        >
          {tr("导出为可携存档")} </NButton>
        <NButton
          disabled={busy}
          title={tr("按账本基线比对库与磁盘，只出报告：什么都不写，因此不需要高权限")}
          onClick={() => { run('dsh-memory/mem-reconcile', setRecon, {}); }}
        >
          {tr("与存档对账")} </NButton>
        <NButton
          disabled={busy}
          title={tr("文件 → 库：只有文件变过的回灌入库，`.disable` 后缀的退场；两边都变的那些两侧都不动，只挂账。会写库，因此需要高权限模式")}
          onClick={() => { run('dsh-memory/mem-sync', setSynced, {}); }}
        >
          {tr("从存档同步回库")} </NButton>
        <NButton
          disabled={busy}
          title={tr("只读预览：扫账本，找出“我们写过但现在没记录认领它”的投射文件（改名/消歧留下的残片）。来路不明的文件一律不动，也不搬任何东西")}
          onClick={() => {
            setOrphanArmed(false);
            run('dsh-memory/mem-orphans', setOrphans, { dryRun: true });
          }}
        >
          {tr("孤儿文件预览")} </NButton>
        <NButton
          disabled={busy || orphans === undefined || !orphans.dryRun || orphans.orphans === 0}
          title={orphanArmed
            ? tr("再点一次就真的搬——文件会被移出投射目录（不删，进归档目录，可手动搬回）")
            : tr("不删只搬：进 <数据目录>/memories-orphans/<批次时间戳>/；需要先跑预览，再点两次确认；服务端还要高权限模式")}
          onClick={() => {
            if (!orphanArmed) { setOrphanArmed(true); return; }
            setOrphanArmed(false);
            run('dsh-memory/mem-orphans', setOrphans, { dryRun: false });
          }}
        >
          {orphanArmed ? tr("确认搬走孤儿文件") : tr("孤儿文件归档")}
        </NButton>
        <NButton
          disabled={busy}
          title={tr("只读预览：列出将被物理删除的退场记忆（前 50 条）与总数，不删任何东西")}
          onClick={() => {
            setArmed(false);
            run('dsh-memory/cleanup-retired', setCleanup, { dryRun: true });
          }}
        >
          {tr("清理预览（干跑）")} </NButton>
        <NButton
          disabled={busy || cleanup === undefined || !cleanup.dryRun || cleanup.targets === 0}
          title={armed
            ? tr("再点一次就真的删——物理删除不可逆（但会先落快照与归档正文）")
            : tr("不可逆动作：需要先跑预览，再点两次确认；服务端那边还要高权限模式")}
          onClick={() => {
            if (!armed) { setArmed(true); return; }
            setArmed(false);
            run('dsh-memory/cleanup-retired', setCleanup, { dryRun: false });
          }}
        >
          {armed ? tr("确认物理删除") : tr("清理并归档")}
        </NButton>
      </div>
      {prog !== undefined && prog.total > 0 ? (
        <div style={{ marginTop: 8 }}>
          <div className="dsh-mem-rb-bar">
            <div className="dsh-mem-rb-fill" style={{ width: pct + '%' }} />
          </div>
          <div style={{ ...HINT_STYLE, marginTop: 3 }}>
            {prog.detail}
            {prog.notice !== undefined && prog.notice !== '' ? ` · ${prog.notice}` : ''}
          </div>
        </div>
      ) : null}
      <div style={{ ...S.flexRow, marginTop: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>{tr("单次文件更新预算")}</span>
        <NInput
          type="number"
          min={0}
          max={10000}
          style={{ width: 96 }}
          title={tr("一次点击最多更新多少个投射文件（导出写入 + 后缀改名都占额度）。“没变过”的不占额度。0 = 跟随部署默认（2000）；上限 10000。")}
          placeholder="0"
          value={budgetDraft}
          onChange={(e: { target: { value: string } }) => {
            setBudgetDraft(e.target.value);
            setBudgetNote('');
          }}
          onBlur={() => { commitBudget(); }}
          onKeyDown={(e: { key: string }) => { if (e.key === 'Enter') commitBudget(); }}
        />
        <span style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>{tr("个文件/次（0 = 默认 2000）")}</span>
        {budgetNote !== '' ? <span style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>{budgetNote}</span> : null}
      </div>
      <div style={{ ...HINT_STYLE, marginTop: 6 }}>
        {error !== undefined
          ? tr("失败：{p1}", { p1: error })
          : cleanup !== undefined
            ? lineOfCleanup(cleanup)
            : orphans !== undefined
              ? lineOfOrphans(orphans)
              : synced !== undefined
                ? lineOfSync(synced)
                : exported !== undefined
                  ? lineOf(exported)
                  : recon !== undefined
                    ? lineOfReconcile(recon)
                    : tr("导出=库→文件；对账=只读比较；同步=文件→库；孤儿=搬走没人认领的残片；清理=物理删除（不可逆，需高权限模式）。")}
      </div>
      {recon !== undefined && error === undefined ? (
        <div style={HINT_STYLE}>{tr("最近差异样本：")}{recon.samples.map((s) => `${s.state}:${s.relPath}`).join('，') || tr("（无）")}</div>
      ) : null}
      {root !== undefined ? <div style={ROOT_STYLE}>{tr("投射根：")}{root}</div> : null}
    </div>
  );
}
