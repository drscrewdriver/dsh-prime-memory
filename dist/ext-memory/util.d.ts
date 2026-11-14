/**
 * 外部驱动共用小工具(计划 T1.x):extra JSON 解析、数值钳制、响应体安全取值。
 * 纯函数零 I/O;`objOf/arrOf/str/num` 与参考实现的 firstArray/jsonObject 家族
 * 同语义——外部服务的响应形状漂移是常态,取值面必须逐字段判缺、绝不 `!` 断言。
 */
/** 解析配置的 `extra` JSON 串(非法/空 → {})。驱动专有字段全部走这里进来。 */
export declare function parseExtra(raw: unknown): Record<string, unknown>;
export declare function str(value: unknown): string | undefined;
export declare function num(value: unknown): number | undefined;
export declare function obj(value: unknown): Record<string, unknown> | undefined;
export declare function arr(value: unknown): unknown[];
/** 按候选键序取第一个数组字段(各家包裹层不一:results/memories/items/…)。 */
export declare function firstArray(payload: unknown, ...keys: string[]): unknown[];
export declare function clampInt(value: unknown, lo: number, hi: number, dflt: number): number;
/** 内容注入前的安全截断(外部正文不受本地 maxCharsPerMemory 之外判据约束,lane 层先切一刀)。 */
export declare function clip(text: string, max: number): string;
/** 外部件的稳定 id:`ext:<driverId>:<spaceId>:<externalId>`(与 L1Store.extLane 归因约定同源)。 */
export declare function extHitId(driverId: string, spaceId: string, externalId: string): string;
/**
 * 内容指纹**单源**(T4.1):实现在 `store/digest.ts`，这里只 re-export 保既有 import 面。
 * `recordDigest` = `contentDigest`(含 type 的库侧指纹);三侧裁决用 `contentOnlyDigest`。
 */
export { normContentKey, sha256Hex, contentDigest as recordDigest } from '../store/digest.js';
/** CSV 串归一成去重 Set(非法/空 → 空 Set;消费侧容错,配置面不抛)。 */
export declare function normCsv(raw: unknown): Set<string>;
/** CSV 串归一成升序数值数组(非法项丢弃;空集回退缺省阶梯)。 */
export declare function normCsvNumbers(raw: unknown, dflt: number[]): number[];
/**
 * Phase 1 只读构建的写侧桩:方法存在以满足 `assertRuntime`(声明与运行时互校),
 * 但任何真实写入都**明确报错而不静默半实现**——返回 failed 回执,推送链路(Phase 2)
 * 接入后由真实现替掉。
 *
 * 读侧桩不再用本常量：拉取类未实装的能力（list/graph）现在抛 `ExtCapabilityMissingError`，
 * 因为调用方需要能区分“该家没接”与“远端真故障”——旧写法两者都是普通 Error，于是 puller 要么
 * 无差别 catch（把远端抖动静默降级成从头全量翻页）、要么无差别计失败（把本来可用的 list 挡在门外）。
 */
export declare const READ_ONLY_RECEIPT: {
    completion: "failed";
    error: string;
};
/**
 * 能力未实装哨兵错。`instanceof` 判据不受错误文案改动影响，也不依赖 message 子串匹配。
 */
export declare class ExtCapabilityMissingError extends Error {
    readonly capability: 'list' | 'graph' | 'sincePull' | 'discover';
    constructor(capability: ExtCapabilityMissingError['capability'], what: string);
}
/** 拉取分派判据：错是不是“能力没接”（而非网络/服务端故障）。 */
export declare function isCapabilityMissing(err: unknown, capability?: 'list' | 'graph' | 'sincePull' | 'discover'): boolean;
/** 旧接口保留（多处调用）：语义上等价于“能力未实装”。 */
export declare function readOnlyPhaseError(what: string): Error;
