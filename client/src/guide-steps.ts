/**
 * dsh-prime-memory 的首次使用引导文案（4 步；正文按 guide-kit 契约回退「本语 → en → zh」）。
 *
 * 为什么单独一个文件：`guide.tsx` 是 `_tools/guide-kit/` 的**生成副本**（sync 会覆盖），
 * 与本插件相关的文案不能放在里面，否则下一次同步就没了。
 *
 * 术语一律取本插件 locale 字典里的既有译名：概览 / 记忆模式 / 日常（个人）/ 智能（双族）/
 * 工作（团队）/ 人工冲突裁决 / 成本 / 冲突 / 蒸馏通道 / 直连端点 / 复用宿主 / 层链。
 *
 * 末条固定讲「用量端点」：蒸馏是每轮都在跑的后台调用，跟对话共用模型时账单涨得
 * 最快，而本插件恰好给了独立出口（`llm.mode: direct` + baseURL）——放在最后一步而不是
 * 第一步，因为得先知道开关在哪、成本在哪，这条建议才可执行。
 */
import type { GuideLocale, GuideStep } from './guide.js'

/** prime-memory 设置分节的首屏引导（4 步；guard 上限 10 步，本仓按「主链路 → 用量」收在 4 步）。 */
export const PRIME_MEMORY_GUIDE_STEPS: Partial<Record<GuideLocale, readonly GuideStep[]>> = {
  zh: [
    {
      title: '先看概览，再看记忆',
      body: '首屏是「概览」：记忆模式开关组（捕获 / 蒸馏 / 召回）在这里，上方的计数瓦片说明 L1 记录有没有在长。开关写下去即时生效，不用重载插件。',
    },
    {
      title: '输入栏 pill 定本会话档位',
      body: '对话输入栏左侧的 pill 是会话档位：日常（个人）/ 智能（双族）/ 工作（团队），点开是八边形域轮。它只覆盖当前会话，全局限流仍在概览页的开关组里。',
    },
    {
      title: '成本与待裁决的冲突',
      body: '「成本」页按层级和模型看蒸馏花掉的 token；「冲突」页默认是空的 —— 要先去概览打开「人工冲突裁决」，之后每一对冲突都会停在那里等你判。',
    },
    {
      title: '蒸馏走独立端点，别蹭对话模型',
      body: '概览页的「蒸馏通道」选「直连端点」，填一个本地 OpenAI 兼容端点（如 http://127.0.0.1:8000/v1），再把全局链和 L1/L2/L3 层链的主路由钉到便宜的小模型。通道停在「跟随部署配置」或「复用宿主」时，蒸馏和对话共用同一个 provider/model，每轮抽取都在吃对话配额。',
    },
  ],
  en: [
    {
      title: 'Start on Overview',
      body: 'The first tab is Overview: the memory-mode switch group (capture / distillation / recall) lives here, and the count tiles above show whether L1 records are actually growing. Switches apply right away, no plugin reload.',
    },
    {
      title: 'The composer pill sets this session',
      body: 'The pill at the left of the composer is the session tier: Chat (personal) / Auto (two families) / Work (team); click it for the octagonal domain wheel. It overrides this session only — global limits stay in the Overview switch group.',
    },
    {
      title: 'Cost, and the conflicts only you can settle',
      body: 'The Cost tab shows distillation tokens by level and model. The Conflict tab starts empty: turn on Manual conflict resolution in Overview first, and every conflicting pair then parks there waiting for your verdict.',
    },
    {
      title: 'Give distillation its own endpoint',
      body: 'Set the Distillation channel in Overview to Direct endpoint and point it at a local OpenAI-compatible service (e.g. http://127.0.0.1:8000/v1), then pin the global chain and the L1/L2/L3 layer chains to cheap small models. While the channel stays on Follow deployment config or Reuse host, distillation shares one provider/model with the conversation, so every extraction round spends conversation quota.',
    },
  ],
}
