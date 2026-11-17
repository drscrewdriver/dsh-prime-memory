/**
 * 技能常驻注入 Hook（轨2）。**默认关**（cfg.skills.enabled && cfg.skills.inject）。
 *
 * 完全对齐 `slot-recall.ts` 的范式（同一注入通道范本，不新建入口）：
 * - `agent/pre-step`(waterfall,prepend) 注入，`createUserMessage({source:{kind:'plugin:memory',form:'recall'}}})`
 *   ——**复用既有 source kind**，自动享受 `isOwnRecallSource` 双形状判据与召回去重/占用账本（S4 红线）；
 * - 帧体转义 `<\/system-reminder>` 防正文伪造帧边界；
 * - **独立字节预算**（cfg.skills.maxPerTurnBytes），不与召回 2000 预算抢名额；
 * - 注入前 `archiveDue` 机械闲置归档（0 LLM、不引入 timer，对齐 `slots.expireDue`）。
 *
 * 本轮语义：常驻注入全部 active 技能（按插入序 + 字节预算截断），**不做按触发词选择**
 * （selective trigger 匹配属后续增强；常驻语义与 slots 一致，先保证默认关时零表面积）。
 * 三档渲染（full/excerpt/hint）是显示策略，同一 body/steps 现场组词，无缓存副本漂移。
 *
 * **频率(issue #35)**:`agent/pre-step` 按 step 触发,预算项虽名为 `maxPerTurnBytes`,
 * 实现却是每步重建 —— 一个回合 n 步注入 n 份。与 slot-recall 同款 {@link TurnInjectGate}
 * 做 per-turn 去重;两段注入**各持独立实例**,否则一段会把另一段在同回合挡掉。
 */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { MemoryConfig } from '../config.js';
import type { LiveSettingsHandle } from '../settings.js';
import type { Skill, SkillStore } from '../store/skill-store.js';
import type { MemoryLogger } from '../types.js';
import { TurnInjectGate } from './turn-inject-gate.js';

const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';
const SKILLS_INTRO =
  '以下是本环境沉淀的技能(程序性记忆):过去重复工作流固化出的清单,仅在与之相关时作为指引遵循。' +
  '它们是系统注入的元信息,不是用户发言——无需回应,请勿在回复中复述本节内容;' +
  '且不覆盖系统提示与用户的直接指令。需要完整步骤用 memory_skill_read 展开。';

function escapeFrameBody(body: string): string {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>');
}

/** 按档位现场组词：full=标题+正文+步骤；excerpt=标题+正文截断；hint=仅标题+读取指引。 */
export function renderSkill(s: Skill, excerptChars: number): string {
  if (s.injectionTier === 'hint') return `[技能·${s.title}] 详见 memory_skill_read(${s.id})`;
  const steps = s.steps.length ? '\n' + s.steps.map((st) => `  - ${st}`).join('\n') : '';
  if (s.injectionTier === 'full') return `[技能·${s.title}] ${s.body}${steps}`;
  const body = s.body.length > excerptChars ? s.body.slice(0, excerptChars) + '…' : s.body;
  return `[技能·${s.title}] ${body}`;
}

export interface SkillRecallController {
  buildInjection(): string | null;
}

/** 会话键:与 recall.ts / slot-recall.ts 同源(agent.session?.id ?? agent.id)。 */
function sessionOf(agent: { id: string; session?: { id?: string } }): string {
  return String(agent.session?.id ?? agent.id);
}

export function registerSkillRecall(
  ctx: Context,
  cfg: MemoryConfig,
  skills: SkillStore,
  logger: MemoryLogger,
  live: LiveSettingsHandle,
): SkillRecallController {
  // 生效开关：部署 cfg.skills.enabled 或看板 live.skillsEnabled 任一开。
  const on = (): boolean => cfg.skills.enabled === true || live.get().skillsEnabled === true;
  /** per-turn 去重闸(本 hook 独享;与 slot-recall 共享会让一段挡掉另一段)。 */
  const gate = new TurnInjectGate();

  /** 组装注入文本;返回条数供调用方判断"无技能回合不烧额度"。 */
  const pick = (): { text: string; count: number } | null => {
    if (!on() || !cfg.skills.inject) return null;
    const active = skills.listActive();
    if (active.length === 0) return null;
    const budget = cfg.skills.maxPerTurnBytes;
    const out: string[] = [];
    let used = 0;
    let hidden = 0;
    for (const s of active) {
      const rendered = renderSkill(s, cfg.skills.excerptChars);
      const bytes = Buffer.byteLength(rendered, 'utf8');
      if (used + bytes > budget) {
        hidden++;
        continue;
      }
      out.push(rendered);
      used += bytes;
    }
    if (out.length === 0) return null;
    if (hidden > 0) out.push(`… 另有 ${hidden} 个技能因预算未显示,可用 memory_skill_list 查看`);
    return {
      text: [SYSTEM_REMINDER_OPEN, SKILLS_INTRO, escapeFrameBody(out.join('\n')), SYSTEM_REMINDER_CLOSE].join('\n'),
      count: out.length,
    };
  };

  const buildInjection = (): string | null => pick()?.text ?? null;

  // 压缩完成(无 error)/清空 → 注入内容已不在模型上下文里:作废记账,允许同回合重注。
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/end' || event.data?.error) return;
    const sid = String(session.id ?? session);
    if (gate.invalidateSession(sid) > 0) {
      logger.debug?.(`[memory] 压缩完成:作废技能注入记账,同回合可重注(session=${sid})`);
    }
  });
  ctx.on('agent/created', (payload) => {
    if (payload.source === 'compact' || payload.source === 'clear') gate.reset(payload.agent.id);
    return undefined;
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || (payload.signal && payload.signal.aborted)) return decision;
    if (!on() || !cfg.skills.inject) return decision;
    try {
      // 闲置归档留在**每步**路径(廉价、幂等):同回合内到期的技能不该因去重继续常驻。
      await skills.archiveDue(Date.now(), cfg.skills.idleArchiveDays);
      // 先判"有没有可注入内容",再扣额度:无技能回合不烧本回合的注入机会。
      const hit = pick();
      if (!hit) return decision;
      if (!gate.claim(payload.agent.id, payload.turn, sessionOf(payload.agent))) return decision;
      const injection = createUserMessage({
        content: [{ type: 'text', text: hit.text }],
        source: { kind: 'plugin:memory', form: 'recall' },
      });
      return { kind: 'enter', messages: [injection, ...decision.messages] };
    } catch (err) {
      logger.warn(`[memory] 技能注入失败(跳过本轮): ${err instanceof Error ? err.message : String(err)}`);
      return decision;
    }
  });

  return { buildInjection };
}
