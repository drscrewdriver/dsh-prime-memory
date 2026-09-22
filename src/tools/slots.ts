/**
 * 激活槽位(active slot)工具面。仅注册三个工具,不改动 tools/index.ts(零侵入)。
 *
 * 门控语义:
 * - memory_slot_list:读,受会话档位门控(与 memory_search 同语义)——off/召回关返回 notice。
 * - memory_slot_write / memory_slot_close:写,受 live.memoryMutate 高权限门控(默认关)。
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { MemoryConfig } from '../config.js';
import type { LiveSettingsHandle } from '../settings.js';
import type { SessionModeStore } from '../store/session-modes.js';
import type { SlotInput, SlotStore } from '../store/slots.js';
import type { MemoryLogger } from '../types.js';

const MUTATE_OFF_NOTICE =
  '槽位写操作未开放:请在记忆库面板开启高权限模式(memoryMutate)后再试。';
const OFF_NOTICE = '本会话的记忆档位为"关闭":槽位读取不可用。';
const GLOBAL_OFF_NOTICE = '记忆召回已关闭:槽位读取不可用。';

interface SlotToolExec {
  agent?: { id?: string };
}

export function registerSlotTools(
  ctx: Context,
  cfg: MemoryConfig,
  slots: SlotStore,
  logger: MemoryLogger,
  modes: SessionModeStore,
  live: LiveSettingsHandle,
): void {
  if (!cfg.tools) return;

  /** 解析有效归属会话(简化版,仅取自身 id;跨会话持久的槽位不依赖父链)。 */
  const ownerOf = (exec: SlotToolExec): string | undefined => exec?.agent?.id;

  /** 读类工具档位门控:off / 召回关 → 返回 notice(与 memory_search 同语义)。 */
  const readBlockNotice = (exec: SlotToolExec): string | undefined => {
    const owner = ownerOf(exec);
    if (owner === undefined) return undefined; // fail-open:缺 agent 标识不拒绝
    if (modes.get(owner) === 'off') return OFF_NOTICE;
    if (!modes.resolvedRecall(owner, live.get().recall)) return GLOBAL_OFF_NOTICE;
    return undefined;
  };

  // ── memory_slot_list:列出槽位(读,档位门控) ──
  ctx.tools.register(
    defineTool({
      name: 'memory_slot_list',
      description:
        '列出当前所有激活槽位(active slot)。槽位是可跨会话持久化的结构化提示(规则/待办/锚点/指针);pinned 的 open 槽位会被常驻注入每轮对话上下文。',
      parameters: {
        status: { type: 'string', description: '按状态过滤:open / done / dropped / expired;留空返回全部' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            slots: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  kind: { type: 'string' },
                  status: { type: 'string' },
                  priority: { type: 'number' },
                  pinned: { type: 'boolean' },
                  body: { type: 'string' },
                  refs: { type: 'array', items: { type: 'string' } },
                  validUntil: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
            notice: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => {
          const slots = value.slots ?? [];
          const text = value.notice
            ? value.notice
            : `当前槽位 ${slots.length} 个:\n` +
              slots
                .map(
                  (s) => `- [${s.status}${s.pinned ? ',pinned' : ''}] ${s.title} (${s.kind}, p${s.priority})`,
                )
                .join('\n');
          return [{ type: 'text', text }];
        },
      },
      execute: async (args, exec) => {
        const notice = readBlockNotice(exec);
        if (notice) return { slots: [], notice };
        let all = slots.list();
        if (typeof args.status === 'string' && args.status.trim()) {
          const st = args.status.trim();
          all = all.filter((s) => s.status === st);
        }
        return { slots: all };
      },
    }),
  );

  // ── memory_slot_write:写入新槽位(写,memoryMutate 门控) ──
  ctx.tools.register(
    defineTool({
      name: 'memory_slot_write',
      description:
        '写入一个激活槽位(active slot)。适合把跨会话需要持续生效的规则、待办、锚点或外部指针固化下来;pinned=true 的 open 槽位会常驻注入每轮对话上下文。需高权限模式开启。',
      parameters: {
        title: { type: 'string', required: true, description: '槽位标题(≤60 字,一句话概括)' },
        kind: { type: 'string', description: '槽位类型:rule(规则)/todo(待办)/anchor(锚点)/pointer(指针,正文可空)' },
        body: { type: 'string', description: '槽位正文(≤512 字;pointer 类型可留空)' },
        priority: { type: 'number', description: '优先级 0-100(默认 50;常驻注入时高优先级优先)' },
        pinned: { type: 'boolean', description: '是否常驻注入每轮对话上下文(默认 false)' },
        refs: { type: 'string', description: '关联引用(L1 record_id / 文件路径 / URL),逗号分隔' },
        validUntil: { type: 'string', description: '有效期止(ISO 8601);留空表示长期有效' },
        status: { type: 'string', description: '初始状态(默认 open)' },
      },
      output: {
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, notice: { type: 'string' } },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: value.notice ?? `已写入槽位 ${value.id ?? ''}` },
        ],
      },
      execute: async (args, _exec) => {
        if (!live.get().memoryMutate) return { notice: MUTATE_OFF_NOTICE };
        const input: SlotInput = {
          title: String(args.title ?? ''),
          kind: typeof args.kind === 'string' ? (args.kind as SlotInput['kind']) : undefined,
          body: typeof args.body === 'string' ? args.body : undefined,
          priority: typeof args.priority === 'number' ? args.priority : undefined,
          pinned: typeof args.pinned === 'boolean' ? args.pinned : undefined,
          refs:
            typeof args.refs === 'string'
              ? args.refs
                  .split(',')
                  .map((r) => r.trim())
                  .filter(Boolean)
              : undefined,
          validUntil:
            typeof args.validUntil === 'string' && args.validUntil.trim()
              ? args.validUntil.trim()
              : undefined,
          status: typeof args.status === 'string' ? (args.status as SlotInput['status']) : undefined,
          origin: 'user',
        };
        try {
          const slot = await slots.upsert(input);
          logger.info(`[memory] 写入激活槽位(${slot.kind},pinned=${slot.pinned}):${slot.title.slice(0, 60)}`);
          return { id: slot.id };
        } catch (err) {
          return { notice: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  );

  // ── memory_slot_close:关闭槽位(写,memoryMutate 门控) ──
  ctx.tools.register(
    defineTool({
      name: 'memory_slot_close',
      description:
        '关闭一个激活槽位(标记 done 或 dropped)。关闭后不再常驻注入,但仍可在 memory_slot_list 中查看。需高权限模式开启。',
      parameters: {
        id: { type: 'string', required: true, description: '要关闭的槽位 id(来自 memory_slot_list)' },
        status: { type: 'string', description: '关闭后的状态:done(完成)/dropped(放弃);默认 done' },
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, notice: { type: 'string' } },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: value.notice ?? (value.ok ? '已关闭槽位' : '槽位不存在或关闭失败') },
        ],
      },
      execute: async (args, _exec) => {
        if (!live.get().memoryMutate) return { ok: false, notice: MUTATE_OFF_NOTICE };
        const id = String(args.id ?? '').trim();
        if (!id) return { ok: false, notice: 'id 为空' };
        const status = args.status === 'dropped' ? 'dropped' : 'done';
        const ok = await slots.close(id, status);
        if (ok) logger.info(`[memory] 关闭激活槽位(${status}):${id}`);
        return { ok };
      },
    }),
  );
}
