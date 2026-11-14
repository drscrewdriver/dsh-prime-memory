/** 与 `config.ts` 的 `extMemory.drivers` 元素同构(结构类型,不 import config 避免环)。 */
export interface ExtDriverCfg {
    id: string;
    type: string;
    enabled: boolean;
    endpoint: string;
    apiKey: string;
    space: string;
    extra: string;
}
/** 驱动 id 形状:小写起头、可含数字点横线下划线、≤32。 */
export declare const DRIVER_ID_RE: RegExp;
export type NormalizeResult = {
    ok: true;
    driver: ExtDriverCfg;
    meta: {
        enabledProvided: boolean;
    };
} | {
    ok: false;
    error: string;
};
/**
 * 入参规范化:字段裁剪 + 白名单校验。
 * `type` 走 `EXT_DRIVER_TYPES`(9 类)而非 schema union——配置面纪律禁 union,
 * 且 union 会炸配置树(Phase 0 记录),白名单在消费侧收口。
 */
export declare function normalizeDriverInput(raw: unknown): NormalizeResult;
/**
 * upsert：同 id 原位替换（保持列表顺序稳定，面板不会因编辑跳行），不同 id 追加。
 *
 * **空 apiKey = 保留旧值**：client 侧永远拿不到明文，若不保留就等于“改任何字段都会清空密钥”。
 * 新驱动（id 不存在）时空串就是真空值（holographic/自托管可无 key），不做特殊处理。
 *
 * `enabledProvided` 同理：面板只改 endpoint 时不带 enabled，若无条件用 normalize 的缺省 true，
 * “已停用”的驱动会被静默启用——这类“没动的字段被动了”是配置面最难发现的一类坑。
 */
export declare function upsertDriverInList(list: readonly ExtDriverCfg[], driver: ExtDriverCfg, meta?: {
    enabledProvided: boolean;
}): {
    list: ExtDriverCfg[];
    created: boolean;
};
/** remove：按 id 摘除;不存在时原样返回(幂等，删除已消失的驱动不是错误)。 */
export declare function removeDriverFromList(list: readonly ExtDriverCfg[], id: string): {
    list: ExtDriverCfg[];
    removed: boolean;
};
/**
 * 单条写前的列表健康检查：`id` 形状不合法或**目标准则会被写入的列表里存在重复 id** 时返回错误。
 *
 * 重复 id 不是假想敌：profile YAML 可以手写出两条同 id，而装配侧 `registry.register`
 * 同名会覆写——于是“配置里两条”实际只有一条在跑，面板按 id 回显时更是无法区分。
 * 写入前拒住（并提示先人工清理）比默默合并诚实：用户改的是哪一条，系统得能回答。
 */
export declare function driverErrorOf(list: readonly ExtDriverCfg[], id: string): string | undefined;
/** 全表健康检查：重复 id 与非法形状逐条给出错误串（空数组 = 可安全写入）。 */
export declare function driverListErrors(list: readonly ExtDriverCfg[]): string[];
/**
 * 总闸写后读回：与 drivers 同理，“宿主是否真按提交值落了 enabled”不在我们手里。
 * 只比 `enabled` 一个字段（它是个标量，不存在数组深合并残留那类坑）。
 */
export declare function verifyEnabledReadback(expected: boolean, readback: unknown): {
    state: 'confirmed' | 'unverified' | 'mismatch';
    message: string;
};
/** 面板回读用的脱敏形状:只说"密钥是否已配置",永不带出明文或长度指纹。 */
export declare function toPublicDriver(d: ExtDriverCfg): {
    id: string;
    type: string;
    enabled: boolean;
    endpoint: string;
    space: string;
    hasApiKey: boolean;
    secretRef: string;
};
/**
 * 写后读回比对：把"宿主 `forms.update` 对数组的合并语义未知"变成**运行时自检**。
 *
 * 为什么需要它：如果宿主是按下标深合并，写短了的 drivers 数组会**残留尾部旧元素**：
 * 面板显示已删、profile 里驱动还在、重载后它又出现。这不是假想风险，而是 patch 型
 * 配置写入的经典坑。读回不一致时调用方必须报"未完全生效"，而不是假定成功。
 *
 * `readback` 为 undefined = 宿主不供读回能力 → `unverified`（降级不谎报，也不阻断）。
 * 比对口径用身份与路由字段，不比 apiKey（写出去是明文、读回来可能被脱敏）。
 */
export declare function verifyDriversReadback(expected: readonly ExtDriverCfg[], readback: unknown): {
    state: 'confirmed' | 'unverified' | 'mismatch';
    message: string;
};
