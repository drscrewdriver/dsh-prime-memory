import type { MemoryLogger } from '../types.js';
/**
 * 槽位类型全集。**单一所有者**:投影片注册的 schema 校验也从这里取枚举,
 * 避免"store 加了新 kind、投影 schema 没跟上"导致 drive 期 parse 抛错。
 */
export declare const SLOT_KINDS: readonly ["rule", "todo", "anchor", "pointer"];
/** 槽位状态全集(单一所有者,同 SLOT_KINDS)。 */
export declare const SLOT_STATUSES: readonly ["open", "done", "dropped", "expired"];
export type SlotKind = (typeof SLOT_KINDS)[number];
export type SlotStatus = (typeof SLOT_STATUSES)[number];
export interface Slot {
    id: string;
    title: string;
    kind: SlotKind;
    status: SlotStatus;
    /** 0-100,常驻注入时按降序优先。 */
    priority: number;
    /** ≤512 字;kind='pointer' 时可为空。 */
    body: string;
    /** L1 record_id / 文件路径 / URL 等关联引用(指针语义,不复制正文)。 */
    refs: string[];
    /** true = 常驻注入每轮对话上下文。 */
    pinned: boolean;
    /** 有效期止(ISO 8601);过期由 expireDue() 机械置为 expired,不触发 LLM。 */
    validUntil?: string;
    origin: 'user' | 'agent';
    createdAt: string;
    updatedAt: string;
}
export interface SlotInput {
    title: string;
    kind?: SlotKind;
    status?: SlotStatus;
    priority?: number;
    body?: string;
    refs?: string[];
    pinned?: boolean;
    validUntil?: string;
    origin?: 'user' | 'agent';
}
export interface SlotStoreOptions {
    maxSlots: number;
    maxBodyChars: number;
    maxTitleChars: number;
}
/** 投影 view 的单条槽位(不含 body —— 判定与生成正交,正文按需再取)。 */
export interface SlotView {
    id: string;
    title: string;
    kind: SlotKind;
    status: SlotStatus;
    priority: number;
}
export declare class SlotStore {
    private readonly file;
    private readonly logger;
    /** 活引用:数组本身稳定,元素原地改;外部持有者不会因 mutate 拿到孤儿。 */
    private slots;
    private rev;
    /** 只读降级原因(undefined = 正常):非空时内存照常更新,但停止回写。 */
    private degraded;
    /** 本进程已认可的磁盘 rev(并发冲突判据:磁盘比它新 = 别人写过)。 */
    private baseRev;
    private degradedLogged;
    private readonly maxSlots;
    private readonly maxBodyChars;
    private readonly maxTitleChars;
    constructor(file: string, logger: MemoryLogger, opts?: Partial<SlotStoreOptions>);
    /**
     * 读回持久态。**读侧分类**(文件层加固 T2):
     * - 缺失 → 默认空态(首次运行,合法,不告警);
     * - 损坏/不可读 → 默认空态 + **只读降级**(禁写,不覆盖原文件);
     * - 未知版本 → **允许读**(按当前形状宽容解释)+ 只读降级(禁写)。
     *   本 store 无迁移路径,一律拒载会让插件在版本回退时直接不可用。
     */
    load(): Promise<void>;
    /** 同步读内存,返回副本(不泄漏内部数组)。 */
    list(): Slot[];
    /** 同步读内存,仅 open 槽位副本。 */
    open(): Slot[];
    /** 按 id 取单个槽位副本(不存在返回 undefined)——close 工具关闭前读 refs 用。 */
    get(id: string): Slot | undefined;
    /** 当前版本号(投影 apply 的判脏依据)。 */
    revision(): number;
    /** 总数(投影 count 用)。 */
    count(): number;
    /** open 数(投影 openCount 用)。 */
    openCount(): number;
    /**
     * 写入一个新槽位(insert-only:SlotInput 无 id,upsert 之名对应"无则建")。
     * 超限直接抛错(不静默丢弃),调用方转成工具 notice。
     */
    upsert(input: SlotInput): Promise<Slot>;
    /** 关闭槽位(标记 done/dropped)。不存在返回 false。 */
    close(id: string, status: 'done' | 'dropped'): Promise<boolean>;
    /**
     * 常驻注入选材:pinned && open,按 priority 降序,累计字节 ≤ maxBytes。
     * 至少保留 1 条(即便单条超预算,避免"写了却永远看不到");其余超预算的计入
     * truncatedCount,供注入尾部补 "+N more"(预算静默丢弃会让槽位"看起来写了没生效")。
     */
    alwaysOn(maxBytes: number): {
        slots: Slot[];
        truncatedCount: number;
    };
    /**
     * 机械过期:validUntil ≤ now 的 open 槽位置为 expired。纯比较,不触发任何 LLM。
     * 返回过期条数。
     */
    expireDue(now?: number): Promise<number>;
    /** 投影只读快照(全量,不含 body)。 */
    projectionSnapshot(): {
        count: number;
        openCount: number;
        slots: SlotView[];
    };
    /**
     * 锁内 RMW 写盘 + rev 单调递增(文件层加固 T4.7)。
     *
     * `rev` 在这里多担一个职责:**并发冲突判据**。锁保证"读-算-写"不交错,
     * 但本进程的内存态仍可能是旧的(别人在我上次读之后写过)——比较磁盘 rev 与
     * `baseRev` 能发现这件事,此时**拒绝写入**并让调用方看到失败,而不是把别人的
     * 更新整块盖掉(丢更新)或假装成功。
     */
    private persist;
    static pathFor(dataDir: string): string;
}
