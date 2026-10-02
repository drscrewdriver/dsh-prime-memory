import type { MemoryLogger } from '../types.js';
/** 版本常量(file-versions 同款集中纪律;registry 为独立 sidecar 文件)。 */
export declare const ROOMS_REGISTRY_FILE_VERSION: 1;
export interface RoomRegistryEntry {
    /** Room slug(小写字母数字连字符;与自生长 tags 同域,isTag 校验)。 */
    slug: string;
    /** 人类可读名(面板/标注器提示;可中文)。 */
    label?: string;
    /** 归类说明(喂标注器,对 LLM 归类价值最高)。 */
    description?: string;
    /** 来源:pre-registered(预注册)| grown(从自生长 slug 收编)。 */
    source: 'pre-registered' | 'grown';
    /** 合并/改名时的旧 slug(标注器与导出消歧;不参与 list({tag}) 查询)。 */
    aliases?: string[];
    status: 'active' | 'retired';
    createdAt: string;
    updatedAt: string;
}
export type RoomRegistryInput = Pick<RoomRegistryEntry, 'slug'> & Partial<Pick<RoomRegistryEntry, 'label' | 'description' | 'source' | 'aliases'>>;
/**
 * 两级 Room slug(`major` 或 `major/minor`):事实源在 metadata-validators.ts
 * (normTags 写回闸同源放行),此处 re-export 兼容既有导入。
 */
export { isRoomSlug } from '../metadata-validators.js';
/** 大类归属:`major/minor` 取 major;平级 slug 自身即大类。 */
export declare function majorOf(slug: string): string;
export declare class RoomRegistryStore {
    private readonly logger?;
    private readonly file;
    private entries;
    private rev;
    private loaded;
    private degraded;
    private degradedLogged;
    private writeChain;
    constructor(dataDir: string, logger?: MemoryLogger | undefined);
    /** 载入(启动时 await 一次)。缺失 = 合法空表;损坏/不可读 = 只读降级(回退自生长目录)。 */
    init(): Promise<void>;
    private ensureLoaded;
    /** 全量条目(含 retired;副本返回,活引用纪律)。 */
    list(): RoomRegistryEntry[];
    /** active 条目(rooms-get 合并与标注器词表来源)。 */
    listActive(): RoomRegistryEntry[];
    /** 精确 slug 查找(含 retired;含别名命中)。 */
    bySlug(slug: string): RoomRegistryEntry | undefined;
    /** 注册(幂等:已存在——含别名命中——时原地补全 label/description,不新建)。上限 200 防刷。 */
    register(input: RoomRegistryInput): Promise<{
        entry: RoomRegistryEntry;
        created: boolean;
    }>;
    /** 编辑已有条目的 label/description(注册后可重编辑;未提供的字段不动;未找到=false)。 */
    update(slug: string, patch: {
        label?: string;
        description?: string;
    }): Promise<boolean>;
    /** 改状态(active↔retired);无变化返回 false。 */
    setStatus(slug: string, status: 'active' | 'retired'): Promise<boolean>;
    /** 改名(merge 1:1 收尾):slug 换名 + 旧 slug 进 aliases。新名与既有条目冲突时走 merge。
     *  目标用两级制词表(isRoomSlug)——把 standalone room 归类到 hall 下(改名 major/minor)
     *  走的就是这条路;isTag 会误拒带 slash 的目标。 */
    renameSlug(oldSlug: string, newSlug: string): Promise<boolean>;
    /** 合并收尾:fromSlug 条目转 retired + toSlug 进 aliases(记录重写由调用方游标执行)。 */
    markMerged(fromSlug: string, toSlug: string): Promise<boolean>;
    /** 写穿持久化(串行链;失败降级内存态并告警一次)。 */
    private persist;
}
