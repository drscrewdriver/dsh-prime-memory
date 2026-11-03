/**
 * dsh-prime-memory — 浏览器半边入口（TS/TSX 源，scripts/build-client.mjs 经
 * esbuild 打包为 dist/client.js 单文件 bundle）。
 *
 * slot 挂载：
 * 1. 设置 → **顶层「记忆」分节**（`settings.section`）—— **唯一**的设置座位。
 *    记忆面板是多标签页的完整面板，适合放在顶层导航里；「插件配置」下的子级卡片座位
 *    （`settings.plugin.item`）留给轻量单卡片（search-index 留在那里）。
 * 2. 输入栏（`conversation.input.left`）：会话记忆档位 pill，点开滑动选择器。
 *
 * ⚠️ **曾经挂了三处，结果设置里出现三份「记忆」**（2026-09-17 实测回归）。
 * 起因是一个错误假设：「`slots.inject` 只在座位被声明时才触发 ⇒ 多个座位天然互斥」。
 * 实测推翻：**0.1.2 宿主同时声明了全部三个座位** ——
 *   - `settings.section`（`dsh-client-ui-settings-general:650`：顶层导航页）← 只留这个
 *   - `settings.plugins.tab`（`dsh-client-ui-settings-plugins:1781`：与「插件配置」平级的标签页）
 *   - `settings.plugin.item`（同包 `:1793`，由 `configurable` 贡献运行期声明：「插件配置」下的子级卡片）
 * 三次注册于是全触发。**各插件只留一个座位**，结构上就不可能再出现两份。
 *
 * **0.1.5 的座位集合在本机无法验证**（没有 0.1.5 宿主）：若该线没有声明
 * `settings.section`，面板会**静默消失**——正是这个问题长期没被发现的原因。
 * 故加一条一次性诊断，把"没挂上"从静默变成 Console 里的一行。
 *
 * 服务注入只声明 `slots`（全部目标版本必在）；`connection` 是可选服务且 0.1.2 才有
 * 独立包，声明式注入在缺席宿主上会让 apply 永久挂起（UI 全静默消失且无报错）——
 * 因此改为调用点经 ctx.get('connection') 懒解析（rpc.ts 每次调用现取）。
 *
 * 数据通道：connection.rpc.call('/rpc', 'dsh-memory/*', payload) → 宿主侧 RPC
 * 端点（类型契约见 src/contract.ts，两端共享同一事实源）。
 *
 * 产物形态对齐官方 client bundle 的 handoff 协议：
 *   window.__ModuleLoader__.load({ id, factory })，
 *   factory(require) 返回 { apply, inject }（wrapper 由构建脚本生成）。
 */
import type { MemoryClientCtx } from './env.js';
import { MemoryPanel } from './panel.js';
import { MemoryModePill } from './pill/MemoryModePill.js';
import { ExplorerPage } from './explorer/ExplorerPage.js';
import { ExplorerFooterEntry, ExplorerIcon } from './explorer/ExplorerEntry.js';
import { explorerEntryState } from './explorer/entry-state.js';
import { installLocale, onLocaleChange, tr } from './i18n.js';
import { makeRpc } from './rpc.js';

export const inject = ['slots'];

/** 顶层「记忆」设置分节 —— **唯一**要挂的设置座位。 */
export const SETTINGS_SEAT = 'settings.section';
/** 判定期(ms)：够宿主把 `settings.section` 声明出来（用于「座位没挂上就响亮告警」）。 */
const SEAT_PROBE_MS = 3000;

// ── 记忆库入口（双形态，照姊妹包 dsh-search-index） ──────────────────
/** 入口 id：同时是 `sidebar.panellist` 的行 id 与 `main` 的 key（宿主按同值寻址）。 */
export const EXPLORER_ID = 'dsh-memory-explorer';
/** 顶栏工具行（list）。 */
const PANEL_SEAT = 'sidebar.panellist';
/** 主栏整页（keyed）。 */
const MAIN_SEAT = 'main';
/** 底栏回落位（≤0.1.5）。 */
const FOOTER_SEAT = 'sidebar.footer.action';
/** 017 代际信号：0.1.7 线起才声明的会话菜单子席位（0.1.5 线无）。 */
const GEN_017_SEAT = 'sidebar.workspaces.session.menu.item';
/** 行序：插件 0 / 搜索 5 / 会话管理 6 → 记忆库 7。 */
const EXPLORER_ORDER = 7;

export function apply(ctx: MemoryClientCtx) {
  // 界面文案的 locale 接入（可选服务：拿不到就保持中文，见 i18n.ts）
  installLocale(ctx);
  const rpc = makeRpc(ctx);
  console.info('[dsh-prime-memory] client apply: slots 注入就绪,注册 UI 槽位');

  // 设置面板：**只挂顶层「记忆」分节（`settings.section`）**，其余座位一个都不注册。
  // ⚠️ 曾经挂了三处 → 设置里出现三份「记忆」（2026-09-17 实测回归）。起因是一个
  // 错误假设：「`slots.inject` 只在座位被声明时才触发 ⇒ 多个座位天然互斥」。
  // 实测推翻 —— 0.1.2 宿主**同时声明全部三个**：
  //   - `settings.section`（`dsh-client-ui-settings-general:650`）顶层导航页 ← **本插件只留这个**
  //   - `settings.plugins.tab`（`dsh-client-ui-settings-plugins:1781`）与「插件配置」平级的标签页
  //   - `settings.plugin.item`（同包 `:1793`）「插件配置」下的子级卡片
  // 记忆面板是多标签页的完整面板，适合顶层分节；`settings.plugin.item` 那个位置留给
  // 轻量单卡片（search-index 留在那里）。各留一个座位 = 结构上不可能再出现两份。
  const SETTINGS_SEAT = 'settings.section';
  let cardSeatLive = false;
  let sectionDispose: (() => void) | null = null;
  const registerSection = (): (() => void) =>
    ctx.slots.register(
      { name: SETTINGS_SEAT, id: 'dsh-memory', order: 200, label: tr("记忆"), inject: () => ({ rpc }) },
      MemoryPanel,
    );
  try {
    ctx.slots.inject(SETTINGS_SEAT, () => {
      cardSeatLive = true;
      try {
        sectionDispose = registerSection();
        return () => {
          sectionDispose?.();
          sectionDispose = null;
        };
      } catch (err) {
        console.warn(`[dsh-prime-memory] ${SETTINGS_SEAT} 注册失败:`, err);
        return () => {};
      }
    });

    // locale 服务实测晚于本插件 apply（bundle 加载期 tr 仍是中文），而座位 label 是
    // **注册时求值**的字符串：不重注册，左栏「记忆」会永远停在中文。
    onLocaleChange(() => {
      if (!cardSeatLive || !sectionDispose) return;
      try {
        sectionDispose();
        sectionDispose = registerSection();
      } catch (err) {
        console.warn('[dsh-prime-memory] 语言变更后重注册设置分节失败:', err);
      }
    });
  } catch (err) {
    console.warn(`[dsh-prime-memory] ${SETTINGS_SEAT} 槽位未声明:`, err);
  }

  // 响亮诊断：座位若始终没被声明（宿主改名/移除），面板会**静默消失**——
  // 这正是这个问题长期没被发现的原因，所以必须在 Console 说出来。
  setTimeout(() => {
    if (!cardSeatLive) {
      console.warn(
        `[dsh-prime-memory] 宿主未声明 ${SETTINGS_SEAT}：设置里的「记忆」面板不会出现。` +
          '（0.1.5 的座位集合本机未验证，请在真机上确认。）',
      );
    }
    if (!explorerMounted) {
      console.warn('[dsh-prime-memory] 记忆库入口未挂载：panellist/main/footer 三个座位都没等到。');
    }
  }, SEAT_PROBE_MS);

  // ── 记忆库入口：双形态 ─────────────────────────────────────────
  // 门控用 inject 探针本身：宿主只在座位**已被声明**时才跑 callback（含晚声明），
  // 所以不需要额外的 spec API，也不会出现「探测时没座位、稍后有了却没人挂」的漏挂。
  // 两枚探针到位 → 顶栏行 + 主栏整页；否则（≤0.1.5）→ 底栏按钮 + dialog。
  let gen017 = false;
  let mainSeat = false;
  let wired = false;
  let explorerMounted = false;
  let mountedPage = false;
  let detach: (() => void) | null = null;

  /** 选面板/回会话：布局服务是可选的，缺席时留在原地（不抛）。 */
  const selectPanel = (id: string | null): void => {
    try {
      const layout = ctx.get('layout') as { selectPanel?: (v: string | null) => void } | undefined;
      layout?.selectPanel?.(id);
    } catch {
      /* 布局服务缺席：用户可点侧栏「会话」行返回 */
    }
  };

  const mountPage = (): (() => void) => {
    const row = ctx.slots.inject(PANEL_SEAT, () =>
      ctx.slots.register({ name: PANEL_SEAT, id: EXPLORER_ID, order: EXPLORER_ORDER, label: tr("记忆库") }, ExplorerIcon),
    );
    const page = ctx.slots.inject(MAIN_SEAT, () =>
      ctx.slots.register(
        { name: MAIN_SEAT, key: EXPLORER_ID, inject: () => ({ rpc, onClose: () => selectPanel(null) }) },
        ExplorerPage,
      ),
    );
    // 卸载序先页后行：反过来会让宿主短暂持有“有行无页”的选中态。
    return () => {
      page();
      row();
    };
  };

  const mountFooter = (): (() => void) =>
    ctx.slots.inject(FOOTER_SEAT, () =>
      ctx.slots.register(
        { name: FOOTER_SEAT, id: EXPLORER_ID, order: EXPLORER_ORDER, inject: () => ({ rpc }) },
        ExplorerFooterEntry,
      ),
    );

  const sync = (): void => {
    // 开关门禁（market section-gate 的 apply 分支）：未确认前不挂（避免先闪后拆），
    // 确认关闭时把已挂的全拆掉——面板拨开关即时生效，不靠重启。
    if (!explorerEntryState.isConfirmed()) return;
    if (!explorerEntryState.isWanted()) {
      detach?.();
      detach = null;
      mountedPage = false;
      explorerMounted = true; // 诊断免误报：关了开关不是“没挂上”
      return;
    }
    const wantPage = gen017 && mainSeat;
    if (detach !== null && wantPage === mountedPage) return;
    detach?.();
    try {
      detach = wantPage ? mountPage() : mountFooter();
      mountedPage = wantPage;
      explorerMounted = true;
    } catch (err) {
      console.warn('[dsh-prime-memory] 记忆库入口挂载失败:', err);
      detach = null;
    }
  };
  // 面板即时切换（同 bundle 模块单例，market 同款通道）：OverviewTab 写成功后
  // explorerEntryState.set → 这里当场重算挂载。
  explorerEntryState.subscribe(() => sync());

  try {
    ctx.slots.inject(GEN_017_SEAT, () => {
      gen017 = true;
      if (wired) sync();
      return () => {
        gen017 = false;
        if (wired) sync();
      };
    });
    ctx.slots.inject(MAIN_SEAT, () => {
      mainSeat = true;
      if (wired) sync();
      return () => {
        mainSeat = false;
        if (wired) sync();
      };
    });
  } catch (err) {
    console.warn('[dsh-prime-memory] 记忆库座位探针失败（降级为不挂载）:', err);
  }
  // 探针登记完毕即开放响应：旧版这里用 wired 卡“settings 确认后才挂”，
  // 该门禁已移进 sync（confirmed 判定），wired 只保留“探针就位”语义。
  wired = true;
  // 专用开关（explorerEnabled，概览页可拨）：首读 live 快照落定挂载基线；
  // 之后的即时切换走上方 subscribe，不再需要重启。读失败 fail-open 照挂
  //（缺省语义就是开，settings.ts 只有显式 false 才关，不能因一次 RPC 抖动锁死入口）。
  void rpc('dsh-memory/settings-get', {})
    .then((res) => {
      explorerEntryState.confirm(
        res.ok && res.value.supported
          ? res.value.settings.explorerEnabled !== false
          : true, // settings 服务缺席 → fail-open，与旧行为一致
      );
    })
    .catch(() => {
      explorerEntryState.confirm(true);
    });

  // 输入栏（模式选择器右侧）：会话档位 pill + 滑动选择器。
  // inject owner 实测为裸 sessionId 字符串——rc.8 的命名座位不随快照 props；
  // 旧会话的占用回填因此在 host 侧完成（recall.ts estimateRecallTokens）
  try {
    ctx.slots.inject('conversation.input.left', () => {
      return ctx.slots.register(
        {
          name: 'conversation.input.left',
          id: 'dsh-memory-mode',
          order: 100,
          inject: (sessionId: string) => {
            return { sessionId, rpc };
          },
        },
        MemoryModePill,
      );
    });
  } catch (err) {
    console.warn('[dsh-prime-memory] conversation.input.left 注册失败:', err);
  }
}
