/**
 * 蒸馏设置区（#34 B 形态：范围分段）——路由链与预算按「全局默认 / L1 / L2 / L3」
 * 分段组织的外壳。数据源：llm-providers 的 layerChains 三态块（runtime 自定义 /
 * static 部署 YAML / global 跟随全局，分段标签上挂状态点）+ settings-get 的预算
 * （props 透传）。面板体复用 RouteChainEditor（scope 参数化）与 BudgetInputs
 * （scope 裁剪显示列）。层级语义（ADR-0005）：每层实际链 = 层自定义 → 部署 YAML
 * 层链 → 全局默认链逐级兜底；部署 pin 时运行时编辑只读。
 */
import { useEffect, useState, type CSSProperties } from 'react';
import type { LayerRouteKey, LlmProvidersResponse, SettingsGetResponse } from '../../../src/contract.js';
import type { RpcFn } from '../rpc.js';
import { Segmented, type SegOption } from '../ui/controls.js';
import { BudgetInputs } from './BudgetInputs.js';
import { ChannelEditor } from './ChannelEditor.js';
import { RouteChainEditor } from './RouteChainEditor.js';

const STY: Record<string, CSSProperties> = {
  hint: { fontSize: 11, color: 'var(--dsh-mem-text-3)', margin: '0 0 8px' },
  panelHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 },
  panelTitle: { fontSize: 13.5, fontWeight: 650, color: 'var(--dsh-mem-text-1)' },
  chip: {
    display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '1px 8px',
    fontSize: 11, fontWeight: 600, lineHeight: '18px', whiteSpace: 'nowrap',
  },
  chipAccent: { background: 'var(--dsh-mem-accent-weak)', color: 'var(--dsh-mem-accent-text)' },
  chipMuted: { background: 'var(--dsh-mem-bg-inset)', color: 'var(--dsh-mem-text-2)' },
  inUse: { fontSize: 11, color: 'var(--dsh-mem-text-3)', margin: '6px 0 0' },
};

/** 分段状态点：实心蓝 = 运行时自定义；空心 = 部署 YAML；灰点 = 跟随全局。 */
function Dot(props: { kind: 'runtime' | 'static' | 'global' }) {
  const base: CSSProperties = {
    display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
    marginRight: 4, verticalAlign: 'middle', flexShrink: 0,
  };
  if (props.kind === 'runtime') return <span style={{ ...base, background: 'var(--dsh-mem-accent)' }} />;
  if (props.kind === 'static') return <span style={{ ...base, background: 'transparent', border: '1.5px solid var(--dsh-mem-text-3)' }} />;
  return <span style={{ ...base, background: 'var(--dsh-mem-track)' }} />;
}

const LAYER_META: Record<LayerRouteKey, { seg: string; title: string }> = {
  l1: { seg: 'L1', title: 'L1 · 抽取 / 去重' },
  l2: { seg: 'L2', title: 'L2 · 场景摘要' },
  l3: { seg: 'L3', title: 'L3 · 画像蒸馏' },
};

export function DistillSettings(props: {
  rpc: RpcFn;
  disabled?: boolean;
  data: SettingsGetResponse | null;
  setData(d: SettingsGetResponse): void;
  onError(msg: string | null): void;
}) {
  const rpc = props.rpc;
  const disabled = !!props.disabled;
  const [info, setInfo] = useState<LlmProvidersResponse | null>(null);
  const [tab, setTab] = useState<'g' | LayerRouteKey>('g');

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      rpc('dsh-memory/llm-providers', {})
        .then((r) => {
          if (alive && r && r.ok) setInfo(r.value);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [rpc]);

  const layers = info?.layerChains;
  const dotOf = (k: LayerRouteKey): 'runtime' | 'static' | 'global' => layers?.[k]?.source ?? 'global';
  // 仍走全局默认链的层（全局分段的「在用」清单）
  const users = (['l1', 'l2', 'l3'] as LayerRouteKey[]).filter((k) => dotOf(k) === 'global');

  const segOptions: SegOption[] = [
    { key: 'g', label: '全局默认', title: '未单独配置的层走这条链（当前在用：' + (users.length ? users.map((k) => LAYER_META[k].seg).join('、') : '无') + '）' },
    ...(['l1', 'l2', 'l3'] as LayerRouteKey[]).map((k) => ({
      key: k,
      title: LAYER_META[k].title + ' · ' + (dotOf(k) === 'runtime' ? '运行时自定义' : dotOf(k) === 'static' ? '部署 YAML 层链（只读）' : '跟随全局'),
      label: (
        <span>
          <Dot kind={dotOf(k)} />
          {LAYER_META[k].seg}
        </span>
      ),
    })),
  ];

  const chipTitle = (k: LayerRouteKey): string =>
    dotOf(k) === 'runtime'
      ? '本层走设置页自定义链'
      : dotOf(k) === 'static'
        ? '本层走部署 YAML 层链（UI 只读，自定义可覆盖）'
        : '本层未单独配置，走全局默认链';

  return (
    <div>
      <Segmented value={tab} options={segOptions} onChange={(k) => setTab(k as 'g' | LayerRouteKey)} />
      {/* 圆点图例 + 一行优先级提示（完整解释挂 tooltip，不占版面） */}
      <div style={STY.hint}>
        <Dot kind="runtime" /> 自定义 · <Dot kind="static" /> 部署 YAML · <Dot kind="global" /> 跟随全局
        <span title="每层实际链：运行时自定义 → 部署 YAML 层链 → 全局默认链，逐级兜底；部署 pin 时运行时编辑只读">（层链优先于全局）</span>
      </div>

      {tab === 'g' ? (
        <div>
          <div style={STY.panelHead}>
            <span style={STY.panelTitle}>全局默认链</span>
            <span style={{ ...STY.chip, ...STY.chipAccent }}>运行时 · 可编辑</span>
            <span style={{ ...STY.inUse, marginLeft: 'auto' }}>
              {users.length ? '在用：' + users.map((k) => LAYER_META[k].seg).join('、') : '当前无层使用'}
            </span>
          </div>
          {/* key=tab 强制重挂载：编辑草稿是子组件内部态，切范围不重挂会把上一段
              的草稿带进下一段（L3 草稿漏进 L1/全局，保存还会写错层——#34 验收
              发现的实例复用 bug，靠 key 隔离修复） */}
          <RouteChainEditor key={'g'} rpc={rpc} disabled={disabled} />
          <BudgetInputs key={'g-budget'} rpc={rpc} disabled={disabled} data={props.data} setData={props.setData} onError={props.onError} scope="input" />
          {/* 蒸馏通道（direct 解耦）：传输层覆盖作用于所有层，只在全局分段挂出 */}
          {info?.channel ? <ChannelEditor channel={info.channel} rpc={rpc} disabled={disabled} /> : null}
        </div>
      ) : (
        <div>
          <div style={STY.panelHead}>
            <span style={STY.panelTitle}>{LAYER_META[tab].title}</span>
            <span style={{ ...STY.chip, ...(dotOf(tab) === 'runtime' ? STY.chipAccent : STY.chipMuted) }} title={chipTitle(tab)}>
              {dotOf(tab) === 'runtime' ? '运行时自定义' : dotOf(tab) === 'static' ? '静态 · YAML' : '跟随全局'}
            </span>
          </div>
          <RouteChainEditor key={tab} rpc={rpc} disabled={disabled} scope={tab} />
          <BudgetInputs key={tab + '-budget'} rpc={rpc} disabled={disabled} data={props.data} setData={props.setData} onError={props.onError} scope={tab} />
        </div>
      )}
    </div>
  );
}
