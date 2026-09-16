/**
 * dsh-prime-memory — 浏览器半边入口（TS/TSX 源，scripts/build-client.mjs 经
 * esbuild 打包为 dist/client.js 单文件 bundle）。
 *
 * slot 挂载（把「设置面板」那处按宿主线拆成三个座位，任一宿主只声明其中一个）：
 * 1. 设置 → 插件 → 记忆标签页（`settings.plugins.tab`，list）——**0.1.5 契约**；
 * 2. 设置 → 插件 → 记忆卡片（`settings.plugin.item`，keyed）——0.1.2/0.1.3 契约，
 *    卡片收编进「插件」标签页（compatibility-guide §16A.4）；
 * 3. 设置 → 记忆直挂分节（`settings.section`，list）——0.1.1-rc.2 契约。
 *    ⚠️ 本节此前只注册了第 3 个座位，而上面的注释**声称**注册了第 2 个——
 *    注释与代码不符，导致 0.1.2/0.1.5 上的设置卡片实际不可达且无人察觉。
 *    现按「三个座位都注册、由宿主声明决定哪个生效」收口。
 * 4. 输入栏（`conversation.input.left`）：会话记忆档位 pill，点开滑动选择器。
 *
 * 座位互斥是**宿主的机制**而非本插件的判断：`slots.inject` 只在命名座位
 * **被声明之后**才触发回调，所以三个 `inject` 里最多只有一个会执行到 `register`。
 * 因此不需要探测宿主版本，也不靠吞错兜底；工厂体内部仍自守 `register`，
 * 因为「未声明座位 / kind 不符」的抛错发生在激活期，外层的 try/catch 够不着。
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

  // 设置面板：三个座位按宿主线择一生效（见文件头说明）。
  // `id`/`key` 都给：0.1.2/0.1.3 的 `settings.plugin.item` 在 CLI dsh 上是 keyed
  // （要 `key`）、在 DSH Desktop 上是 list（要 `id`）；slots 服务只校验自己 kind
  // 的那个字段，所以两个都填才在两处都成立。`label` 是宿主每次渲染读取的标签文本。
  const SETTINGS_SEATS = ['settings.plugins.tab', 'settings.plugin.item', 'settings.section'] as const;
  for (const seat of SETTINGS_SEATS) {
    const isTab = seat === 'settings.plugins.tab';
    try {
      ctx.slots.inject(seat, () => {
        try {
          return ctx.slots.register(
            {
              name: seat,
              id: 'dsh-memory',
              key: 'dsh-memory',
              order: isTab ? 100 : 200,
              label: '记忆',
              inject: () => ({ rpc }),
            },
            MemoryPanel,
          );
        } catch (err) {
          console.warn(`[dsh-prime-memory] ${seat} 注册失败:`, err);
          return () => {};
        }
      });
    } catch (err) {
      console.warn(`[dsh-prime-memory] ${seat} 槽位未声明:`, err);
    }
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
