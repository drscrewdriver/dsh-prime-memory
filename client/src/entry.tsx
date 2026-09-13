/**
 * dsh-prime-memory — 浏览器半边入口（TS/TSX 源，scripts/build-client.mjs 经
 * esbuild 打包为 dist/client.js 单文件 bundle）。
 *
 * 三处 slot 挂载（settings 双槽 = 新旧宿主契约并存，任一失败不影响另一处）：
 * 1. 设置 → 插件 → 记忆卡片（settings.plugin.item，keyed 命名空间）——0.1.2+ 契约，
 *    卡片收编进「插件」标签页（compatibility-guide §4.1）；
 * 2. 设置 → 记忆直挂分节（settings.section，list）——0.1.1-rc.2 契约，0.1.2+ 上
 *    官方 general 分节也注册在此，故以 try/catch 守卫（未声明槽注册会在激活期抛错）；
 * 3. 输入栏（conversation.input.left）：会话记忆档位 pill，点开滑动选择器。
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

export function apply(ctx: MemoryClientCtx) {
  const rpc = makeRpc(ctx);
  console.info('[dsh-prime-memory] client apply: slots 注入就绪,注册 UI 槽位');

  // 设置 → 插件 → 记忆（0.1.2+ keyed 卡片契约;卡片无 label 字段,标签随插件 Tab 渲染）
  try {
    ctx.slots.inject('settings.plugin.item', () => {
      return ctx.slots.register(
        {
          name: 'settings.plugin.item',
          id: 'dsh-memory',
          key: 'dsh-memory',
          inject: () => ({ rpc }),
        },
        MemoryPanel,
      );
    });
  } catch (err) {
    console.warn('[dsh-prime-memory] settings.plugin.item 注册失败(旧宿主无此槽):', err);
  }

  // 设置 → 记忆 直挂分节(0.1.1 契约;0.1.2+ 该槽仍是 list 且官方 general 分节也注册
  // 在此,插件卡片同样可挂——挂两处时用户看到两个入口,属预期冗余,不冲突)
  try {
    ctx.slots.inject('settings.section', () => {
      return ctx.slots.register(
        {
          name: 'settings.section',
          id: 'dsh-memory',
          order: 200,
          label: '记忆',
          inject: () => ({ rpc }),
        },
        MemoryPanel,
      );
    });
  } catch (err) {
    console.warn('[dsh-prime-memory] settings.section 注册失败(新宿主已收编):', err);
  }

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
