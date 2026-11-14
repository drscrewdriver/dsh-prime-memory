/**
 * 外部记忆驱动的类型骨架(计划 ext-mem-drivers-sync T0.1)。
 *
 * 定位:prime-memory 直连 9 家外部记忆服务(不经 dsh-mnemon)的统一接口。
 * 本文件**只有类型与静态描述符,零实现、零 I/O**——驱动实现是 Phase 1 的事,
 * 装配校验在 `registry.ts`,影子账本在 `schema.ts`。
 *
 * 类型自带(不 import dsh-mnemon 任何入口)是刻意的:参考实现的
 * `MemoryProviderAdapter` 挂在 Memory Spaces 的私有 provider-sdk 上,引它就要引
 * 整个 Source 的双半架构;而我们要的只是那 ~860 行 HTTP/CLI 胶水本身。
 *
 * 9 家差异由两维**新增**的正交属性描述(参考实现没有,影子化可行性判据全靠它们):
 * - `addressing`:外部条目能否被稳定寻址——`synthetic-block`(byterover 的整块合成
 *   Insight)结构性不可影子化,只允许读路融合、禁止双向同步;
 * - `freshness`:增量拉取能力——`none` 不拉,`full-scan` 靠 digest 差集,
 *   `cursor` 走服务端位点。
 */
import type { MemoryLogger } from '../types.js';
import type { ProcessRunner } from './proc.js';
/** 9 家驱动类型的唯一清单(配置面 `ext_memory.drivers[].type` 的合法值)。 */
export declare const EXT_DRIVER_TYPES: readonly ["mem0", "hindsight", "openviking", "honcho", "retaindb", "supermemory", "holographic", "byterover", "mnemon-native"];
export type ExtDriverType = (typeof EXT_DRIVER_TYPES)[number];
/** 同步档位(消费侧归一,配置面**不用 union**——ADR-0008 条 4:schemastery 对非法值抛错的故障半径是整棵配置树)。 */
export declare const EXT_SYNC_MODES: readonly ["shadow-read", "push-only", "two-way"];
export type ExtSyncMode = (typeof EXT_SYNC_MODES)[number];
/** 归一 sync_mode:非法/缺省 → 'shadow-read'(风险最低档)。 */
export declare function normSyncMode(raw: unknown): ExtSyncMode;
/** 共存门控(T4.2):投射(md)与外部同步的关系裁决结果。 */
export interface SyncModeGate {
    syncMode: ExtSyncMode;
    /** 非空 = 被降档/提示(装配时 warn + 面板展示)。 */
    notice?: string;
}
/**
 * md 投射 × 外部同步共存门控(T4.2)。
 *
 * 危险面是 **two-way**:外部回灌改库 → 投射把库渲染进文件,而文件侧手改又回灌库
 * ——两套写面在同一条记录的正文上互相触发,写回环与丢改并存。故 two-way 与
 * memExport 同开时**硬降 shadow-read**(融合不丢:检索仍能融合外部,只是不再出/回写)。
 *
 * push-only 保留:它只把库内容推向远端、不反向改库,与文件面无写竞争。
 */
export declare function applyCoexistGate(input: {
    extMemoryEnabled: boolean;
    syncMode: string;
    memExportEnabled: boolean;
}): SyncModeGate;
/**
 * 分数语义:honcho 不声明 normalized-relevance,跨家**不可比分数只能比 rank**
 * (与参考实现的联邦融合同判据)。融合层对 `none`/外部分一律只取列表位次。
 */
export type ExtScoreSemantics = 'normalized-relevance' | 'none';
/** 写完成语义:`async-extracting` 家的 remember 只回 operationId,externalId 要事后回捞。 */
export type ExtWriteMode = 'exact' | 'async-extracting';
/** 删除语义:soft=标失效可回滚;hard=不可逆;unsupported=根本没有删除口。 */
export type ExtDeletionMode = 'soft' | 'hard' | 'unsupported';
/** 条目寻址能力(影子化前置判据,见文件头)。 */
export type ExtAddressing = 'stable-id' | 'uri' | 'content-hash' | 'synthetic-block';
/** 增量拉取能力(同步游标策略判据,见文件头)。 */
export type ExtFreshness = 'cursor' | 'full-scan' | 'none';
/** 驱动能力声明:装配期校验（§T0.2）与运行期门禁的**唯一判据源**。 */
export interface DriverCapabilities {
    search: boolean;
    browse: boolean;
    graph: boolean;
    related: boolean;
    link: boolean;
    remember: boolean;
    forget: boolean;
    writeMode: ExtWriteMode;
    deletionMode: ExtDeletionMode;
    addressing: ExtAddressing;
    freshness: ExtFreshness;
    /**
     * 是否真的接了增量游标（`sincePull` 有实装）。默认全 false。
     *
     * 为何不能从 `freshness === 'cursor'` 推出：旧写法把 cursor 家必需方法表里推进了
     * `sincePull`，而各家基类都放了**会抛错的桩**——于是 `driver.sincePull !== undefined`
     * 恒为真，拉取分支永远走进报错路径（走不到本来可用的 list）。能力声明必须等于实装。
     */
    incremental: boolean;
    /** `list` 能否翻页（有 offset/page 语义）。mnemon-native/openviking 只能单页 → false。 */
    paged: boolean;
    /** 供应商标称限速(可选):pusher 侧令牌桶判据,缺省 = 不限(仍受串行泵约束)。 */
    rateLimit?: {
        burst: number;
        sustainedPerSec: number;
    };
}
/** 该驱动可否参与双向同步(影子/推送/拉取)。byterover 恒 false。 */
export declare function canSync(cap: DriverCapabilities): boolean;
/** 该驱动可否接收删除同步(退场传导)。 */
export declare function canForget(cap: DriverCapabilities): boolean;
/** 一个外部 namespace(space/bank/container/workspace…)的本地视图。 */
export interface ExtSpace {
    /** 本地稳定 id(`<driverId>-<externalId>` 规范化);影子表外键。 */
    spaceId: string;
    driverId: string;
    /** 服务端身份:bankId / userId:agentId / containerTag / viking uri / 目录路径。 */
    externalId: string;
    name: string;
    description: string;
}
/** 连接参数(非敏感部分)。敏感值(API key)永不进本对象、永不进 config 明文回显。 */
export type ExtConnection = Readonly<Record<string, string | number | boolean>>;
/** 检索入参。limit 由融合层封顶,驱动内不得自行放大。 */
export interface ExtSearchQuery {
    query: string;
    limit?: number;
    /** 驱动原生类别过滤(hindsight fact_type / openviking category 等;不支持即忽略)。 */
    category?: string;
}
/** 一条外部命中。`externalId` 是回查/去重/删除的锚;`content` 未过本地判据面,注入前必须截断。 */
export interface ExternalHit {
    driverId: string;
    spaceId: string;
    externalId: string;
    content: string;
    /** 驱动原生分;**跨驱动不可比**,融合层只用 rank,此字段仅供同驱动内展示。 */
    score?: number;
    category?: string;
    tags?: string[];
    entities?: string[];
    /** 外部侧创建/更新时间(ISO;本地时效轴与之无对应,只透传不判决)。 */
    updatedAt?: string;
    /** uri 型驱动(openviking)的定位符;其余为空串。 */
    uri?: string;
}
/** search 返回:results + 本轮是否还有更多(驱动不支持分页即 false)。 */
export interface ExtSearchResult {
    results: ExternalHit[];
    hasMore: boolean;
}
/** remember 入参。`localRecordId` 供驱动侧留审计线索,驱动不得据此假设本地语义。 */
export interface ExtRememberItem {
    content: string;
    category?: string;
    tags?: string[];
    entities?: string[];
    importance?: number;
    localRecordId?: string;
}
/**
 * 写回执。`completion` 五值的判据与参考实现同构:**只有确认全量落定才允许给
 * externalId**;拿不准一律 'unknown',让 awaiting-settle 回捞去收敛。
 * - `accepted`:远端收了(异步抽取家);
 * - `committed`:已落定,externalId 可信;
 * - `skipped`:远端判重(返回的 externalId 指向既有条目);
 * - `partial`/`failed`/`unknown`:不得更新影子为 linked。
 */
export interface ExtDriverReceipt {
    completion: 'accepted' | 'committed' | 'skipped' | 'partial' | 'failed' | 'unknown';
    externalId?: string;
    /** 异步家的凭据(operation_id/task_id/event_id),awaiting-settle 回捞依据。 */
    pendingOp?: string;
    error?: string;
}
/** 健康探测结果(探测级缓存 60s,见 registry/面板)。 */
export interface ExtHealthResult {
    healthy: boolean;
    error?: string;
    stats?: {
        count?: number;
    };
}
/** 图快照(仅 capabilities.graph=true;Phase 3 才消费,类型先行钉住形状)。 */
export interface ExtGraphSnapshot {
    nodes: Array<{
        externalId: string;
        label: string;
        kind: string;
    }>;
    edges: Array<{
        from: string;
        to: string;
        type: string;
        weight?: number;
    }>;
}
/** 增量拉取游标:驱动各自解释(cursor token / 水位 ISO / offset),本地只存透传。 */
export type ExtPullCursor = Record<string, string | number>;
/** discover 产物(尚未落 ext_spaces 的外部 namespace)。 */
export interface ExtDiscoveredSpace {
    externalId: string;
    name: string;
    description: string;
}
/**
 * `list` 的分页返回。
 *
 * `hasMore` 必须是「服务端还有下一页」的**事实**（由总数、next-token 或满页标记得出），
 * 不得由调用方用 `条数 === limit` 猜：整页恰好满但已到底会多发一次空请求，
 * 而服务端截断（如参考实现的 `.slice(0, limit)`）会误判成“已翻完”而谎报未截断。
 */
export interface ExtListPage {
    hits: ExternalHit[];
    hasMore: boolean;
}
/**
 * 统一驱动接口。
 *
 * 分层纪律:
 * - **必需核**(status/search/remember):任何一家至少要能探活+检索+写入,
 *   缺一即装配期拒绝(T0.2);
 * - **条件核**(forget/list/graph/sincePull):`capabilities` 声明了对应能力就
 *   **必须实现**——声明与运行时互校后,调用方可以无条件按能力分派,没有第二套判据;
 *   反过来，**没实装的能力不得声明**（旧写法从 `freshness` 推导 `sincePull` 必需，
 *   迫使各家放会抛错的桩，于是“方法存在”变成恒真判据）;
 * - **可选核**(discover/dispose):缺省由 registry/装配层用通用行为合成。
 *
 * 取消语义:读侧 signal 必须贯穿到 fetch/spawn(超时=协作取消);**写侧不得
 * 因超时把已发出的请求判为失败**——那会产生"远端已写、本地记 failed"的脏影子,
 * 幂等只能靠 ext_key/externalId 台账,不能靠放弃等待。
 */
export interface ExternalMemoryDriver {
    /** 实例 id(配置面给定,支持同型多实例,如两个 mem0 端点)。 */
    readonly id: string;
    readonly typeId: ExtDriverType;
    readonly capabilities: DriverCapabilities;
    readonly scoreSemantics: ExtScoreSemantics;
    status(signal?: AbortSignal): Promise<ExtHealthResult>;
    search(space: ExtSpace, q: ExtSearchQuery, signal?: AbortSignal): Promise<ExtSearchResult>;
    remember(space: ExtSpace, item: ExtRememberItem, signal?: AbortSignal): Promise<ExtDriverReceipt>;
    forget?(space: ExtSpace, externalId: string, signal?: AbortSignal): Promise<ExtDriverReceipt>;
    list?(space: ExtSpace, req: {
        limit: number;
        offset?: number;
    }, signal?: AbortSignal): Promise<ExtListPage>;
    graph?(space: ExtSpace, signal?: AbortSignal): Promise<ExtGraphSnapshot>;
    /** 类型化建边(仅 link=true 的家;mnemon-native 独有)。 */
    link?(space: ExtSpace, from: string, to: string, edgeType?: string, signal?: AbortSignal): Promise<ExtDriverReceipt>;
    /** 仅当 `capabilities.incremental === true` 时必需（不再从 freshness 隐含推导）。 */
    sincePull?(space: ExtSpace, cursor: ExtPullCursor, signal?: AbortSignal): Promise<{
        entries: ExternalHit[];
        next: ExtPullCursor;
    }>;
    discover?(conn: ExtConnection, signal?: AbortSignal): Promise<ExtDiscoveredSpace[]>;
    dispose?(): void | Promise<void>;
}
/** 构造驱动所需的装配入参(实例配置 + logger;连接机密由装配层注入 connection 前已过脱敏面)。 */
export interface ExtDriverFactoryInput {
    id: string;
    connection: ExtConnection;
    logger?: MemoryLogger;
    /** 单次请求超时(ms,config `ext_memory.request_timeout_ms` 传入;默认 15s 对齐参考实现)。 */
    requestTimeoutMs: number;
    /** 契约测试注入位:覆盖全局 fetch(HTTP 驱动)。生产不传。 */
    fetch?: typeof fetch;
    /** 契约测试注入位:覆盖子进程执行器(CLI 驱动)。生产不传。 */
    process?: ProcessRunner;
}
export type ExtDriverFactory = (input: ExtDriverFactoryInput) => ExternalMemoryDriver | Promise<ExternalMemoryDriver>;
/**
 * 9 家静态描述符(逐条核对自参考实现各 provider 的 descriptor.ts,判据:
 * capabilities 全映射、无遗漏字段——`tests/ext-memory-types.test.ts` 钉住
 * 「每家描述符的 required/conditional 方法表与 typeId 一一对应」)。
 *
 * `methods` 是给 T0.2 `assertRuntime` 的**校验规格**(声明了某能力却没实现对应
 * 方法 = 装配期拒绝注册;宁可装不上,不能运行期静默缺方法)。
 */
export interface ExtDriverSpec {
    typeId: ExtDriverType;
    transport: 'http' | 'cli' | 'local-file';
    capabilities: DriverCapabilities;
    scoreSemantics: ExtScoreSemantics;
    /** 条件核要求表:capability 键 → 必须存在的方法名。 */
    requiredMethods: readonly string[];
}
/** 逐家能力矩阵(唯一事实源;配置校验、面板展示、装配校验三方共用)。 */
export declare const EXT_DRIVER_SPECS: Readonly<Record<ExtDriverType, ExtDriverSpec>>;
/** 按能力表取一个实例上必须存在的方法名集合(T0.2 消费;导出以便单测复用)。 */
export declare function requiredMethodsOf(cap: DriverCapabilities): string[];
