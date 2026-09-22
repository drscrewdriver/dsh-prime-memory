import { SLOT_KINDS, SLOT_STATUSES } from '../store/slots.js';
export const MEMORY_SLOTS_KEY = 'memorySlots';
function invalid(what, detail) {
    throw new Error(`${what}: ${detail}`);
}
function requireRecord(value, what) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        invalid(what, '期望普通对象');
    }
    return value;
}
function requireCounter(value, what, field) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        invalid(what, `${field} 必须是非负整数`);
    }
}
function requireMember(value, allowed, what, field) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        invalid(what, `${field} 必须是 ${allowed.join('/')} 之一`);
    }
}
/** 校验槽位投影载荷(state 与 wire view 同形)。 */
function parseSlotsPayload(value, what) {
    const root = requireRecord(value, what);
    requireCounter(root.rev, what, 'rev');
    requireCounter(root.count, what, 'count');
    requireCounter(root.openCount, what, 'openCount');
    if (!Array.isArray(root.slots))
        invalid(what, 'slots 必须是数组');
    root.slots.forEach((raw, index) => {
        const at = `${what}.slots[${index}]`;
        const item = requireRecord(raw, at);
        if (typeof item.id !== 'string' || item.id.length === 0)
            invalid(at, 'id 必须是非空字符串');
        if (typeof item.title !== 'string')
            invalid(at, 'title 必须是字符串');
        requireMember(item.kind, SLOT_KINDS, at, 'kind');
        requireMember(item.status, SLOT_STATUSES, at, 'status');
        const priority = item.priority;
        if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 100) {
            invalid(at, 'priority 必须是 0-100 的整数');
        }
    });
    return value;
}
/** 持久态校验:registry 用它挡掉损坏/过期的 checkpoint 行(row 不合法即整条丢弃)。 */
export const stateSchema = {
    parse: (value) => parseSlotsPayload(value, 'memorySlots.state'),
};
/** wire view 校验:registry 在 view 出网前调用(也覆盖 live drive 的发布路径)。 */
export const viewSchema = {
    parse: (value) => parseSlotsPayload(value, 'memorySlots.view'),
};
function buildState(store) {
    const snap = store.projectionSnapshot();
    return { rev: store.revision(), count: snap.count, openCount: snap.openCount, slots: snap.slots };
}
/**
 * view 引用稳定:同一 state 连续两次 view() 满足 Object.is(注册表据此判脏,
 * 否则每帧 republish)。state 是不可变引用,WeakMap 按 state 复用到同一 view。
 */
const viewMemo = new WeakMap();
function view(state) {
    const memoized = viewMemo.get(state);
    if (memoized !== undefined)
        return memoized;
    const next = {
        rev: state.rev,
        count: state.count,
        openCount: state.openCount,
        slots: state.slots,
    };
    viewMemo.set(state, next);
    return next;
}
/**
 * apply(state, event):同步。
 * - 仅 tool/result(settled,非 error)才检查:tool/call 在 store 变更提交前发生,按
 *   call 折会读到 stale;tool/result settled 才保证变更已落库(对齐 deliverables-fold)。
 * - 闭包 SlotStore,同步读 revision():rev 未变 → 本插件槽位未动 → 返回同引用
 *   (满足 I1b,避免 republish thrash);rev 变 → 重建快照。
 * - 任何无关事件 → 返回同引用(不 spread)。
 */
function applySlotsEvent(state, event, store) {
    if (event.type !== 'tool/result')
        return state;
    const data = event.data;
    const isError = Array.isArray(data?.message?.content) &&
        data.message.content.some((c) => c.isError === true);
    if (isError)
        return state;
    if (store.revision() === state.rev)
        return state;
    return buildState(store);
}
export function registerSlotsProjection(ctx, store) {
    ctx.inject(['sessionProjections'], (injected) => {
        const registry = injected
            .sessionProjections;
        if (registry === undefined || typeof registry.register !== 'function')
            return;
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
