/**
 * 激活槽位服务端投影(memorySlots)。
 *
 * 只注册服务端单元,绝不做 client——前端展示由未来 brief-sidebar 消费(下一轮)。
 * 注册经 ctx.inject(['sessionProjections'], …):服务缺席时静默不注册、不抛错
 * (注册表里没有 key 时客户端读 faceOf(key) 恒为 undefined,侧边栏栏位自然隐藏)。
 *
 * apply 同步、闭包 SlotStore:tool/result(settled)时同步读 revision() 判脏,rev 未变
 * 返回同引用(避免每帧 republish),rev 变才重建快照。view 用 WeakMap 保引用稳定。
 */
import type { Context } from '@deepseek-ai/cordis';
import { SLOT_KINDS, SLOT_STATUSES } from '../store/slots.js';
import type { SlotStore } from '../store/slots.js';

export const MEMORY_SLOTS_KEY = 'memorySlots';

export interface SlotsViewSlot {
  id: string;
  title: string;
  kind: string;
  status: string;
  priority: number;
}

export interface SlotsProjectionState {
  rev: number;
  count: number;
  openCount: number;
  slots: SlotsViewSlot[];
}

export interface SlotsView {
  rev: number;
  count: number;
  openCount: number;
  slots: SlotsViewSlot[];
}

/**
 * 零依赖 schema:`sessionProjections` 契约在类型层写的是 zod 的 `ZodType`,但运行时
 * **只调用 `parse(value)`** 一个方法(实测 registry `viewCheckpoint`/`restore`/`drive`/
 * `viewCell` 四处)。本插件不新增依赖(不引 zod —— package.json/锁文件不在本轮改动白名单,
 * 且声明式依赖缺失会在严格 node_modules 布局下解析失败),改为自实现等价校验器。
 *
 * 语义边界(有意为之,非"占位"):
 * - 合法 → **原样返回同一引用**(不 clone、不 strip):registry 按 `Object.is` 比较 view,
 *   clone 会破坏引用稳定契约;
 * - 非法 → **抛错**:`parse` 是 registry 的校验闸(状态回放前 / wire 出网前),
 *   静默透传会让损坏的持久态与越界 view 一路带进客户端;
 * - **未知键容忍**(不拒绝):`drive` 期 `viewSchema.parse` 无 try/catch,若新增字段即抛错
 *   会打断整条会话事件驱动;view 的字段集由构造函数固定 + 单测断言(F9)保证。
 */
interface SchemaLike<T> {
  parse(value: unknown): T;
}

function invalid(what: string, detail: string): never {
  throw new Error(`${what}: ${detail}`);
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(what, '期望普通对象');
  }
  return value as Record<string, unknown>;
}

function requireCounter(value: unknown, what: string, field: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(what, `${field} 必须是非负整数`);
  }
}

function requireMember(value: unknown, allowed: readonly string[], what: string, field: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    invalid(what, `${field} 必须是 ${allowed.join('/')} 之一`);
  }
}

/** 校验槽位投影载荷(state 与 wire view 同形)。 */
function parseSlotsPayload<T>(value: unknown, what: string): T {
  const root = requireRecord(value, what);
  requireCounter(root.rev, what, 'rev');
  requireCounter(root.count, what, 'count');
  requireCounter(root.openCount, what, 'openCount');
  if (!Array.isArray(root.slots)) invalid(what, 'slots 必须是数组');
  (root.slots as unknown[]).forEach((raw, index) => {
    const at = `${what}.slots[${index}]`;
    const item = requireRecord(raw, at);
    if (typeof item.id !== 'string' || item.id.length === 0) invalid(at, 'id 必须是非空字符串');
    if (typeof item.title !== 'string') invalid(at, 'title 必须是字符串');
    requireMember(item.kind, SLOT_KINDS, at, 'kind');
    requireMember(item.status, SLOT_STATUSES, at, 'status');
    const priority = item.priority;
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 100) {
      invalid(at, 'priority 必须是 0-100 的整数');
    }
  });
  return value as T;
}

/** 持久态校验:registry 用它挡掉损坏/过期的 checkpoint 行(row 不合法即整条丢弃)。 */
export const stateSchema: SchemaLike<SlotsProjectionState> = {
  parse: (value) => parseSlotsPayload<SlotsProjectionState>(value, 'memorySlots.state'),
};

/** wire view 校验:registry 在 view 出网前调用(也覆盖 live drive 的发布路径)。 */
export const viewSchema: SchemaLike<SlotsView> = {
  parse: (value) => parseSlotsPayload<SlotsView>(value, 'memorySlots.view'),
};

function buildState(store: SlotStore): SlotsProjectionState {
  const snap = store.projectionSnapshot();
  return { rev: store.revision(), count: snap.count, openCount: snap.openCount, slots: snap.slots };
}

/**
 * view 引用稳定:同一 state 连续两次 view() 满足 Object.is(注册表据此判脏,
 * 否则每帧 republish)。state 是不可变引用,WeakMap 按 state 复用到同一 view。
 */
const viewMemo = new WeakMap<SlotsProjectionState, SlotsView>();
function view(state: SlotsProjectionState): SlotsView {
  const memoized = viewMemo.get(state);
  if (memoized !== undefined) return memoized;
  const next: SlotsView = {
    rev: state.rev,
    count: state.count,
    openCount: state.openCount,
    slots: state.slots,
  };
  viewMemo.set(state, next);
  return next;
}

interface ProjectionRegistryLike {
  register(definition: {
    key: string;
    stateSchema: { parse(value: unknown): unknown };
    init(): SlotsProjectionState;
    apply(state: SlotsProjectionState, event: { type: string; data: unknown }): SlotsProjectionState;
    wire: { viewSchema: { parse(value: unknown): unknown }; view(state: SlotsProjectionState): SlotsView };
    stateVersion: number;
  }): () => void;
}

/**
 * apply(state, event):同步。
 * - 仅 tool/result(settled,非 error)才检查:tool/call 在 store 变更提交前发生,按
 *   call 折会读到 stale;tool/result settled 才保证变更已落库(对齐 deliverables-fold)。
 * - 闭包 SlotStore,同步读 revision():rev 未变 → 本插件槽位未动 → 返回同引用
 *   (满足 I1b,避免 republish thrash);rev 变 → 重建快照。
 * - 任何无关事件 → 返回同引用(不 spread)。
 */
function applySlotsEvent(
  state: SlotsProjectionState,
  event: { type: string; data: unknown },
  store: SlotStore,
): SlotsProjectionState {
  if (event.type !== 'tool/result') return state;
  const data = event.data as { message?: { content?: readonly { isError?: unknown }[] } } | undefined;
  const isError =
    Array.isArray(data?.message?.content) &&
    data!.message!.content!.some((c) => (c as { isError?: unknown }).isError === true);
  if (isError) return state;
  if (store.revision() === state.rev) return state;
  return buildState(store);
}

export function registerSlotsProjection(ctx: Context, store: SlotStore): void {
  ctx.inject(['sessionProjections'], (injected) => {
    const registry = (injected as unknown as { sessionProjections?: ProjectionRegistryLike })
      .sessionProjections;
    if (registry === undefined || typeof registry.register !== 'function') return;
    registry.register({
      key: MEMORY_SLOTS_KEY,
      stateSchema,
      init: () => buildState(store),
      apply: (state, event) => applySlotsEvent(state, event, store),
      wire: { viewSchema, view },
      stateVersion: 0,
    });
  });
}
