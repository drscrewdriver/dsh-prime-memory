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
import type { SlotStore } from '../store/slots.js';
export declare const MEMORY_SLOTS_KEY = "memorySlots";
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
/** 持久态校验:registry 用它挡掉损坏/过期的 checkpoint 行(row 不合法即整条丢弃)。 */
export declare const stateSchema: SchemaLike<SlotsProjectionState>;
/** wire view 校验:registry 在 view 出网前调用(也覆盖 live drive 的发布路径)。 */
export declare const viewSchema: SchemaLike<SlotsView>;
export declare function registerSlotsProjection(ctx: Context, store: SlotStore): void;
export {};
