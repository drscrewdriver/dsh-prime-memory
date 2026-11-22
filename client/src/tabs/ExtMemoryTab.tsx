/**
 * Tab：外部记忆驱动（计划 ext-mem-drivers-sync T0.8，Phase 0 只读骨架）。
 *
 * 与「来源」（ConnectTab）的分工：那一面登记的是**文件路径指针**（memport 只读扫描）；
 * 这一面是**活服务驱动**（Mem0/Hindsight 等 9 类）的配置镜像与同步账本视图。
 *
 * Phase 0 边界：驱动装配/真实探活/同步引擎在 Phase 1+，本面只做三件事——
 * 列注册态、显式回显「探活是镜像不是真探」、展示影子账/出站队列计数。
 * 总闸关（默认）时只出一条「已关闭」说明卡；服务端保证零外呼。
 */
import { tr } from '../i18n.js';
import { useCallback, useEffect, useState } from 'react';
import type { ExtDriversResponse, ExtSyncStatusResponse } from '../../../src/contract.js';
import type { RpcFn } from '../rpc.js';
import { S } from '../styles.js';
import { NButton } from '../ui/primitives.js';
import { NInput, NModal } from '../ui/primitives.js';
import { editAffordance, fieldPlaceholder, gateOffWarning, gateResultText, gateStateText, importAffordance, importResultText, importWarningText, isolateOffWarning, removeStep, removeWarningText, resumePoint, savedText, syncGateNotice } from './ext-driver-ui.js';

/** 导入默认上限（面板不填时服务端也用同一护栏；与部署 pull.maxItems 对齐）。 */
const IMPORT_DEFAULT_MAX = 2000;

/** `ext-import-status` 响应体（面板只用这些字段）。 */
interface ImportStatus {
  running: boolean;
  driverId: string;
  spaceId: string;
  offset: number;
  imported: number;
  skipped: number;
  startedAt: number;
  cancelRequested: boolean;
  error?: string;
  last?: { imported: number; skipped: number; truncation: string; l1TotalBefore: number; l1TotalAfter: number; conflicts?: number; failed?: number };
}

/** 表单字段标题(placeholder 另由 fieldPlaceholder 给,"留空代表什么"必须贴在框上)。 */
const FIELD_LABELS: Record<'id' | 'endpoint' | 'apiKey' | 'space' | 'extra', string> = {
  id: 'id（小写字母/数字起头，可含 . _ -，≤32）',
  endpoint: 'endpoint（http(s):// 或绝对路径，必填）',
  apiKey: 'apiKey',
  space: 'space（namespace）',
  extra: 'extra（JSON 对象）',
};

/** 9 家驱动类型(与 src/ext-memory/types.ts 的 EXT_DRIVER_TYPES 同集;client 不 import 服务端类型以免把打包面拉开。改动时两处同步)。 */
const DRIVER_TYPES = ['mem0', 'hindsight', 'openviking', 'honcho', 'retaindb', 'supermemory', 'holographic', 'byterover', 'mnemon-native'] as const;

interface DriverDraft {
  mode: 'create' | 'edit';
  id: string;
  type: string;
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  space: string;
  extra: string;
}

function errMsg(r: { ok?: boolean; error?: { message?: string } } | undefined): string {
  return r && r.error && r.error.message ? r.error.message : tr("RPC 错误");
}

const SHADOW_STATE_LABELS: Record<string, string> = {
  clean: '已同步',
  local_dirty: '本地待推',
  remote_dirty: '远端待拉',
  both_dirty: '双边变更待裁',
  awaiting_settle: '回捞中',
  orphan: '回捞超时',
  linked_remote_missing: '远端缺失',
  unforgettable: '远端不可删',
  dead: '重试耗尽',
};

/** 冲突三族的展示名(与后端 EXT_CONFLICT_KINDS 同集)。 */
const CONFLICT_KIND_LABELS: Record<string, string> = {
  both_dirty: '两边都变',
  orphan: '远端寻不到',
  unforgettable: '遗忘不复发',
};

/** ext-conflicts-list 的响应形状(此处本地声明,不把面板耦合进后端契约文件)。 */
interface ConflictsView {
  enabled: boolean;
  open: number;
  byKind: Record<string, number>;
  items: Array<{
    conflictId: string;
    driverId: string;
    recordId: string;
    externalId: string;
    kind: string;
    status: string;
    resolution: string;
    localPreview: string;
    remotePreview: string;
  }>;
  notice?: string;
}

export function ExtMemoryTab(props: { rpc: RpcFn }) {
  const rpc = props.rpc;
  const [drivers, setDrivers] = useState<ExtDriversResponse | null>(null);
  const [sync, setSync] = useState<ExtSyncStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probeMsg, setProbeMsg] = useState('');
  const [conflicts, setConflicts] = useState<ConflictsView | null>(null);
  /** 运行时开关(settings-get/set):热生效,不重建装配。 */
  const [liveSet, setLiveSet] = useState<{ supported: boolean; syncMode: '' | 'shadow-read' | 'push-only' | 'two-way'; push: boolean; pull: boolean; hard: boolean; isolate: boolean } | null>(null);
  /** 驱动配置写面是否可用(ext-config-arm 探测):宿主不供 settings.forms = 置灰。
   *  这里故意不掺 memoryMutate:那条门的定义对象是模型写删记忆工具,与配置面无关。 */
  const [armInfo, setArmInfo] = useState<{ armed: boolean; reason?: string } | null>(null);
  const [draft, setDraft] = useState<DriverDraft | null>(null);
  const [writeMsg, setWriteMsg] = useState('');
  /** 待确认删除的驱动 id(两段式:第一下只弹警告,第二下才真写)。 */
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  /** 待确认关闭总闸(同为两段式:关掉会停下驱动与第 5 路,不该一下生效)。 */
  const [pendingGateOff, setPendingGateOff] = useState(false);
  /** 导入面可用性（scope:'import' 探的票）：与配置写面分票，否则老臂上导入白白置灰。 */
  const [importArm, setImportArm] = useState<{ armed: boolean; reason?: string } | null>(null);
  /** 导入两段式：第一下只报量级与成本，第二下真受理。 */
  const [pendingImport, setPendingImport] = useState<string | null>(null);
  /** 导入任务进度（轮询 ext-import-status）。 */
  const [importProg, setImportProg] = useState<ImportStatus | null>(null);
  /** 待确认关闭隔离闸（两段式：关掉会让外源条目挤进取数窗口，不该一拨就生效）。 */
  const [pendingIsolateOff, setPendingIsolateOff] = useState(false);
  /** 本次导入是否清断点重来（默认续跑：嵌入是最贵的一项）。 */
  const [restartImport, setRestartImport] = useState(false);

  const load = useCallback(() => {
    rpc('dsh-memory/ext-drivers-list', {})
      .then((r) => {
        if (r && r.ok) {
          setDrivers(r.value);
          setError(null);
        } else setError(errMsg(r));
      })
      .catch((e: unknown) => setError(String((e as Error)?.message || e)));
    rpc('dsh-memory/ext-sync-status', {})
      .then((r) => {
        if (r && r.ok) setSync(r.value);
      })
      .catch(() => {
        /* 计数卡缺席不顶掉主错误位 */
      });
    rpc('dsh-memory/ext-conflicts-list', { status: 'open', limit: 50 })
      .then((r) => {
        if (r && r.ok) setConflicts(r.value as ConflictsView);
      })
      .catch(() => {
        /* 冲突面缺席不顶掉主错误位 */
      });
    rpc('dsh-memory/settings-get', {})
      .then((r) => {
        if (!(r && r.ok)) return;
        const v = r.value;
        const s = v.settings;
        const mode = s?.extSyncMode;
        setLiveSet({
          supported: v.supported === true,
          syncMode: mode === 'shadow-read' || mode === 'push-only' || mode === 'two-way' ? mode : '',
          push: s?.extPushEnabled === true,
          pull: s?.extPullEnabled === true,
          hard: s?.extAllowHardDelete === true,
          // 隔离闸默认开：服务端回显缺值时当“开”，不能当“关”（否则面板会显示成未隔离）。
          isolate: s?.extImportIsolate !== false,
        });
      })
      .catch(() => {
        /* 开关面缺席:外部记忆仍可用,只是面板不展示热开关 */
      });
    // 写面可用性探测:每次刷新都重新问(宿主能力/配置层可能刚变)。
    // 不在本地缓存结论——缓存会让“写面已就绪但按钮还是灰”变成新的坑。
    rpc('dsh-memory/ext-config-arm', { issue: false })
      .then((r) => {
        if (r && r.ok) {
          // issue:false = 探而不发:不占 nonce 名额(上限 3 张,逐最早),
          // 真正的一次性令牌在保存那一刻才领,保证令牌与操作同命。
          setArmInfo({ armed: r.value.armed, reason: r.value.reason });
        }
      })
      .catch(() => setArmInfo({ armed: false, reason: tr("写面探测失败") }));
    // 导入面探票：scope:'import' 不要求 configWritable，所以“不能写 profile 的宿主”仍应能导入。
    rpc('dsh-memory/ext-config-arm', { issue: false, scope: 'import' })
      .then((r) => {
        if (r && r.ok) setImportArm({ armed: r.value.armed, reason: r.value.reason });
      })
      .catch(() => setImportArm({ armed: false, reason: tr("导入面探测失败") }));
    // 导入进度：只在有任务时轮询会简单些，但“上一轮结果”必须刷新就能看到（事后凭证）。
    rpc('dsh-memory/ext-import-status', {})
      .then((r) => {
        if (r && r.ok) setImportProg(r.value as ImportStatus);
      })
      .catch(() => {
        /* 导入面缺席（旧版或未装配）：不顶掉主错误位 */
      });
  }, [rpc]);

  useEffect(() => {
    load();
  }, [load]);

  const probe = (driverId: string) => {
    setProbeMsg('');
    rpc('dsh-memory/ext-driver-probe', { driverId })
      .then((r) => {
        if (r && r.ok) {
          const v = r.value as { healthy?: boolean; notice?: string };
          setProbeMsg(`${driverId}: ${v.notice ?? (v.healthy ? tr("健康") : tr("不健康"))}`);
        } else setProbeMsg(`${driverId}: ${errMsg(r)}`);
      })
      .catch((e: unknown) => setProbeMsg(`${driverId}: ${String((e as Error)?.message || e)}`));
  };

  /**
   * 驱动配置保存(计划 ext-driver-config-ui):先取一次性 nonce 再写。
   * nonce 与操作同命(不用刷新的探测值),失败把服务端原因直接呈出来 ——
   * 配置写入不静默:“看起来保存了”但 profile 没变是最坑的失败。
   */
  const saveDraft = () => {
    if (draft === null) return;
    setWriteMsg('');
    rpc('dsh-memory/ext-config-arm', {})
      .then(async (r) => {
        if (!(r && r.ok)) {
          setWriteMsg(errMsg(r));
          return;
        }
        const a = r.value;
        if (a.armed !== true || a.nonce === undefined) {
          setWriteMsg(a.reason ?? tr("写面未就绪"));
          return;
        }
        const body = {
          nonce: a.nonce,
          id: draft.id.trim(),
          type: draft.type,
          enabled: draft.enabled,
          endpoint: draft.endpoint.trim(),
          apiKey: draft.apiKey.trim(),
          space: draft.space.trim(),
          extra: draft.extra.trim(),
        };
        const w = await rpc('dsh-memory/ext-driver-upsert', body);
        if (!(w && w.ok)) {
          setWriteMsg(errMsg(w));
          return;
        }
        const v = w.value;
        setWriteMsg(savedText(body.id, v.created, v.needsReload, { shadows: v.shadows, outboxPending: v.outboxPending }, v.notice));
        setDraft(null);
        load();
      })
      .catch((e: unknown) => setWriteMsg(String((e as Error)?.message || e)));
  };

  /** 删除驱动:同样走 nonce;服务端返回 shadows 供确认“远端仍在”。 */
  const removeDriver = (id: string) => {
    setWriteMsg('');
    setPendingRemove(null);
    rpc('dsh-memory/ext-config-arm', {})
      .then(async (r) => {
        if (!(r && r.ok)) {
          setWriteMsg(errMsg(r));
          return;
        }
        const a = r.value;
        if (a.armed !== true || a.nonce === undefined) {
          setWriteMsg(a.reason ?? tr("写面未就绪"));
          return;
        }
        const w = await rpc('dsh-memory/ext-driver-remove', { nonce: a.nonce, id });
        if (!(w && w.ok)) {
          setWriteMsg(errMsg(w));
          return;
        }
        const v = w.value;
        // v.notice 非空 = 读回与提交不一致(典型为数组深合并残留),它比"移除成功"更要紧。
        setWriteMsg(
          (v.notice ? '⚠ ' + v.notice + ' ' : '') +
            (v.removed
              ? tr("已从 profile 移除") + id + tr("，重载后不再装配") + (v.shadows > 0 ? '（' + v.shadows + tr("条影子账保留，远端数据不会因此删除）") : '')
              : tr("配置里没有这个驱动：") + id),
        );
        load();
      })
      .catch((e: unknown) => setWriteMsg(String((e as Error)?.message || e)));
  };

  const shadowRows = sync
    ? Object.entries(sync.shadow).filter(([, n]) => n > 0)
    : [];
  /** 影子账总数：关闭隔离闸的警告要用它说清“关掉会把多少条放进取数窗口”。 */
  const shadowsTotal = shadowRows.reduce((sum, [, n]) => sum + n, 0);

  /**
   * 总闸开关(写入 profile,重载后装配采纳)。与驱动 CRUD 同一道门:领票→写→读回。
   * 为什么需要它:总闸不在 live 键集(热开不会造出驱动实例,加了也只是个假开关),
   * 以前它没有任何面板入口——用户只能改 YAML,而本面的同步开关却在关闭态可拨。
   */
  const toggleGate = (want: boolean) => {
    setWriteMsg('');
    setPendingGateOff(false);
    rpc('dsh-memory/ext-config-arm', {})
      .then(async (r) => {
        if (!(r && r.ok)) {
          setWriteMsg(errMsg(r));
          return;
        }
        const a = r.value;
        if (a.armed !== true || a.nonce === undefined) {
          setWriteMsg(a.reason ?? tr("写面未就绪"));
          return;
        }
        const w = await rpc('dsh-memory/ext-config-enable', { nonce: a.nonce, enabled: want });
        if (!(w && w.ok)) {
          setWriteMsg(errMsg(w));
          return;
        }
        setWriteMsg(gateResultText(want, w.value.notice));
        load();
      })
      .catch((e: unknown) => setWriteMsg(String((e as Error)?.message || e)));
  };

  // 写面可点性判据集(不可点必须带原因,否则像插件坏了)。真机只需验渲染接线,
  // 规则本身已抽到 ext-driver-ui.ts 并由普通单测钉住。
  const affordance = editAffordance(armInfo);
  // 总闸生效态以装配真相为准(drivers.enabled);列表未回前不置灰,免得当开闪现可拨。
  const gate = syncGateNotice(drivers === null ? true : drivers.enabled);
  const importable = importAffordance(importArm, null);

  /**
   * 启动导入（两段式的第二下才会调到这里）。
   * 领票与提交同命：不用刷新时的探测票，否则“点了才过期”会变成莫名失败。
   */
  const startImport = (driverId: string) => {
    setWriteMsg('');
    setPendingImport(null);
    rpc('dsh-memory/ext-config-arm', { scope: 'import' })
      .then(async (r) => {
        if (!(r && r.ok)) {
          setWriteMsg(errMsg(r));
          return;
        }
        const a = r.value;
        if (a.armed !== true || a.nonce === undefined) {
          setWriteMsg(a.reason ?? tr("导入面未就绪"));
          return;
        }
        const w = await rpc('dsh-memory/ext-import-start', { nonce: a.nonce, driverId, ...(restartImport ? { restart: true } : {}) });
        setRestartImport(false);
        if (!(w && w.ok)) {
          setWriteMsg(errMsg(w));
          return;
        }
        setWriteMsg(tr("导入任务已受理，进度在本页下方刷新（可中断，断点保留）。"));
        load();
      })
      .catch((e: unknown) => setWriteMsg(String((e as Error)?.message || e)));
  };

  const cancelImport = () => {
    rpc('dsh-memory/ext-import-cancel', {})
      .then((r) => {
        if (!(r && r.ok)) setError(errMsg(r));
        load();
      })
      .catch((e: unknown) => setError(String((e as Error)?.message || e)));
  };

  /** 裁决/忽略:人看过就是结案,刷新后从列表消失(同键再次冲突会重新挂账)。 */
  const resolveConflict = (conflictId: string, action: 'resolve' | 'dismiss') => {
    rpc('dsh-memory/ext-conflict-resolve', { conflictId, action })
      .then((r) => {
        if (r && r.ok) load();
        else setError(errMsg(r));
      })
      .catch((e: unknown) => setError(String((e as Error)?.message || e)));
  };

  /** 运行时开关写入:热生效(pusher/puller 每轮读 live);失败重新拉一次对齐。 */
  const setExt = (patch: {
    extSyncMode?: '' | 'shadow-read' | 'push-only' | 'two-way';
    extPushEnabled?: boolean;
    extPullEnabled?: boolean;
    extAllowHardDelete?: boolean;
    extImportIsolate?: boolean;
  }) => {
    rpc('dsh-memory/settings-set', patch)
      .then((r) => {
        if (!(r && r.ok)) setError(errMsg(r));
        load();
      })
      .catch((e: unknown) => setError(String((e as Error)?.message || e)));
  };

  return (
    <div>
      <p style={S.intro}>
        {tr("外部记忆服务驱动（Mem0 / Hindsight / OpenViking / Honcho / RetainDB / Supermemory / Holographic / ByteRover / Mnemon Native）。 总闸与驱动接入均在本面（写入 profile，")}<strong>{tr("重载后装配生效")}</strong>）；<strong>{tr("驱动配置仅面板可改，会话/模型无此能力")}</strong>{tr("； 总闸开着时，同步档位与推/拉热闸不需重载即生效。 与「来源」页的外部记忆文件导入（Connect / memport）是两个子系统，互不相干。")} </p>
      {/* 遍历面的限制必须写在入口处：不然“导入到本地库”对没有遍历端点的家就是个灰按钮，
          用户以为插件坏了。而导入本身不是重载级动作，也不该让人白等重启。 */}
      <p style={S.detail}>
        {tr("「导入到本地库」是")}<strong>{tr("运行期动作，不需重载")}</strong>{tr("：把远端已有条目搬进本地 L1 检索库（逐条向量化，可中断、断点保留）。 它只能走各家的")}<strong>{tr("遍历端点")}</strong>{tr("，所以并非家家能导——ByteRover 只提供按查询词检索，无遍历面，导入对它不可用； Mnemon Native 遍历无 offset 语义，只有单页上限。HTTP 家的远端分页各不相同，导入的“取完了/达上限”按实际收尾如实报告。")} </p>

      {error ? <div style={S.hint}>{'⚠ ' + error}</div> : null}

      {liveSet !== null ? (
        <div className="dsh-mem-card" style={S.card}>
          <div style={S.cardHead}>
            <strong>{tr("同步开关（运行时）")}</strong>
            <span style={S.muted}>
              {gate.blocked
                ? tr("总闸未开：本区暂不可用")
                : liveSet.supported
                  ? tr("热生效 · 部署配置作安装面默认")
                  : tr("当前宿主不支持运行时写入（仅部署配置生效）")}
            </span>
            <div style={S.grow} />
            <NButton
              disabled={!affordance.enabled}
              title={affordance.enabled ? '' : affordance.why}
              onClick={() => {
                if (!pendingGateOff) {
                  setPendingGateOff(true);
                  return;
                }
                toggleGate(false);
              }}
            >
              {pendingGateOff ? tr("再点一下确认停用") : tr("停用外部记忆")}
            </NButton>
          </div>
          {pendingGateOff ? (
            <div style={{ ...S.hint, marginTop: 4 }}>
              {gateOffWarning(
                drivers?.drivers.length ?? 0,
                sync === null ? 0 : Object.values(sync.shadow).reduce((a, b) => a + b, 0),
                sync?.outbox.pending ?? 0,
              )}
            </div>
          ) : null}
          <div style={{ ...S.flexRow, marginTop: 6, flexWrap: 'wrap' }}>
            {([['', tr("跟随部署")], ['shadow-read', tr("只读融合")], ['push-only', tr("只推送")], ['two-way', tr("双向")]] as const).map(([v, label]) => (
              <NButton
                key={v || 'inherit'}
                onClick={() =>
                  // 档位按钮**同时落闸**:只选档不落闸的话 pusher 仍看 push.enabled,
                  // “选了双向却不推”是最容易让人怀疑插件坏了的一种状态面。
                  v === ''
                    ? setExt({ extSyncMode: '' })
                    : setExt({ extSyncMode: v, extPushEnabled: v !== 'shadow-read', extPullEnabled: v === 'two-way' })
                }
                disabled={!liveSet.supported || gate.blocked}
              >
                {(liveSet.syncMode === v ? '● ' : '') + label}
              </NButton>
            ))}
            <NButton disabled={!liveSet.supported || gate.blocked} onClick={() => setExt({ extPushEnabled: !liveSet.push })}>
              {(liveSet.push ? '☑ ' : '☐ ') + tr("推送出站")}
            </NButton>
            <NButton disabled={!liveSet.supported || gate.blocked} onClick={() => setExt({ extPullEnabled: !liveSet.pull })}>
              {(liveSet.pull ? '☑ ' : '☐ ') + tr("拉取入站")}
            </NButton>
            <NButton disabled={!liveSet.supported || gate.blocked} onClick={() => setExt({ extAllowHardDelete: !liveSet.hard })}>
              {(liveSet.hard ? '⚠ ' : '☐ ') + tr("允许硬删远端")}
            </NButton>
            {/* 污染隔离闸：本面第一个默认开的开关（默认值在服务端，不是这里）。
                关掉是静默降质，所以必须两段式：先看后果，再确认。 */}
            <NButton
              disabled={!liveSet.supported}
              onClick={() => (liveSet.isolate ? setPendingIsolateOff(true) : setExt({ extImportIsolate: true }))}
            >
              {(liveSet.isolate ? '☑ ' : '☐ ') + tr("外源条目不参与本地蒸馏")}
            </NButton>
          </div>
          <div style={{ ...S.detail, marginTop: 4 }}>
            {gate.blocked
              ? gate.why
              : tr("双向 = 推送 + 拉取；与 md 投射同开时门控会把双向降为只读融合。硬删会传导到不支持的远端且不可回滚。")}
          </div>
          {/* 关闭隔离闸的第二段：把“不报错的降质”说明白再让点。 */}
          {pendingIsolateOff && liveSet.isolate ? (
            <div style={{ ...S.hint, marginTop: 4 }}>
              {isolateOffWarning(shadowsTotal)}
              <NButton
                onClick={() => {
                  setPendingIsolateOff(false);
                  setExt({ extImportIsolate: false });
                }}
              >
                {tr("确认关闭隔离")} </NButton>
              <NButton onClick={() => setPendingIsolateOff(false)}>{tr("取消")}</NButton>
            </div>
          ) : null}
        </div>
      ) : null}

      {drivers && !drivers.enabled ? (
        <div className="dsh-mem-card" style={S.card}>
          {/* 标题按“配置意图”分流：已写开却还没装配 = 待重载，不能一律说“已关闭”。 */}
          <strong>{drivers.configuredEnabled === true ? tr("外部记忆待重载装配") : tr("外部记忆已关闭")}</strong>
          <div style={{ ...S.muted, marginTop: 4 }}>
            {drivers.notice ?? gateStateText(false, drivers.configuredEnabled)}
          </div>
          <div style={{ ...S.flexRow, marginTop: 8 }}>
            <NButton
              disabled={!affordance.enabled}
              title={affordance.enabled ? tr("将 ext_memory.enabled=true 写入 profile（重载后装配生效）") : affordance.why}
              onClick={() => toggleGate(true)}
            >
              {tr("开启外部记忆")} </NButton>
            <span style={S.muted}>
              {affordance.enabled
                ? tr("开启 = 写 profile + 重载；本插件无热重载通道，重载前上面那排同步开关不会生效。")
                : affordance.why}
            </span>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...S.flexRow, margin: '8px 0 12px' }}>
            <span style={S.muted}>
              {drivers
                ? drivers.drivers.length + tr("个驱动 · 同步档") + drivers.syncMode
                : tr("加载中…")}
              {sync ? tr("· 出站待同步") + sync.outbox.pending + (sync.outbox.dead > 0 ? tr("· 死信") + sync.outbox.dead : '') : ''}
            </span>
            <div style={S.grow} />
            <NButton
              disabled={!affordance.enabled}
              onClick={() => setDraft({ mode: 'create', id: '', type: 'mem0', enabled: true, endpoint: '', apiKey: '', space: '', extra: '' })}
            >
              {tr("新增驱动")} </NButton>
            <NButton onClick={load}>{tr("刷新")}</NButton>
          </div>

          {/* 开着态也要能说话：配置与装配不一致（刚改完总闸未重载）与待生效行都挂在这里。
              不渲染的话，“profile 已改关而实际仍在跑”这件最要紧的事就没人知道。 */}
          {drivers?.notice ? (
            <div style={{ ...S.hint, marginBottom: 10 }}>
              {gateStateText(true, drivers.configuredEnabled) ? '⚠ ' + gateStateText(true, drivers.configuredEnabled) + ' ' : ''}
              {drivers.notice}
            </div>
          ) : null}

          {(drivers?.drivers ?? []).map((d) => (
            <div key={d.driverId} className="dsh-mem-card" style={S.card}>
              <div style={S.cardHead}>
                <strong>{d.driverId}</strong>
                <span style={S.muted}>
                  {'· ' + d.typeId + (d.enabled ? (d.healthy ? tr("· 健康") : tr("· 未探活/异常")) : tr("· 已停用"))}
                  {d.outboxPending > 0 ? tr("· 待推") + d.outboxPending : ''}
                </span>
                <div style={S.grow} />
                <NButton onClick={() => probe(d.driverId)}>{tr("探活")}</NButton>
                {/* 编辑预填 endpoint/space(非机密);apiKey/extra 留空 = 保留原值。 */}
                <NButton
                  disabled={!affordance.enabled}
                  onClick={() =>
                    setDraft({ mode: 'edit', id: d.driverId, type: d.typeId, enabled: d.enabled, endpoint: d.endpoint, apiKey: '', space: d.space, extra: '' })
                  }
                >
                  {tr("编辑")} </NButton>
                <NButton
                  disabled={!affordance.enabled}
                  onClick={() => (removeStep(pendingRemove, d.driverId) === 'commit' ? removeDriver(d.driverId) : setPendingRemove(d.driverId))}
                >
                  {pendingRemove === d.driverId ? tr("确认删除") : tr("删除")}
                </NButton>
                {/* 导入到本地库：走 scope:'import' 票，不依赖配置写能力；不可用时必须说原因。 */}
                <NButton
                  disabled={!importable.enabled || !d.enabled}
                  title={!importable.enabled ? importable.why : d.enabled ? '' : tr("该驱动已停用，先启用再导入")}
                  onClick={() => setPendingImport(pendingImport === d.driverId ? null : d.driverId)}
                >
                  {pendingImport === d.driverId ? tr("确认开始导入") : tr("导入到本地库")}
                </NButton>
              </div>
              {/* 导入前把量级与成本说清：逐条向量化 + md 投射会生成等量文件，不说不就是预览按钮。 */}
              {pendingImport === d.driverId ? (
                <div style={{ ...S.hint, marginTop: 4 }}>
                  {importWarningText({ driverId: d.driverId, maxItems: IMPORT_DEFAULT_MAX, resumedFrom: resumePoint(importProg, d.driverId), memExportOn: drivers?.mdExportOn === true })}
                  <NButton onClick={() => startImport(d.driverId)}>{tr("开始导入")}</NButton>
                  <NButton onClick={() => setRestartImport(!restartImport)}>
                    {(restartImport ? '☑ ' : '☐ ') + tr("从头上重新开始（清断点）")}
                  </NButton>
                  <NButton onClick={() => setPendingImport(null)}>{tr("取消")}</NButton>
                </div>
              ) : null}
              {/* 删除前就把账本数目说清:没有这个数,"删除远端接入"看起来就像个无成本按钮。 */}
              {pendingRemove === d.driverId ? (
                <div style={{ ...S.hint, marginTop: 4 }}>
                  {removeWarningText(d.driverId, d.shadows, d.outboxPending)}
                  <NButton onClick={() => setPendingRemove(null)}>{tr("取消")}</NButton>
                </div>
              ) : null}
              {d.configuredSecrets.length > 0 ? (
                <div style={{ ...S.detail }}>{tr("已配置密钥:") + d.configuredSecrets.join(', ') + tr("（值不回显）")}</div>
              ) : null}
              {d.lastError ? <div style={{ ...S.hint, marginTop: 4 }}>{tr("最近错误:") + d.lastError}</div> : null}
            </div>
          ))}

          {drivers && drivers.drivers.length === 0 ? (
            <div style={{ ...S.muted, marginTop: 8 }}>{tr("尚无驱动登记：点右上「新增驱动」接入一家外部记忆服务（写入 profile，重载后装配）。")}</div>
          ) : null}

          {shadowRows.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div style={S.muted}>{tr("影子账本：")}</div>
              <div style={{ ...S.detail, marginTop: 4 }}>
                {shadowRows.map(([st, n]) => (SHADOW_STATE_LABELS[st] ?? st) + ' ' + n).join(' / ')}
              </div>
            </div>
          ) : null}

          {/* 导入进度与上一轮结果：进度只在 running 期间存在，而瞬间跑完的导入与
              “点了什么也没发生”长得一模一样——所以必须同时显示 last 的事后凭证。 */}
          {importProg !== null && (importProg.running || importProg.last !== undefined) ? (
            <div className="dsh-mem-card" style={{ ...S.card, marginTop: 12 }}>
              <div style={S.cardHead}>
                <strong>{importProg.running ? tr("导入进行中") : tr("上次导入结果")}</strong>
                <span style={S.muted}>
                  {importProg.running
                    ? tr("驱动 {p1} · 已到第 {p2} 条 · 新增 {p3} · 跳过 {p4}", { p1: importProg.driverId, p2: importProg.offset, p3: importProg.imported, p4: importProg.skipped })
                    : (() => {
                        const l = importProg.last!;
                        return importResultText({
                          imported: l.imported, skipped: l.skipped, conflicts: l.conflicts, failed: l.failed,
                          truncation: l.truncation, l1TotalBefore: l.l1TotalBefore, l1TotalAfter: l.l1TotalAfter,
                        });
                      })()}
                </span>
                <div style={S.grow} />
                {importProg.running ? <NButton onClick={cancelImport}>{tr("中断导入")}</NButton> : null}
                {importProg.running ? <NButton onClick={load}>{tr("刷新进度")}</NButton> : null}
              </div>
              {importProg.error ? <div style={{ ...S.hint, marginTop: 4 }}>{tr("⚠ 导入失败：") + importProg.error}</div> : null}
            </div>
          ) : null}

          {conflicts && conflicts.enabled && conflicts.items.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div style={S.muted}>
                {tr("同步冲突") + conflicts.open + tr("条") +
                  Object.entries(conflicts.byKind).map(([k, n]) => ' · ' + (CONFLICT_KIND_LABELS[k] ?? k) + ' ' + n).join('')}
              </div>
              {conflicts.items.map((c) => (
                <div key={c.conflictId} className="dsh-mem-card" style={{ ...S.card, marginTop: 6 }}>
                  <div style={S.cardHead}>
                    <strong>{CONFLICT_KIND_LABELS[c.kind] ?? c.kind}</strong>
                    <span style={S.muted}>{'· ' + c.driverId + (c.externalId ? tr("· 远端") + c.externalId : '')}</span>
                    <div style={S.grow} />
                    <NButton onClick={() => resolveConflict(c.conflictId, 'resolve')}>{tr("裁决")}</NButton>
                    <NButton onClick={() => resolveConflict(c.conflictId, 'dismiss')}>{tr("忽略")}</NButton>
                  </div>
                  {c.localPreview ? <div style={S.detail}>{tr("本地:") + c.localPreview}</div> : null}
                  {c.remotePreview ? <div style={{ ...S.detail, marginTop: 2 }}>{tr("远端:") + c.remotePreview}</div> : null}
                </div>
              ))}
            </div>
          ) : null}

          {probeMsg ? <div style={{ ...S.hint, marginTop: 8 }}>{probeMsg}</div> : null}
        </>
      )}

      {armInfo !== null && !armInfo.armed ? (
        <div style={{ ...S.hint, marginTop: 8 }}>{tr("驱动配置不可写：") + affordance.why}</div>
      ) : null}
      {writeMsg !== '' ? <div style={{ ...S.hint, marginTop: 8 }}>{writeMsg}</div> : null}

      {draft !== null ? (
        <NModal
          open={true}
          title={draft.mode === 'create' ? tr("新增外部记忆驱动") : tr("编辑驱动：") + draft.id}
          onClose={() => setDraft(null)}
        >
          <div style={{ display: 'grid', gap: 8 }}>
            {(['id', 'endpoint', 'apiKey', 'space', 'extra'] as const).map((key) => (
              <label key={key} style={{ display: 'grid', gap: 2 }}>
                <span style={S.muted}>{FIELD_LABELS[key]}</span>
                <NInput
                  value={draft[key]}
                  placeholder={fieldPlaceholder(key, draft.mode === 'edit')}
                  disabled={key === 'id' && draft.mode === 'edit'}
                  onChange={(e: { target: { value: string } }) => setDraft({ ...draft, [key]: e.target.value })}
                />
              </label>
            ))}
            <label style={{ display: 'grid', gap: 2 }}>
              <span style={S.muted}>{tr("type（9 家之一）")}</span>
              <select
                className="dsh-mem-input"
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value })}
              >
                {DRIVER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ ...S.muted, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              {tr("启用")} </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <NButton onClick={saveDraft}>{tr("保存")}</NButton>
              <NButton onClick={() => setDraft(null)}>{tr("取消")}</NButton>
            </div>
            <div style={S.detail}>{tr("保存即写入 profile；本插件无热重载通道，需重载后装配生效。仅面板可改，会话/模型无此能力。")}</div>
          </div>
        </NModal>
      ) : null}
    </div>
  );
}
