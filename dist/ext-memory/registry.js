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
import { EXT_DRIVER_SPECS, requiredMethodsOf, } from './types.js';
/** 校验失败错误:携带 driver 实例标识便于装配日志点名。 */
export class DriverContractError extends Error {
    constructor(message) {
        super(`[ext-memory] 驱动装配校验失败: ${message}`);
        this.name = 'DriverContractError';
    }
}
/**
 * 装配期校验:实例形状必须兑现自己的 capabilities 声明。
 * 抛 `DriverContractError` = 该驱动整体不注册(调用方捕获后 warn)。
 */
export function assertRuntime(driver) {
    const who = typeof driver?.id === 'string' && driver.id ? driver.id : '<无 id>';
    const typeId = driver.typeId;
    const spec = typeId === undefined ? undefined : EXT_DRIVER_SPECS[typeId];
    if (!spec)
        throw new DriverContractError(`${who}: typeId="${String(typeId)}" 不在 9 家清单内`);
    const cap = driver.capabilities;
    if (typeof cap !== 'object' || cap === null)
        throw new DriverContractError(`${who}: capabilities 缺失`);
    // 声明的能力集必须与静态描述符一致——防止实例自带一套更"乐观"的能力表绕开门禁
    // (forget=false 却想被调 forget,或反过来谎报 graph 让融合层白等)。
    for (const key of ['search', 'browse', 'graph', 'related', 'link', 'remember', 'forget']) {
        if (Boolean(cap[key]) !== Boolean(spec.capabilities[key])) {
            throw new DriverContractError(`${who}: capabilities.${key}=${String(cap[key])} 与描述符 ${String(spec.capabilities[key])} 不符`);
        }
    }
    for (const key of ['writeMode', 'deletionMode', 'addressing', 'freshness']) {
        if (cap[key] !== spec.capabilities[key]) {
            throw new DriverContractError(`${who}: capabilities.${key}="${String(cap[key])}" 与描述符 "${spec.capabilities[key]}" 不符`);
        }
    }
    // 必需核 + 条件核逐一在运行时可调用。
    const required = [...requiredMethodsOf(cap)];
    for (const m of required) {
        if (typeof driver[m] !== 'function') {
            throw new DriverContractError(`${who}: 声明要求方法 "${m}" 不存在`);
        }
    }
    // scoreSemantics 谎报判据:声明 normalized 却没这个字段在上面已拦;这里拦反向
    // 情形——声明 normalized 但按地址能力根本无法回查校验的,交给描述符(honcho 的
    // 'none' 是描述符事实,实例说了别的即不符)。
    if (driver.scoreSemantics !== spec.scoreSemantics) {
        throw new DriverContractError(`${who}: scoreSemantics="${String(driver.scoreSemantics)}" 与描述符 "${spec.scoreSemantics}" 不符`);
    }
}
export class ExtDriverRegistry {
    logger;
    entries = new Map();
    constructor(logger) {
        this.logger = logger;
    }
    /**
     * 校验并注册。同 id 二次注册视为装配错误(配置面 driver id 必须唯一)——
     * 静默覆盖会让"哪个实例在服务"变成随装载顺序漂移的事实。
     */
    register(driver, opts = {}) {
        assertRuntime(driver);
        if (this.entries.has(driver.id)) {
            throw new DriverContractError(`driver id "${driver.id}" 重复注册`);
        }
        this.entries.set(driver.id, { driver, enabled: opts.enabled !== false });
    }
    unregister(id) {
        return this.entries.delete(id);
    }
    /** 启用/禁用参与(≠ 删除):禁用后不出现在 enabled()、不进 lane、push 只入队不打网络。 */
    setEnabled(id, enabled) {
        const e = this.entries.get(id);
        if (!e)
            return false;
        e.enabled = enabled;
        return true;
    }
    get(id) {
        return this.entries.get(id)?.driver;
    }
    list() {
        return [...this.entries.values()].map((e) => ({ driver: e.driver, enabled: e.enabled }));
    }
    /** 参与调度的实例(检索 lane / pusher / puller 共用这一判据)。 */
    enabled() {
        return [...this.entries.values()].filter((e) => e.enabled).map((e) => e.driver);
    }
    get size() {
        return this.entries.size;
    }
    /**
     * 释放全部实例:`dispose?()` 必须关连接池/终止子进程——热重载不关旧池,
     * undici dispatcher / 子进程句柄会跨实例累积(Node 侧泄漏实测过的形态)。
     * 单个 dispose 失败只 warn,不阻断其余(卸载路径必须走到底)。
     */
    async disposeAll() {
        for (const { driver } of this.entries.values()) {
            try {
                await driver.dispose?.();
            }
            catch (err) {
                this.logger?.warn(`[memory] 外部驱动 ${driver.id} dispose 失败: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        this.entries.clear();
    }
}
