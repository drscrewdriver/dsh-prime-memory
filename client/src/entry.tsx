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
import { makeRpc } from './rpc.js';

export const inject = ['slots'];

/** 顶层「记忆」设置分节 —— **唯一**要挂的设置座位。 */
export const SETTINGS_SEAT = 'settings.section';
/** 判定期(ms)：够宿主把 `settings.section` 声明出来（用于「座位没挂上就响亮告警」）。 */
const SEAT_PROBE_MS = 3000;

export function apply(ctx: MemoryClientCtx) {
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
  try {
    ctx.slots.inject(SETTINGS_SEAT, () => {
      cardSeatLive = true;
      try {
        return ctx.slots.register(
          { name: SETTINGS_SEAT, id: 'dsh-memory', order: 200, label: '记忆', inject: () => ({ rpc }) },
          MemoryPanel,
        );
      } catch (err) {
        console.warn(`[dsh-prime-memory] ${SETTINGS_SEAT} 注册失败:`, err);
        return () => {};
      }
    });
  } catch (err) {
    console.warn(`[dsh-prime-memory] ${SETTINGS_SEAT} 槽位未声明:`, err);
  }

  // 响亮诊断：座位若始终没被声明（宿主改名/移除），面板会**静默消失**——
  // 这正是这个问题长期没被发现的原因，所以必须在 Console 说出来。
  setTimeout(() => {
    if (cardSeatLive) return;
    console.warn(
      `[dsh-prime-memory] 宿主未声明 ${SETTINGS_SEAT}：设置里的「记忆」面板不会出现。` +
        '（0.1.5 的座位集合本机未验证，请在真机上确认。）',
    );
  }, SEAT_PROBE_MS);

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
          inject: (sessionId: string) => ({ sessionId, rpc }),
        },
        MemoryModePill,
      );
    });
  } catch (err) {
    console.warn('[dsh-prime-memory] conversation.input.left 注册失败:', err);
  }
}
