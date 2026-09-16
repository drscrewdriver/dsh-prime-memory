/** 记忆设置分节的主面板：Tab 框架（概览 / 记忆 / 冲突 / 场景 / 画像 / 成本 / 日志）。 */
import { useEffect, useState } from 'react';
import type { RpcFn } from './rpc.js';
import { watchSidebarIcon } from './sidebar-icon.js';
import { S } from './styles.js';
import { ensureThemeStyle } from './theme.js';
import { ConflictsTab } from './tabs/ConflictsTab.js';
import { CostTab } from './tabs/CostTab.js';
import { LogTab } from './tabs/LogTab.js';
import { OverviewTab } from './tabs/OverviewTab.js';
import { PersonaTab } from './tabs/PersonaTab.js';
import { RecordsTab } from './tabs/RecordsTab.js';
import { ScenesTab } from './tabs/ScenesTab.js';

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
  ['persona', '画像'],
  ['cost', '成本'],
  ['log', '日志'],
];

export function MemoryPanel(props: { rpc: RpcFn }) {
  const rpc = props.rpc;
  const [tab, setTab] = useState('overview');

  // 主题令牌与组件样式在面板挂载时注入一次（输入栏 pill 也可能已注入，幂等）
  ensureThemeStyle();
  useEffect(() => {
    watchSidebarIcon();
  }, []);

  let body;
  if (tab === 'overview') body = <OverviewTab rpc={rpc} />;
  else if (tab === 'records') body = <RecordsTab rpc={rpc} />;
  else if (tab === 'conflicts') body = <ConflictsTab rpc={rpc} />;
  else if (tab === 'scenes') body = <ScenesTab rpc={rpc} />;
  else if (tab === 'persona') body = <PersonaTab rpc={rpc} />;
  else if (tab === 'cost') body = <CostTab rpc={rpc} />;
  else body = <LogTab rpc={rpc} />;

  return (
    <div className="dsh-mem-root" style={S.section}>
      <h2 style={S.heading}>记忆 (Memory)</h2>
      <p style={S.intro}>L0~L3 分层蒸馏记忆：浏览被记住的内容，控制记忆模式开关。</p>
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
              {t[1]}
            </button>
          );
        })}
      </div>
      {body}
    </div>
  );
}
