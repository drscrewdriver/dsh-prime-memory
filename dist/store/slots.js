/**
 * 激活槽位(active slot)持久化层。
 *
 * 槽位是可跨会话持久化的结构化提示:规则 / 待办 / 锚点 / 指针。pinned 的 open
 * 槽位会被常驻注入每轮对话上下文(prepended 到 agent/pre-step),根治"网络规则等
 * 显式约定不被召回"的问题。存储独立于 state.json(槽位高频小改 vs checkpoint
 * 低频),复用 util/io.ts 的 atomicWriteJson 保证原子写。
 *
 * 活引用约定:本类内部只原地改 `this.slots` 数组元素,list()/open()/projectionSnapshot()
 * 返回副本或只读投影,持有方拿到的引用不会因 mutate 失效(对齐 StateStore.reset() 的教训)。
 */
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWriteJson, readJsonIfExists, nowIso } from '../util/io.js';
/**
 * 槽位类型全集。**单一所有者**:投影片注册的 schema 校验也从这里取枚举,
 * 避免"store 加了新 kind、投影 schema 没跟上"导致 drive 期 parse 抛错。
 */
export const SLOT_KINDS = ['rule', 'todo', 'anchor', 'pointer'];
/** 槽位状态全集(单一所有者,同 SLOT_KINDS)。 */
export const SLOT_STATUSES = ['open', 'done', 'dropped', 'expired'];
const KIND_SET = new Set(SLOT_KINDS);
const STATUS_SET = new Set(SLOT_STATUSES);
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
    let time = Date.now();
    let timeStr = '';
    for (let i = 0; i < 10; i++) {
        timeStr = ULID_ENCODING[time % 32] + timeStr;
        time = Math.floor(time / 32);
    }
    const bytes = randomBytes(16);
    let randStr = '';
    for (let i = 0; i < 16; i++)
        randStr += ULID_ENCODING[bytes[i] % 32];
    return timeStr + randStr;
}
function byteLen(s) {
    // Buffer 在 Node 运行时全局可用;按 UTF-8 计字节,对齐 maxAlwaysOnBytes 的"字节"语义
    return Buffer.byteLength(s, 'utf8');
}
function clampPriority(n) {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 50;
    return Math.max(0, Math.min(100, v));
}
function normalizeKind(k) {
    return typeof k === 'string' && KIND_SET.has(k) ? k : 'rule';
}
function normalizeStatus(s, fallback = 'open') {
    return typeof s === 'string' && STATUS_SET.has(s) ? s : fallback;
}
function clone(s) {
    return { ...s, refs: [...s.refs] };
}
/** 宽容读盘:缺字段补默认,非法条目丢弃(不抛错,不阻断插件)。 */
function fromFile(raw) {
    if (!raw || typeof raw !== 'object')
        return { slots: [], rev: 0 };
    const obj = raw;
    const arr = Array.isArray(obj.slots) ? obj.slots : [];
    const slots = [];
    for (const item of arr) {
        if (!item || typeof item !== 'object')
            continue;
        const s = item;
        if (typeof s.id !== 'string' || typeof s.title !== 'string')
            continue;
        slots.push({
            id: s.id,
            title: s.title,
            kind: normalizeKind(s.kind),
            status: normalizeStatus(s.status, 'open'),
            priority: clampPriority(s.priority),
            body: typeof s.body === 'string' ? s.body : '',
            refs: Array.isArray(s.refs) ? s.refs.filter((r) => typeof r === 'string') : [],
            pinned: s.pinned === true,
            validUntil: typeof s.validUntil === 'string' ? s.validUntil : undefined,
            origin: s.origin === 'agent' ? 'agent' : 'user',
            createdAt: typeof s.createdAt === 'string' ? s.createdAt : nowIso(),
            updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : nowIso(),
        });
    }
    const rev = typeof obj.rev === 'number' && obj.rev >= 0 ? obj.rev : 0;
    return { slots, rev };
}
export class SlotStore {
    file;
    logger;
    /** 活引用:数组本身稳定,元素原地改;外部持有者不会因 mutate 拿到孤儿。 */
    slots = [];
    rev = 0;
    maxSlots;
    maxBodyChars;
    maxTitleChars;
    constructor(file, logger, opts = {}) {
        this.file = file;
        this.logger = logger;
        this.maxSlots = opts.maxSlots ?? 8;
        this.maxBodyChars = opts.maxBodyChars ?? 512;
        this.maxTitleChars = opts.maxTitleChars ?? 60;
    }
    /** 读回持久态;文件缺失/损坏时用默认空态,不抛错。 */
    async load() {
        const raw = await readJsonIfExists(this.file);
        if (!raw)
            return;
        const { slots, rev } = fromFile(raw);
        this.slots = slots;
        this.rev = rev;
    }
    /** 同步读内存,返回副本(不泄漏内部数组)。 */
    list() {
        return this.slots.map(clone);
    }
    /** 同步读内存,仅 open 槽位副本。 */
    open() {
        return this.slots.filter((s) => s.status === 'open').map(clone);
    }
    /** 按 id 取单个槽位副本(不存在返回 undefined)——close 工具关闭前读 refs 用。 */
    get(id) {
        const slot = this.slots.find((s) => s.id === id);
        return slot ? clone(slot) : undefined;
    }
    /** 当前版本号(投影 apply 的判脏依据)。 */
    revision() {
        return this.rev;
    }
    /** 总数(投影 count 用)。 */
    count() {
        return this.slots.length;
    }
    /** open 数(投影 openCount 用)。 */
    openCount() {
        return this.slots.filter((s) => s.status === 'open').length;
    }
    /**
     * 写入一个新槽位(insert-only:SlotInput 无 id,upsert 之名对应"无则建")。
     * 超限直接抛错(不静默丢弃),调用方转成工具 notice。
     */
    async upsert(input) {
        const title = String(input.title ?? '').trim();
        if (!title)
            throw new Error('slot.title 不能为空');
        if (this.slots.length >= this.maxSlots) {
            throw new Error(`槽位数量已达上限(${this.maxSlots}),无法新增;请先关闭部分槽位(memory_slot_close)`);
        }
        const now = nowIso();
        const slot = {
            id: `slot_${ulid()}`,
            title: title.slice(0, this.maxTitleChars),
            kind: normalizeKind(input.kind),
            status: normalizeStatus(input.status, 'open'),
            priority: clampPriority(input.priority),
            body: String(input.body ?? '').slice(0, this.maxBodyChars),
            refs: Array.isArray(input.refs)
                ? input.refs.filter((r) => typeof r === 'string').map((r) => r.slice(0, 512)).slice(0, 32)
                : [],
            pinned: input.pinned === true,
            validUntil: typeof input.validUntil === 'string' && input.validUntil.trim()
                ? input.validUntil.trim()
                : undefined,
            origin: input.origin === 'agent' ? 'agent' : 'user',
            createdAt: now,
            updatedAt: now,
        };
        // 不允许直接写入过期态(过期只由 expireDue 机械产生)
        if (slot.status === 'expired')
            slot.status = 'open';
        this.slots.push(slot);
        await this.persist();
        return clone(slot);
    }
    /** 关闭槽位(标记 done/dropped)。不存在返回 false。 */
    async close(id, status) {
        const slot = this.slots.find((s) => s.id === id);
        if (!slot)
            return false;
        slot.status = status;
        slot.updatedAt = nowIso();
        await this.persist();
        return true;
    }
    /**
     * 常驻注入选材:pinned && open,按 priority 降序,累计字节 ≤ maxBytes。
     * 至少保留 1 条(即便单条超预算,避免"写了却永远看不到");其余超预算的计入
     * truncatedCount,供注入尾部补 "+N more"(预算静默丢弃会让槽位"看起来写了没生效")。
     */
    alwaysOn(maxBytes) {
        const pinnedOpen = this.slots
            .filter((s) => s.pinned && s.status === 'open')
            .sort((a, b) => b.priority - a.priority);
        const picked = [];
        let used = 0;
        for (const s of pinnedOpen) {
            const cost = byteLen(s.title) + 1 + byteLen(s.body);
            // 第一条总是保留(保证可见性);之后超预算即停止
            if (picked.length > 0 && used + cost > maxBytes)
                break;
            picked.push(s);
            used += cost;
        }
        return { slots: picked.map(clone), truncatedCount: pinnedOpen.length - picked.length };
    }
    /**
     * 机械过期:validUntil ≤ now 的 open 槽位置为 expired。纯比较,不触发任何 LLM。
     * 返回过期条数。
     */
    async expireDue(now = Date.now()) {
        let n = 0;
        for (const s of this.slots) {
            if (s.status === 'open' && s.validUntil) {
                const t = Date.parse(s.validUntil);
                if (!Number.isNaN(t) && t <= now) {
                    s.status = 'expired';
                    s.updatedAt = nowIso();
                    n++;
                }
            }
        }
        if (n > 0)
            await this.persist();
        return n;
    }
    /** 投影只读快照(全量,不含 body)。 */
    projectionSnapshot() {
        return {
            count: this.slots.length,
            openCount: this.slots.filter((s) => s.status === 'open').length,
            slots: this.slots.map((s) => ({
                id: s.id,
                title: s.title,
                kind: s.kind,
                status: s.status,
                priority: s.priority,
            })),
        };
    }
    /** 原子写盘 + rev 单调递增。 */
    async persist() {
        this.rev += 1;
        const file = { version: 1, rev: this.rev, slots: this.slots };
        try {
            await atomicWriteJson(this.file, file);
        }
        catch (err) {
            // 写盘失败只告警,不阻断调用方(降级:内存态已更新,下次写会重试)
            this.logger.warn(`[memory] 槽位持久化失败(内存态已更新): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    static pathFor(dataDir) {
        return path.join(dataDir, 'slots.json');
    }
}
