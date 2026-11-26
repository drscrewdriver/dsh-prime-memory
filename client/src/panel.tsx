/** 记忆设置分节的主面板：Tab 框架（概览 / 记忆 / 冲突 / 场景 / Hall / Room / 图谱 / 画像 / 成本 / 日志）。 */
import { tr } from './i18n.js';
import { useLocaleRevision } from './i18n-react.js';
import { useEffect, useState } from 'react';
import type { RpcFn } from './rpc.js';
import { watchSidebarIcon } from './sidebar-icon.js';
import { applySkin, getSkin, setSkin, type Skin } from './skin.js';
import { S } from './styles.js';
import { GuidePanel, GuideRestartButton, guideSteps, isGuideSkipped } from './guide.js';
import { PRIME_MEMORY_GUIDE_STEPS } from './guide-steps.js';
import { LlmCostNotice } from './LlmNotice.js';
import type { DirectChannelView } from '../../src/contract.js';
import { DrscHealthBanner } from './components/DrscHealthBanner.js';
import { ensureThemeStyle } from './theme.js';
import { ConflictsTab } from './tabs/ConflictsTab.js';
import { ConnectTab } from './tabs/ConnectTab.js';
import { ExtMemoryTab } from './tabs/ExtMemoryTab.js';
import { SkillsTab } from './tabs/SkillsTab.js';
import { CostTab } from './tabs/CostTab.js';
import { LogTab } from './tabs/LogTab.js';
import { OverviewTab } from './tabs/OverviewTab.js';
import { PersonaTab } from './tabs/PersonaTab.js';
import { RecordsTab } from './tabs/RecordsTab.js';
import { RoomsTab } from './tabs/RoomsTab.js';
import { RoomTab } from './tabs/RoomTab.js';
import { GraphTab } from './tabs/GraphTab.js';
import { ScenesTab } from './tabs/ScenesTab.js';
import { mountStarRow } from './star-row-copy.js';

/**
 * Tab 注册表：[key, 名称]；首项为默认页。
 *
 * 「冲突」排在「记忆」之后：它是**待办**性质的面板 —— 冻结开启后队列里停着的是
 * 等你裁决的东西，藏太深等于没有（这正是它此前长期缺失的表现：
 * 裁决端点一直在，但没有任何地方列得出 `pair_id`）。
 */
const TABS: Array<[string, string]> = [
  ['overview', '概览'],
  ['records', '记忆'],
  ['conflicts', '冲突'],
  ['scenes', '场景'],
  ['rooms', 'Hall'],
  ['room', 'Room'],
  ['graph', '图谱'],
  ['persona', '画像'],
  ['cost', '成本'],
  ['log', '日志'],
  ['connect', '来源'],
  ['ext', '外部记忆'],
  ['skills', '技能'],
];

/** 皮肤三态（轨1-P0）：纯表现层，偏好存 localStorage，不进插件 config。 */
const SKIN_OPTS: Array<[Skin, string]> = [
  ['light', '浅色'],
  ['dark', '深色'],
  ['auto', '跟随'],
];

export function MemoryPanel(props: { rpc: RpcFn }) {
  useLocaleRevision(); // locale 变更 → 根重渲染 → 整棵子树的 tr() 文案随之刷新
  const rpc = props.rpc;
  const [tab, setTab] = useState('overview');
  const [skin, setSkinState] = useState<Skin>(() => getSkin());
  // 首次使用引导：懒初始化读一次「跳过」标记，之后由本组件状态决定显隐。
  const [guideOpen, setGuideOpen] = useState(() => !isGuideSkipped('prime-memory'));
  // 蒸馏通道现状（只读展示给首区块费用提示用；写入仍在概览→蒸馏通道）
  const [llmChannel, setLlmChannel] = useState<DirectChannelView | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      rpc('dsh-memory/llm-providers', {})
        .then((r) => {
          if (alive && r && r.ok) setLlmChannel(r.value.channel);
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

  // 主题令牌与组件样式在面板挂载时注入（输入栏 pill 也可能已注入，幂等）；
  // 每次渲染按当前皮肤刷新 html 属性（ensureThemeStyle 可重入，不重写样式表）。
  ensureThemeStyle(skin);
  useEffect(() => {
    // applySkin 挂上（至多一次的）宿主跟随监听；皮肤变更经 state 重渲染回流至此。
    applySkin(skin);
    watchSidebarIcon();
  }, [skin]);

  const switchSkin = (next: Skin) => {
    setSkin(next); // 持久化到 localStorage
    setSkinState(next); // 触发重渲染 → ensureThemeStyle(next) + effect applySkin(next)
  };

  let body;
  if (tab === 'overview') body = <OverviewTab rpc={rpc} />;
  else if (tab === 'records') body = <RecordsTab rpc={rpc} />;
  else if (tab === 'conflicts') body = <ConflictsTab rpc={rpc} />;
  else if (tab === 'scenes') body = <ScenesTab rpc={rpc} />;
  else if (tab === 'rooms') body = <RoomsTab rpc={rpc} />;
  else if (tab === 'room') body = <RoomTab rpc={rpc} />;
  else if (tab === 'graph') body = <GraphTab rpc={rpc} />;
  else if (tab === 'persona') body = <PersonaTab rpc={rpc} />;
  else if (tab === 'cost') body = <CostTab rpc={rpc} />;
  else if (tab === 'connect') body = <ConnectTab rpc={rpc} />;
  else if (tab === 'ext') body = <ExtMemoryTab rpc={rpc} />;
  else if (tab === 'skills') body = <SkillsTab rpc={rpc} />;
  else body = <LogTab rpc={rpc} />;

  return (
    <div className="dsh-mem-root" style={S.section}>
      <h2 style={S.heading}>{tr("记忆 (Memory)")}</h2>
      <p style={S.intro}>{tr("L0~L3 分层蒸馏记忆：浏览被记住的内容，控制记忆模式开关。")}</p>
      {/* LLM 费用提示与本地端点建议：设置面第一个区块（引导/美化排其次）。 */}
      <LlmCostNotice channel={llmChannel} />
      {/* 设置面上方恒定重启入口：跳过引导后不必清浏览器存储就能重新显示贴士，
          所以它必须在一进来就看到的地方——贴士本身也渲染在同一位置。*/}
      <div style={{ marginBottom: 12 }}>
        <GuideRestartButton
          ns="prime-memory"
          onOpen={() => {
            setGuideOpen(true);
          }}
        />
      </div>
      {/* 首次使用引导：放在标题与 intro 之后、DRSC 横幅之前，一进来先看到，不打断下方表单 */}
      {guideOpen && (
        <GuidePanel
          ns="prime-memory"
          steps={guideSteps(PRIME_MEMORY_GUIDE_STEPS)}
          onClose={() => {
            setGuideOpen(false);
          }}
        />
      )}
      {/* DRSC 依赖状态：顶部一条横幅，跨 12 个 tab 全局可见；ok 态自作 null 不占版面 */}
      <DrscHealthBanner rpc={rpc} />
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 2,
          marginTop: -6,
          marginBottom: 10,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)', marginRight: 4 }}>{tr("皮肤")}</span>
        {SKIN_OPTS.map((s) => (
          <button
            key={s[0]}
            className={skin === s[0] ? 'dsh-mem-tab dsh-mem-tab-on' : 'dsh-mem-tab'}
            onClick={() => switchSkin(s[0])}
            title={tr("皮肤：{p1}", { p1: tr(s[1]) })}
          >
            {tr(s[1])}
          </button>
        ))}
      </div>
      <div style={S.tabbar}>
        {TABS.map((t) => {
          return (
            <button
              key={t[0]}
              className={tab === t[0] ? 'dsh-mem-tab dsh-mem-tab-on' : 'dsh-mem-tab'}
              onClick={() => {
                setTab(t[0]!);
              }}
            >
              {tr(t[1])}
            </button>
          );
        })}
      </div>
      {body}
      {/* 面板常驻 star 快车道：仓库链接永留，求星话术可一键收起（dismissed 键 dsh.star.prime-memory） */}
      <span
        ref={(node) => {
          if (node && !node.firstChild) node.appendChild(mountStarRow());
        }}
      />
    </div>
  );
}
