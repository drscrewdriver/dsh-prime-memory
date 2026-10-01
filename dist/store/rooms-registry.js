/**
 * Room 注册表(预注册词表,分类管理 beta.4)。
 *
 * 动机:Room 此前纯自生长(metadata.tags 涌现),tags 标注器不参考词表——
 * 「81 个 Room 大多 1 条」的碎片化即来源于此。注册表让「策划好的分类」先行:
 * 候选标注器与 tags 标注器优先挂靠注册表 slug;零计数注册条目也进词表。
 *
 * 存储:slots 式 sidecar(`rooms-registry.json`),全量载入内存 + 写穿原子持久化,
 * `rev` 乐观观察计数。**读侧分类**(occupancy 同款):文件缺失 = 合法空表;
 * 损坏/不可读 → 告警 + 只读降级(内存态照常生效,停止回写)——降级即**回退纯
 * 自生长目录**,绝不阻塞 rooms-get / 标注器(R2 红线)。
 */
import * as path from 'node:path';
import { isTag } from '../metadata-validators.js';
import { readJsonStrict, atomicWriteText, ensureDir } from '../util/io.js';
/** 版本常量(file-versions 同款集中纪律;registry 为独立 sidecar 文件)。 */
export const ROOMS_REGISTRY_FILE_VERSION = 1;
/** 大类(顶层)注册上限(防刷)。小类(`major/minor`)不占大类额度,另有总量保险。 */
const REGISTRY_MAJOR_CAP = 200;
/** 全量保险上限(大类+小类总和;防极端滥用)。 */
const REGISTRY_TOTAL_CAP = 2000;
/**
 * 两级 Room slug:`major` 或 `major/minor`(如 `dsh-plugin`、`dsh-plugin/merge`)。
 * 两段各自满足 isTag 词表;小类归属其大类。
 */
export function isRoomSlug(v) {
    if (typeof v !== 'string')
        return false;
    const parts = v.split('/');
    if (parts.length > 2)
        return false;
    return parts.every((p) => isTag(p));
}
/** 大类归属:`major/minor` 取 major;平级 slug 自身即大类。 */
export function majorOf(slug) {
    const i = slug.indexOf('/');
    return i === -1 ? slug : slug.slice(0, i);
}
/** aliases 上限(合并/改名历史)。 */
const ALIASES_CAP = 16;
export class RoomRegistryStore {
    logger;
    file;
    entries = [];
    rev = 0;
    loaded = false;
    degraded;
    degradedLogged = false;
    writeChain = Promise.resolve();
    constructor(dataDir, logger) {
        this.logger = logger;
        this.file = path.join(dataDir, 'rooms-registry.json');
    }
    /** 载入(启动时 await 一次)。缺失 = 合法空表;损坏/不可读 = 只读降级(回退自生长目录)。 */
    async init() {
        await ensureDir(path.dirname(this.file));
        const read = await readJsonStrict(this.file);
        if (!read.ok) {
            if (read.reason !== 'missing') {
                this.degraded = `${read.reason}${'detail' in read && read.detail ? `: ${read.detail}` : ''}`;
                this.logger?.warn(`[memory] Room 注册表只读降级(回退纯自生长目录): ${this.degraded}`);
            }
            this.loaded = true;
            return;
        }
        if (read.value.version !== ROOMS_REGISTRY_FILE_VERSION) {
            this.logger?.warn(`[memory] Room 注册表版本 ${String(read.value.version)} 未知,按当前形状读取`);
        }
        const rooms = Array.isArray(read.value.rooms) ? read.value.rooms : [];
        for (const r of rooms) {
            if (!r || typeof r.slug !== 'string' || !isTag(r.slug))
                continue; // 非法 slug 丢弃(session-modes 同款纪律)
            this.entries.push({
                slug: r.slug,
                label: typeof r.label === 'string' ? r.label : undefined,
                description: typeof r.description === 'string' ? r.description : undefined,
                source: r.source === 'grown' ? 'grown' : 'pre-registered',
                aliases: Array.isArray(r.aliases) ? r.aliases.filter((a) => typeof a === 'string' && a !== '') : undefined,
                status: r.status === 'retired' ? 'retired' : 'active',
                createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
                updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
            });
        }
        this.rev = typeof read.value.rev === 'number' ? read.value.rev : 0;
        this.loaded = true;
    }
    ensureLoaded() {
        if (!this.loaded)
            throw new Error('Room 注册表未初始化(先 await init())');
    }
    /** 全量条目(含 retired;副本返回,活引用纪律)。 */
    list() {
        this.ensureLoaded();
        return this.entries.map((e) => ({ ...e }));
    }
    /** active 条目(rooms-get 合并与标注器词表来源)。 */
    listActive() {
        return this.list().filter((e) => e.status === 'active');
    }
    /** 精确 slug 查找(含 retired;含别名命中)。 */
    bySlug(slug) {
        this.ensureLoaded();
        const found = this.entries.find((e) => e.slug === slug || (e.aliases ?? []).includes(slug));
        return found ? { ...found } : undefined;
    }
    /** 注册(幂等:已存在——含别名命中——时原地补全 label/description,不新建)。上限 200 防刷。 */
    async register(input) {
        this.ensureLoaded();
        const slug = String(input.slug ?? '').trim().toLowerCase();
        if (!slug || !isRoomSlug(slug)) {
            throw new Error(`非法 Room slug: ${String(input.slug)}(两级制:major 或 major/minor,各段小写字母数字连字符)`);
        }
        const found = this.entries.find((e) => e.slug === slug || (e.aliases ?? []).includes(slug));
        if (found) {
            let changed = false;
            if (!found.label && typeof input.label === 'string' && input.label.trim()) {
                found.label = input.label.trim().slice(0, 60);
                changed = true;
            }
            if (!found.description && typeof input.description === 'string' && input.description.trim()) {
                found.description = input.description.trim().slice(0, 300);
                changed = true;
            }
            if (changed) {
                found.updatedAt = new Date().toISOString();
                this.rev++;
                await this.persist();
            }
            return { entry: { ...found }, created: false };
        }
        // 额度两级制(用户裁定:200 上限只管大类;小类细分不占大类额度):
        // 大类 = slug 无 '/' 的条目 ∪ 已用 major 前缀;小类只受总量保险约束。
        const isMinor = slug.includes('/');
        if (isMinor && this.entries.length >= REGISTRY_TOTAL_CAP) {
            throw new Error(`Room 注册表总量已达上限(${REGISTRY_TOTAL_CAP}),请先合并/退役部分条目`);
        }
        if (!isMinor) {
            const majors = new Set(this.entries.map((e) => majorOf(e.slug)));
            if (!majors.has(slug) && majors.size >= REGISTRY_MAJOR_CAP) {
                throw new Error(`大类已达上限(${REGISTRY_MAJOR_CAP}):请用「大类/小类」细分(如 ${slug}/子项),或合并/退役部分大类`);
            }
        }
        const now = new Date().toISOString();
        const entry = {
            slug,
            label: typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 60) : undefined,
            description: typeof input.description === 'string' && input.description.trim()
                ? input.description.trim().slice(0, 300)
                : undefined,
            source: input.source === 'grown' ? 'grown' : 'pre-registered',
            aliases: Array.isArray(input.aliases) && input.aliases.length > 0 ? input.aliases.slice(0, ALIASES_CAP) : undefined,
            status: 'active',
            createdAt: now,
            updatedAt: now,
        };
        this.entries.push(entry);
        this.rev++;
        await this.persist();
        return { entry: { ...entry }, created: true };
    }
    /** 改状态(active↔retired);无变化返回 false。 */
    async setStatus(slug, status) {
        this.ensureLoaded();
        const found = this.entries.find((e) => e.slug === slug);
        if (!found || found.status === status)
            return false;
        found.status = status;
        found.updatedAt = new Date().toISOString();
        this.rev++;
        await this.persist();
        return true;
    }
    /** 改名(merge 1:1 收尾):slug 换名 + 旧 slug 进 aliases。新名与既有条目冲突时走 merge。
     *  目标用两级制词表(isRoomSlug)——把 standalone room 归类到 hall 下(改名 major/minor)
     *  走的就是这条路;isTag 会误拒带 slash 的目标。 */
    async renameSlug(oldSlug, newSlug) {
        this.ensureLoaded();
        if (!isRoomSlug(newSlug))
            throw new Error(`非法 Room slug: ${newSlug}(两级制:major 或 major/minor)`);
        const found = this.entries.find((e) => e.slug === oldSlug);
        if (!found)
            return false;
        if (this.entries.some((e) => e.slug === newSlug)) {
            throw new Error(`目标 slug 已存在: ${newSlug}(应走 merge 而非 rename)`);
        }
        found.slug = newSlug;
        found.aliases = [...new Set([...(found.aliases ?? []), oldSlug])].slice(0, ALIASES_CAP);
        found.updatedAt = new Date().toISOString();
        this.rev++;
        await this.persist();
        return true;
    }
    /** 合并收尾:fromSlug 条目转 retired + toSlug 进 aliases(记录重写由调用方游标执行)。 */
    async markMerged(fromSlug, toSlug) {
        this.ensureLoaded();
        const found = this.entries.find((e) => e.slug === fromSlug);
        if (!found)
            return false;
        found.status = 'retired';
        const target = this.entries.find((e) => e.slug === toSlug);
        if (target) {
            target.aliases = [...new Set([...(target.aliases ?? []), fromSlug])].slice(0, ALIASES_CAP);
            target.updatedAt = new Date().toISOString();
        }
        found.updatedAt = new Date().toISOString();
        this.rev++;
        await this.persist();
        return true;
    }
    /** 写穿持久化(串行链;失败降级内存态并告警一次)。 */
    async persist() {
        if (this.degraded)
            return;
        this.writeChain = this.writeChain.then(async () => {
            const data = {
                version: ROOMS_REGISTRY_FILE_VERSION,
                rev: this.rev + 1,
                rooms: this.entries,
            };
            try {
                await ensureDir(path.dirname(this.file));
                await atomicWriteText(this.file, JSON.stringify(data, null, 2));
                this.rev = data.rev;
            }
            catch (err) {
                this.degraded = err instanceof Error ? err.message : String(err);
                if (!this.degradedLogged) {
                    this.degradedLogged = true;
                    this.logger?.warn(`[memory] Room 注册表写入失败,只读降级: ${this.degraded}`);
                }
            }
        });
        await this.writeChain;
    }
}
