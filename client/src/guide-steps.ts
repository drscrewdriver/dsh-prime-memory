/**
 * dsh-prime-memory 的首次使用引导文案（3 步；正文按 guide-kit 契约回退「本语 → en → zh」）。
 *
 * 为什么单独一个文件：`guide.tsx` 是 `_tools/guide-kit/` 的**生成副本**（sync 会覆盖），
 * 与本插件相关的文案不能放在里面，否则下一次同步就没了。
 *
 * 术语一律取本插件 locale 字典里的既有译名：概览 / 记忆模式 / 日常（个人）/ 智能（双族）/
 * 工作（团队）/ 人工冲突裁决 / 成本 / 冲突。
 */
import type { GuideLocale, GuideStep } from './guide.js'

/** prime-memory 设置分节的首屏引导（3 步；超 3 步完成率崩）。 */
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
  ],
}
