/**
 * 外部驱动注册表与装配校验(计划 ext-mem-drivers-sync T0.2)。
 *
 * 核心纪律(从参考实现的宿主装配层继承,那里叫 `assertRuntime`):**声明与运行时
 * 互校**——capabilities 说了什么,实例上就必须有什么;对不上就装配期拒绝注册,
 * 宁可装不上,不能运行期静默缺方法(运行期 `d.forget!(...)` 的 TypeError 会炸穿
 * pusher 的批次循环,那才是最难归因的故障)。
 *
 * 本模块零网络零 SQL:只持实例引用与退役标记;健康缓存与熔断位在 Phase 1 的
 * lane/pusher 侧另建(它们才是消费方),registry 不越权管运行态。
 */
import { type ExternalMemoryDriver } from './types.js';
import type { MemoryLogger } from '../types.js';
/** 校验失败错误:携带 driver 实例标识便于装配日志点名。 */
export declare class DriverContractError extends Error {
    constructor(message: string);
}
/**
 * 装配期校验:实例形状必须兑现自己的 capabilities 声明。
 * 抛 `DriverContractError` = 该驱动整体不注册(调用方捕获后 warn)。
 */
export declare function assertRuntime(driver: ExternalMemoryDriver): void;
export declare class ExtDriverRegistry {
    private readonly logger?;
    private readonly entries;
    constructor(logger?: MemoryLogger | undefined);
    /**
     * 校验并注册。同 id 二次注册视为装配错误(配置面 driver id 必须唯一)——
     * 静默覆盖会让"哪个实例在服务"变成随装载顺序漂移的事实。
     */
    register(driver: ExternalMemoryDriver, opts?: {
        enabled?: boolean;
    }): void;
    unregister(id: string): boolean;
    /** 启用/禁用参与(≠ 删除):禁用后不出现在 enabled()、不进 lane、push 只入队不打网络。 */
    setEnabled(id: string, enabled: boolean): boolean;
    get(id: string): ExternalMemoryDriver | undefined;
    list(): Array<{
        driver: ExternalMemoryDriver;
        enabled: boolean;
    }>;
    /** 参与调度的实例(检索 lane / pusher / puller 共用这一判据)。 */
    enabled(): ExternalMemoryDriver[];
    get size(): number;
    /**
     * 释放全部实例:`dispose?()` 必须关连接池/终止子进程——热重载不关旧池,
     * undici dispatcher / 子进程句柄会跨实例累积(Node 侧泄漏实测过的形态)。
     * 单个 dispose 失败只 warn,不阻断其余(卸载路径必须走到底)。
     */
    disposeAll(): Promise<void>;
}
