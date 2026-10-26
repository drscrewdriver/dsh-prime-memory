import { drscRoleOf } from '../clients/drsc.js';
/** L0 记录 → 事实消息（角色/内容过滤与 `groupL0Sessions` 同口径）。 */
function factMessageOf(rec) {
    const id = typeof rec.id === 'string' ? rec.id : '';
    if (id === '')
        return undefined;
    const role = rec.role === 'user' || rec.role === 'assistant' ? rec.role : undefined;
    if (role === undefined)
        return undefined;
    const content = typeof rec.content === 'string' ? rec.content : '';
    if (content.trim() === '')
        return undefined;
    return {
        id,
        sessionId: typeof rec.sessionId === 'string' && rec.sessionId !== '' ? rec.sessionId : 'default',
        role,
        content,
        timestamp: typeof rec.timestamp === 'number' && Number.isFinite(rec.timestamp) ? rec.timestamp : 0,
    };
}
/**
 * 把一批事实消息按会话分组（纯函数）。
 *
 * 保留这个签名是因为它有两个真实用途：① 本地实现按"一次全量"路径时可复用；
 * ② 测试要能直接断言分组与排序语义而不必起 provider。生产路径用 `chunks()` 流式，
 * 不经过这里 —— 否则又把全量正文攒回内存了。
 *
 * **仍然做归一 + 过滤**（与迁移前同口径）：入参允许是原始 L0 行，非法行（id 空、
 * role 非 user/assistant、正文空）一律丢弃。过滤不能只留在 provider 里，
 * 否则任何直接调本函数的调用方（含测试夹具）都得自己重复一遍。
 */
export function groupL0Sessions(
// 入参保持宽松：原始 L0 行（多带 recordedAt/turn/step）与 FactMessage 都能喂。
records) {
    const bySession = new Map();
    for (const raw of records) {
        const msg = factMessageOf(raw);
        if (msg === undefined)
            continue;
        const arr = bySession.get(msg.sessionId) ?? [];
        arr.push({ id: msg.id, role: msg.role, content: msg.content, timestamp: msg.timestamp });
        bySession.set(msg.sessionId, arr);
    }
    const chunks = [];
    for (const [sessionId, messages] of bySession) {
        messages.sort((a, b) => a.timestamp - b.timestamp);
        chunks.push({ sessionId, messages });
    }
    // 会话按首条消息时间升序:情境链按时间顺序衔接(与原始发生顺序一致)
    chunks.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);
    return chunks;
}
/** 本地 L0 事实源（默认）：已停写的冻结存量，读面走会话点查避免全量驻留。 */
export class LocalL0FactSource {
    db;
    logger;
    kind = 'l0-local';
    constructor(db, logger) {
        this.db = db;
        this.logger = logger;
    }
    estimate() {
        const est = this.db.l0RebuildEstimate();
        return { ...est, known: true };
    }
    async prepare() {
        return this.estimate();
    }
    coverage() {
        const wm = this.db.rebuildWatermark();
        return { untilIso: wm.l0Iso, sessions: wm.l0SessionCount };
    }
    async snapshotIds() {
        // 只读 record_id 列，不碰正文 —— 这是"不发 88MB 也要能判 post-watermark"的关键。
        return this.db.l0MessageIds();
    }
    async *snapshot() {
        for (const sessionId of this.db.l0SessionIds()) {
            for (const rec of this.db.l0MessagesBySession(sessionId)) {
                const msg = factMessageOf({ ...rec, id: rec.id });
                if (msg !== undefined)
                    yield msg;
            }
        }
    }
    async *chunks() {
        const sessions = this.db.l0SessionIds();
        this.logger.debug?.(`[memory] 重建事实源：本地 L0，${sessions.length} 个会话（按会话流式读）`);
        for (const sessionId of sessions) {
            const messages = [];
            for (const rec of this.db.l0MessagesBySession(sessionId)) {
                const msg = factMessageOf({ ...rec, id: rec.id });
                if (msg !== undefined)
                    messages.push({ id: msg.id, role: msg.role, content: msg.content, timestamp: msg.timestamp });
            }
            if (messages.length > 0)
                yield { sessionId, messages };
        }
    }
}
/**
 * DRSC 事实源（实验性，默认不用）：枚举会话 → 逐会话拉全量。
 *
 * 顺序说明：collector 的 `op=sessions` 按 `last_time_ms` **降序**返回，这里显式反转成
 * 升序，与本地实现的"会话按首条时间升序"对齐（上下文链的衔接方向一致）。
 */
export class DrscFactSource {
    client;
    logger;
    pageSize;
    kind = 'drsc';
    constructor(client, logger, 
    /** 会话分页大小（collector 侧钳 1..500）。 */
    pageSize = 200) {
        this.client = client;
        this.logger = logger;
        this.pageSize = pageSize;
    }
    estimate() {
        // 同步拿不到（要发请求）。known=false 让调用方跳过同步前置门，
        // 真正的“空事实源”判定落在 prepare 的会话数上。
        return { sessions: 0, messages: 0, chars: 0, known: false };
    }
    /** 会话枚举缓存（prepare 拉一次，chunks/snapshot 复用，不重复请求）。 */
    sessionsCache = null;
    async prepare() {
        this.sessionsCache = await this.listAllSessions();
        return { sessions: this.sessionsCache.length, messages: 0, chars: 0, known: true };
    }
    coverage() {
        return { untilIso: null, sessions: 0 };
    }
    async snapshotIds() {
        this.logger.warn('[memory] DRSC 事实源无法枚举消息 id（drsc:<sid>:<seq> 与 source_message_ids 不同域）——'
            + '本轮重建会把所有有来源的记忆判为不可重蒸并原样保留（保守侧失败，不丢数据）');
        return new Set();
    }
    async listAllSessions() {
        const ids = [];
        let offset = 0;
        for (;;) {
            const page = await this.client.listSessions(offset, this.pageSize);
            for (const row of page.rows) {
                if (typeof row.session_id === 'string' && row.session_id !== '') {
                    ids.push({ id: row.session_id, last: row.last_time_ms });
                }
            }
            offset += page.rows.length;
            if (page.rows.length === 0 || offset >= page.total)
                break;
        }
        // 反转 collector 的 last_time_ms 降序 → 升序（见类注释）
        return ids.sort((a, b) => a.last - b.last).map((r) => r.id);
    }
    async sessions() {
        if (this.sessionsCache !== null)
            return this.sessionsCache;
        this.sessionsCache = await this.listAllSessions();
        return this.sessionsCache;
    }
    async *snapshot() {
        for (const sessionId of await this.sessions()) {
            for (const row of await this.client.sessionAll(sessionId)) {
                const role = drscRoleOf(row.kind);
                if (role === undefined)
                    continue;
                if (row.text.trim() === '')
                    continue;
                yield { id: `drsc:${sessionId}:${row.seq}`, sessionId, role, content: row.text, timestamp: row.time };
            }
        }
    }
    async *chunks() {
        const sessions = await this.sessions();
        this.logger.info(`[memory] 重建事实源：DRSC，${sessions.length} 个会话（逐会话拉全量，redact=1）`);
        for (const sessionId of sessions) {
            const rows = await this.client.sessionAll(sessionId);
            const messages = [];
            for (const row of rows) {
                const role = drscRoleOf(row.kind);
                if (role === undefined)
                    continue;
                if (row.text.trim() === '')
                    continue;
                messages.push({ id: `drsc:${sessionId}:${row.seq}`, role, content: row.text, timestamp: row.time });
            }
            messages.sort((a, b) => a.timestamp - b.timestamp);
            if (messages.length > 0)
                yield { sessionId, messages };
        }
    }
}
