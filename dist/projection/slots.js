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
 * - **任意已提交事件都判脏**(v0.18.4 起):此前仅在 tool/result(settled、非 error)
 *   时检查,实际运行中暴露出脆弱性——写入后的投影帧依赖"该会话恰好再来一条
 *   tool/result"才刷新;跨会话场景(会话 A 写、会话 B 看)更是要等 B 自己的下一次
 *   工具调用。改为对所有事件做 O(1) revision 比较:rev 未变 → 同引用(满足 I1b,
 *   无 republish thrash);rev 变 → 立即重建。写入后的下一条任意事件(用户消息、
 *   turn 边界、其他工具结果)都会把新帧推给客户端。
 * - isError 守卫一并移除:rev 只在 store 真实变更后递增(persist 内联 RMW),
 *   事件成败与否不影响"store 是否变了"这一事实;错误事件后重建读到的仍是
 *   当前真实快照,不会引入错误数据。
 */
function applySlotsEvent(state, event, store) {
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
