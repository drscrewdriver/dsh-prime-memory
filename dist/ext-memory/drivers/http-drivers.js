/**
 * 六家 HTTP 记忆服务驱动(计划 T1.1-T1.6)。
 *
 * 端点/载荷/字段映射逐条移植自参考实现各 provider 的 driver.ts(已实测的契约),
 * 剥掉 Memory Spaces 的 authority/registration 耦合。**Phase 1 只读构建**:
 * - `search`/`status` 为真实实现(lane 与探活只吃这两个);
 * - 写侧(remember/forget)返回显式 failed 回执、拉取读侧(list/graph/sincePull)
 *   抛「Phase 3 接入」错——方法在场满足 assertRuntime,语义上绝不静默半实现
 *   (参考实现的教训:假成功比明错贵得多)。
 *
 * 鉴权头形态各家不一(mem0 `Token`、hindsight/honcho/openviking/supermemory
 * `Bearer`、retaindb 双挂),这里不合并——每种都是对应服务实测的形态,统一即破坏。
 */
import { randomUUID } from 'node:crypto';
import { EXT_DRIVER_SPECS } from '../types.js';
import { httpJson, baseUrlOf } from '../http.js';
import { READ_ONLY_RECEIPT, ExtCapabilityMissingError, firstArray, obj, str, num, clampInt } from '../util.js';
/**
 * 共享骨架。capabilities/scoreSemantics 走 **getter**:基类字段初始化发生在
 * 子类 `readonly typeId = ...` 赋值之前(TDZ),getter 延迟到构造完成后求值,
 * assertRuntime/调用方拿到的永远是终态。子类只写各家差异(路径/载荷/映射)。
 */
class HttpExtDriver {
    id;
    get capabilities() {
        return EXT_DRIVER_SPECS[this.typeId].capabilities;
    }
    get scoreSemantics() {
        return EXT_DRIVER_SPECS[this.typeId].scoreSemantics;
    }
    http;
    conn;
    constructor(id, input) {
        this.id = id;
        this.conn = input.connection;
        this.http = {
            label: `${this.id}`,
            fetch: input.fetch ?? globalThis.fetch,
            timeoutMs: input.requestTimeoutMs,
        };
    }
    base() {
        return baseUrlOf(this.http.label, this.conn);
    }
    /** connection 字段取串(extra JSON 已被装配层平铺进 connection,空值给缺省)。 */
    extra(key, dflt = '') {
        return String(this.conn[key] ?? dflt);
    }
    /** 默认探活:廉价 search(limit 1)通了就算健康(mem0/honcho/retaindb/supermemory 同款)。 */
    async status(signal) {
        try {
            await this.search(this.defaultSpace(), { query: 'health', limit: 1 }, signal);
            return { healthy: true };
        }
        catch (err) {
            return { healthy: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    /** config 的 space 字段 = 服务端 namespace;缺省 'main'(单空间部署常态)。 */
    defaultSpace() {
        const externalId = this.extra('space') || 'main';
        return { spaceId: `${this.id}:${externalId}`, driverId: this.id, externalId, name: externalId, description: '' };
    }
    // ── 未实装能力的哨兵桩 ──
    // 写侧：返回 failed 回执而不静默半实现（现六家均已 override，桩作为契约保留）。
    async remember(_space, _item, _signal) {
        return { ...READ_ONLY_RECEIPT };
    }
    async forget(_space, _externalId, _signal) {
        return { ...READ_ONLY_RECEIPT };
    }
    // 读侧：抛 ExtCapabilityMissingError 而不是普通 Error——调用方（puller）必须能区分
    // “该家没接这个端点”（→ 降级或如实置灰）与“远端真故障”（→ 计失败，不得静默重拉）。
    // `sincePull` 桩已删除：没有任何一家接了游标（incremental 全 false），留着它只会把
    // “方法存在”变成恒真判据——那是旧版拉取方向 0 家能跑通的根因。
    async list(_space, _req, _signal) {
        throw new ExtCapabilityMissingError('list', '浏览(list)');
    }
    async graph(_space, _signal) {
        throw new ExtCapabilityMissingError('graph', '图谱(graph)');
    }
    async discover(_conn, _signal) {
        throw new ExtCapabilityMissingError('discover', '空间发现(discover)');
    }
    mapAll(payload, space, toHit, limit) {
        return firstArray(payload, 'results', 'memories', 'items')
            .map((v) => toHit(v, space, this.id))
            .filter((h) => h !== undefined)
            .slice(0, limit);
    }
    /**
     * 分页映射：`hits` 按 limit 截断，`hasMore` 优先取**服务端事实**。
     *
     * 有总数（total / total_count / pagination.total）时按 `offset + 已取 < 总数` 判；
     * 没有总数时保守取“本页满即可能还有”——宁可末尾多发一次空请求，也不能提前停手漏条目：
     * 漏掉的条目会永远不进本地库，而多发一次请求只是多一个往返。两者不是同量级的错。
     */
    mapPage(payload, space, toHit, limit, offset) {
        const all = firstArray(payload, 'results', 'memories', 'items')
            .map((v) => toHit(v, space, this.id))
            .filter((h) => h !== undefined);
        const hits = all.slice(0, limit);
        const total = totalOf(payload);
        return { hits, hasMore: total === undefined ? all.length >= limit : offset + hits.length < total };
    }
}
/** 服务端总数（各家字段名不统一，逐个探）；拿不到返回 undefined 交给保守判据。 */
function totalOf(payload) {
    const o = obj(payload);
    const direct = num(o?.total) ?? num(o?.total_count) ?? num(o?.totalCount);
    if (direct !== undefined)
        return direct;
    const pg = obj(o?.pagination) ?? obj(o?.page_info);
    return num(pg?.total) ?? num(pg?.totalItems) ?? undefined;
}
/** mem0:platform(`Token` 头,/v3 路径)与 self-hosted(`X-API-Key`,裸路径)双形态。 */
class Mem0Driver extends HttpExtDriver {
    typeId = 'mem0';
    mode() {
        return this.extra('mode', 'platform');
    }
    headers() {
        const apiKey = this.extra('apiKey').replace(/^(?:Token|Bearer)\s+/iu, '');
        if (apiKey === '')
            return {};
        return this.mode() === 'self-hosted' ? { 'X-API-Key': apiKey } : { Authorization: `Token ${apiKey}` };
    }
    filters() {
        const userId = this.extra('userId', 'dsh-user');
        const agentId = this.extra('agentId', 'dsh');
        return { ...(userId === '' ? {} : { user_id: userId }), ...(agentId === '' ? {} : { agent_id: agentId }) };
    }
    async search(space, q, signal) {
        const limit = clampInt(q.limit, 1, 50, 10);
        const payload = await httpJson(this.http, `${this.base()}${this.mode() === 'self-hosted' ? '/search' : '/v3/memories/search/'}`, { headers: this.headers(), json: { query: q.query, filters: this.filters(), top_k: limit }, signal });
        return { results: this.mapAll(payload, space, mem0Hit, limit), hasMore: false };
    }
    /** Phase 3(hard 五家之一):self-hosted 同步落定;platform 走异步添加(回 event_id 待回捞)。 */
    async remember(space, item, signal) {
        const mode = this.mode();
        const payload = obj(await httpJson(this.http, `${this.base()}${mode === 'self-hosted' ? '/memories' : '/v3/memories/add/'}`, {
            headers: this.headers(),
            json: {
                messages: [{ role: 'user', content: item.content }],
                ...this.filters(),
                ...(mode === 'self-hosted' ? { infer: false } : {}),
                metadata: {
                    source: 'dsh-prime-memory',
                    ...(item.category === undefined ? {} : { category: item.category }),
                    ...(item.importance === undefined ? {} : { importance: item.importance }),
                    ...(item.tags === undefined ? {} : { tags: item.tags }),
                    ...(item.entities === undefined ? {} : { entities: item.entities }),
                },
            },
            signal,
            timeoutMs: 30_000,
        })) ?? {};
        const id = str(payload.id);
        const eventId = str(payload.event_id);
        return mode === 'platform'
            ? { completion: 'accepted', pendingOp: eventId ?? 'queued', ...(id === undefined ? {} : { externalId: id }) }
            : { completion: 'committed', ...(id === undefined ? {} : { externalId: id }) };
    }
    /** hard 删:平台版 /v1/memories/{id},自托管 /memories/{id}(与参考实现双形态对齐)。 */
    async forget(space, externalId, signal) {
        const path = this.mode() === 'self-hosted' ? `/memories/${encodeURIComponent(externalId)}` : `/v1/memories/${encodeURIComponent(externalId)}`;
        await httpJson(this.http, `${this.base()}${path}`, { method: 'DELETE', headers: this.headers(), signal });
        return { completion: 'committed' };
    }
    /**
     * 遍历（参考实现同款双形态）：platform 走 `page/page_size` 并带 filters，
     * self-hosted 走 `limit` + user_id 查询串（该形态无分页参数 → 单页到底）。
     */
    async list(space, req, signal) {
        const limit = clampInt(req.limit, 1, 500, 100);
        const offset = Math.max(0, req.offset ?? 0);
        if (this.mode() === 'self-hosted') {
            const params = new URLSearchParams({ ...this.filters(), limit: String(limit) });
            const payload = await httpJson(this.http, `${this.base()}/memories?${params}`, { headers: this.headers(), signal });
            return this.mapPage(payload, space, mem0Hit, limit, offset);
        }
        const page = 1 + Math.floor(offset / limit);
        const payload = await httpJson(this.http, `${this.base()}/v3/memories/?page=${page}&page_size=${limit}`, { headers: this.headers(), json: { filters: this.filters() }, signal });
        return this.mapPage(payload, space, mem0Hit, limit, offset);
    }
}
function mem0Hit(value, space, driverId) {
    const item = obj(value);
    const externalId = str(item?.id);
    const content = str(item?.memory) ?? str(item?.text) ?? str(item?.content);
    if (externalId === undefined || content === undefined)
        return undefined;
    const categories = firstArray(item?.categories).filter((x) => typeof x === 'string');
    return {
        driverId,
        spaceId: space.spaceId,
        externalId,
        content,
        score: num(item?.score),
        category: str(item?.category) ?? categories[0] ?? 'general',
        tags: categories.length === 0 ? undefined : categories,
        updatedAt: str(item?.created_at) ?? str(item?.createdAt) ?? str(item?.updated_at),
    };
}
/** hindsight:bank-scoped 召回;分数在 scores.final。 */
class HindsightDriver extends HttpExtDriver {
    typeId = 'hindsight';
    headers() {
        const token = this.extra('apiKey').replace(/^Bearer\s+/iu, '');
        return token === '' ? {} : { Authorization: `Bearer ${token}` };
    }
    bankPath(space) {
        return `/v1/default/banks/${encodeURIComponent(space.externalId)}`;
    }
    async status(signal) {
        try {
            await httpJson(this.http, `${this.base()}/health/live`, { headers: this.headers(), signal, timeoutMs: 5000 });
            return { healthy: true };
        }
        catch (err) {
            return { healthy: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    async search(space, q, signal) {
        const limit = clampInt(q.limit, 1, 50, 10);
        const payload = await httpJson(this.http, `${this.base()}${this.bankPath(space)}/memories/recall`, {
            headers: this.headers(),
            json: {
                query: q.query,
                budget: this.extra('budget', 'mid'),
                max_tokens: Math.min(Math.max(limit * 400, 400), 8000),
                types: ['world', 'experience', 'observation'],
                prefer_observations: true,
            },
            signal,
        });
        return { results: this.mapAll(payload, space, hindsightHit, limit), hasMore: false };
    }
    /** Phase 2 实装(soft 三家之一):异步入队,只回 operationId——awaiting-settle 回捞。 */
    async remember(space, item, signal) {
        const operationId = randomUUID();
        const payload = obj(await httpJson(this.http, `${this.base()}${this.bankPath(space)}/memories`, {
            headers: this.headers(),
            json: {
                items: [{
                        content: item.content,
                        context: item.category ?? 'dsh-prime-memory',
                        metadata: { source: 'dsh-prime-memory' },
                        ...(item.tags === undefined || item.tags.length === 0 ? {} : { tags: item.tags }),
                        ...(item.entities === undefined || item.entities.length === 0 ? {} : { entities: item.entities.map((text) => ({ text })) }),
                    }],
                async: true,
                operation_id: operationId,
            },
            signal,
            timeoutMs: 30_000,
        })) ?? {};
        return { completion: 'accepted', pendingOp: str(payload.operation_id) ?? operationId };
    }
    /** soft 删除 = PATCH state:'invalidated'(可回滚,与本地退场语义天然对齐)。 */
    async forget(space, externalId, signal) {
        await httpJson(this.http, `${this.base()}${this.bankPath(space)}/memories/${encodeURIComponent(externalId)}`, { method: 'PATCH', headers: this.headers(), json: { state: 'invalidated', reason: 'Retired from dsh-prime-memory' }, signal });
        return { completion: 'committed' };
    }
    /** settle 回捞面 + Phase 3 拉取底座:state=valid 列表(参考实现 list 同款参数)。 */
    async list(space, req, signal) {
        const limit = clampInt(req.limit, 1, 1000, 100);
        const offset = Math.max(0, req.offset ?? 0);
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset), state: 'valid' });
        const payload = await httpJson(this.http, `${this.base()}${this.bankPath(space)}/memories/list?${params}`, { headers: this.headers(), signal });
        return this.mapPage(payload, space, hindsightHit, limit, offset);
    }
}
function hindsightHit(value, space, driverId) {
    const item = obj(value);
    const externalId = str(item?.id);
    const content = str(item?.text) ?? str(item?.content) ?? str(item?.label);
    if (externalId === undefined || content === undefined)
        return undefined;
    const scores = obj(item?.scores);
    const rawEntities = item?.entities;
    const entities = Array.isArray(rawEntities)
        ? rawEntities.filter((x) => typeof x === 'string')
        : typeof rawEntities === 'string'
            ? rawEntities.split(',').map((s) => s.replace(/\s*\([^)]*\)\s*$/u, '').trim()).filter(Boolean)
            : undefined;
    return {
        driverId,
        spaceId: space.spaceId,
        externalId,
        content,
        score: num(scores?.final) ?? num(item?.score),
        category: str(item?.type) ?? str(item?.fact_type) ?? 'general',
        entities: entities === undefined || entities.length === 0 ? undefined : entities,
        tags: firstArray(item?.tags).filter((x) => typeof x === 'string'),
        updatedAt: str(item?.mentioned_at) ?? str(item?.date) ?? str(item?.occurred_start),
    };
}
/** openviking:`viking://` 资源树;信封包裹 {status,result},账号/用户走自定义头。 */
class OpenVikingDriver extends HttpExtDriver {
    typeId = 'openviking';
    headers() {
        const apiKey = this.extra('apiKey');
        const account = this.extra('account');
        const user = this.extra('user');
        const actor = this.extra('actorPeerId');
        return {
            ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
            ...(account === '' ? {} : { 'X-OpenViking-Account': account }),
            ...(user === '' ? {} : { 'X-OpenViking-User': user }),
            ...(actor === '' ? {} : { 'X-OpenViking-Actor-Peer': actor }),
        };
    }
    async status(signal) {
        try {
            await httpJson(this.http, `${this.base()}/health`, { headers: this.headers(), signal, timeoutMs: 5000 });
            return { healthy: true };
        }
        catch (err) {
            return { healthy: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    async search(space, q, signal) {
        const limit = clampInt(q.limit, 1, 50, 10);
        const raw = await httpJson(this.http, `${this.base()}/api/v1/search/find`, { headers: this.headers(), json: { query: q.query, target_uri: space.externalId, context_type: ['memory'], limit }, signal });
        // 信封拆包:{status:'error',...} 视同 HTTP 失败(参考实现同判据)
        const envelope = obj(raw);
        if (envelope?.status === 'error') {
            const err = obj(envelope.error);
            throw new Error(`${this.http.label}: ${str(err?.message) ?? 'OpenViking returned error envelope'}`);
        }
        const result = obj(envelope?.result ?? raw);
        const entries = Array.isArray(result?.memories) ? result.memories : [];
        const hits = entries
            .map((v) => openvikingHit(v, space, this.id))
            .filter((h) => h !== undefined)
            .slice(0, limit);
        return { results: hits, hasMore: false };
    }
    /** 拆信封:{status,result} → result;无信封直接用体。 */
    unwrap(raw) {
        const envelope = obj(raw);
        return obj(envelope?.result ?? raw) ?? {};
    }
    /**
     * Phase 3(hard 五家之一):session 三连(建会→发消息→commit)。
     * commit 回 task_id = 异步抽取中(accepted,settle 回捞 uri);无 task_id 则
     * 要么 archive_uri 直给(committed),要么被拒(skipped)。
     */
    async remember(space, item, signal) {
        const sessionId = `dsh-pm-${Date.now()}-${randomUUID()}`;
        await httpJson(this.http, `${this.base()}/api/v1/sessions`, {
            headers: this.headers(),
            json: { session_id: sessionId },
            signal,
            timeoutMs: 30_000,
        });
        await httpJson(this.http, `${this.base()}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
            headers: this.headers(),
            json: { role: 'user', content: item.content },
            signal,
            timeoutMs: 30_000,
        });
        const committed = this.unwrap(await httpJson(this.http, `${this.base()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
            headers: this.headers(),
            json: { keep_recent_count: 0 },
            signal,
            timeoutMs: 30_000,
        }));
        const taskId = str(committed.task_id);
        const archiveUri = str(committed.archive_uri);
        if (taskId === undefined) {
            return archiveUri === undefined ? { completion: 'skipped' } : { completion: 'committed', externalId: archiveUri };
        }
        return { completion: 'accepted', pendingOp: taskId, ...(archiveUri === undefined ? {} : { externalId: archiveUri }) };
    }
    /** hard 删:只接受资源树里的 .md 记忆 uri(与参考实现同守卫,拒删生成目录)。 */
    async forget(space, externalId, signal) {
        if (!externalId.endsWith('.md')) {
            throw new Error('openviking forget requires an exact .md memory URI');
        }
        const params = new URLSearchParams({ uri: externalId, recursive: 'false' });
        await httpJson(this.http, `${this.base()}/api/v1/fs?${params}`, { method: 'DELETE', headers: this.headers(), signal });
        return { completion: 'committed' };
    }
    /**
     * 资源树遍历：`fs/ls?recursive` 一次给全（无 offset 语义 → caps.paged=false）。
     *
     * `hasMore` 必须反映「总条数 > limit」而不能恒 false：参考实现用 `.slice(0, limit)`
     * 静默截断，照搬会让导入在远端条目多于 limit 时报 `truncation='none'` —— 谎报未截断
     * 比报错更坑（用户会以为已全量导入）。本实现不截断，把真实条数交给 mapPage 判。
     */
    async list(space, req, signal) {
        const limit = clampInt(req.limit, 1, 1000, 100);
        const query = new URLSearchParams({ uri: space.externalId, recursive: 'true', output: 'original' });
        const raw = await httpJson(this.http, `${this.base()}/api/v1/fs/ls?${query}`, { headers: this.headers(), signal });
        const envelope = obj(raw);
        if (envelope?.status === 'error') {
            const err = obj(envelope.error);
            throw new Error(`${this.http.label}: ${str(err?.message) ?? 'OpenViking fs/ls returned error envelope'}`);
        }
        // `result` 在真服务上是**数组**（实测 0.5.3：{status,result:[{uri,name,...}]}），
        // 不能过 `unwrap()`（它只认对象）：obj(array) → undefined → 条目恒为空，
        // 于是导入 0 条还报 truncation=complete（真机验收抓到的谎报）。
        const result = envelope?.result ?? raw;
        const entries = Array.isArray(result)
            ? result
            : (() => {
                const o = obj(result);
                return Array.isArray(o?.entries) ? o.entries : Array.isArray(o?.items) ? o.items : [];
            })();
        // 只取资源树里的 .md 记忆文件：目录与隐藏项不是记忆条目（forget 也只接受 .md uri）。
        const mapped = entries
            .map((v) => openvikingHit(v, space, this.id))
            .filter((h) => h !== undefined)
            .filter((h) => h.externalId.endsWith('.md') && !h.externalId.slice(h.externalId.lastIndexOf('/') + 1).startsWith('.'));
        const page = mapped.slice(0, limit);
        // 正文必须逐条补读：`fs/ls` 只给元数据（实测 0.5.3 的 output 只影响元数据粒度），
        // 不补读就会把 uri 当内容写进 L1——导入看着成功、实际全是路径字符串。
        // N+1 是这一家的固有形态（文件系统式 API）；上限就是本页 limit，不放大。
        const hydrated = [];
        for (const hit of page) {
            try {
                const envelope = obj(await httpJson(this.http, `${this.base()}/api/v1/content/read?uri=${encodeURIComponent(hit.externalId)}`, { headers: this.headers(), signal }));
                const body = typeof envelope?.result === 'string' ? envelope.result : undefined;
                hydrated.push(body !== undefined && body.trim() !== '' ? { ...hit, content: body } : hit);
            }
            catch {
                // 单条读失败不拖垮整页：保留元数据（content 已回退为 uri），由上游计入 skipped/失败。
                hydrated.push(hit);
            }
        }
        return { hits: hydrated, hasMore: mapped.length > limit };
    }
}
function openvikingHit(value, space, driverId) {
    const item = obj(value);
    const uri = str(item?.uri);
    if (uri === undefined)
        return undefined;
    return {
        driverId,
        spaceId: space.spaceId,
        externalId: uri,
        content: str(item?.overview) ?? str(item?.abstract) ?? uri,
        score: num(item?.score),
        category: str(item?.category) ?? categoryFromUri(uri),
        uri,
    };
}
function categoryFromUri(uri) {
    const marker = '/memories/';
    const suffix = uri.includes(marker) ? uri.slice(uri.indexOf(marker) + marker.length) : '';
    return suffix.split('/')[0]?.replace(/\.md$/u, '') || 'general';
}
/** honcho:workspace conclusions;**不声明可比分数**(lane 只取 rank)。 */
class HonchoDriver extends HttpExtDriver {
    typeId = 'honcho';
    headers() {
        const token = this.extra('apiKey').replace(/^Bearer\s+/iu, '');
        return token === '' ? {} : { Authorization: `Bearer ${token}` };
    }
    basePath(space) {
        return `/v3/workspaces/${encodeURIComponent(space.externalId)}`;
    }
    async search(space, q, signal) {
        const limit = clampInt(q.limit, 1, 100, 10);
        const payload = await httpJson(this.http, `${this.base()}${this.basePath(space)}/conclusions/query`, {
            headers: this.headers(),
            // honcho 语义查询要求双端 peer 都在(参考实现 requirePeers 分支的固定形态)
            json: { query: q.query, top_k: limit, filters: { observer_id: this.extra('agentId', 'dsh'), observed_id: this.extra('userId', 'dsh-user') } },
            signal,
        });
        return { results: this.mapAll(payload, space, honchoHit, limit), hasMore: false };
    }
    /** Phase 3(hard 五家之一):peer conclusion 显式入库;回 items[0].id。 */
    async remember(space, item, signal) {
        const observer = this.extra('agentId', 'dsh');
        const observed = this.extra('userId', 'dsh-user');
        const payload = await httpJson(this.http, `${this.base()}${this.basePath(space)}/conclusions`, {
            headers: this.headers(),
            json: {
                conclusions: [{
                        content: item.content,
                        observer_id: observer === '*' || observer === '' ? 'dsh' : observer,
                        observed_id: observed === '*' || observed === '' ? 'dsh-user' : observed,
                        session_id: null,
                    }],
            },
            signal,
            timeoutMs: 30_000,
        });
        const created = firstArray(payload, 'items', 'results').map((v) => obj(v)).find((v) => v !== undefined);
        const id = str(created?.id);
        return { completion: 'committed', ...(id === undefined ? {} : { externalId: id }) };
    }
    /** hard 删:conclusion 直接 DELETE(Honcho 无软删面)。 */
    async forget(space, externalId, signal) {
        await httpJson(this.http, `${this.base()}${this.basePath(space)}/conclusions/${encodeURIComponent(externalId)}`, {
            method: 'DELETE',
            headers: this.headers(),
            signal,
        });
        return { completion: 'committed' };
    }
    /**
     * 结论列表（参考实现同款 page/size，size 上限 100）。
     *
     * 注意导出的是 **派生结论**（conclusions），不是原始对话：原始层在 sessions/messages，
     * 本驱动未接。面板导入时要说清“导入的是该家的抽取结果层”。
     */
    async list(space, req, signal) {
        const limit = clampInt(req.limit, 1, 100, 50);
        const offset = Math.max(0, req.offset ?? 0);
        const page = 1 + Math.floor(offset / limit);
        const payload = await httpJson(this.http, `${this.base()}${this.basePath(space)}/conclusions/list?page=${page}&size=${limit}`, {
            headers: this.headers(),
            json: { filters: { observer_id: this.extra('agentId', 'dsh'), observed_id: this.extra('userId', 'dsh-user') } },
            signal,
        });
        return this.mapPage(payload, space, honchoHit, limit, offset);
    }
}
function honchoHit(value, space, driverId) {
    const item = obj(value);
    const externalId = str(item?.id);
    const content = str(item?.content);
    if (externalId === undefined || content === undefined)
        return undefined;
    return {
        driverId,
        spaceId: space.spaceId,
        externalId,
        content,
        category: str(item?.level) ?? 'insight',
        updatedAt: str(item?.created_at) ?? str(item?.createdAt),
    };
}
/** retaindb:project/user 双轴;鉴权头双挂(Bearer + /v1/memory* 路径的 X-API-Key,实测形态)。 */
class RetainDbDriver extends HttpExtDriver {
    typeId = 'retaindb';
    headers(path) {
        const token = this.extra('apiKey').replace(/^Bearer\s+/iu, '');
        return {
            Authorization: `Bearer ${token}`,
            ...(path.startsWith('/v1/memory') ? { 'X-API-Key': token } : {}),
        };
    }
    async search(space, q, signal) {
        const limit = clampInt(q.limit, 1, 50, 10);
        const userId = this.extra('userId');
        const payload = await httpJson(this.http, `${this.base()}/v1/memory/search`, {
            headers: this.headers('/v1/memory/search'),
            json: {
                project: space.externalId,
                query: q.query,
                ...(userId === '' || userId === '*' ? {} : { user_id: userId }),
                top_k: limit,
                include_pending: true,
            },
            signal,
        });
        return { results: this.mapAll(payload, space, retaindbHit, limit), hasMore: false };
    }
    /** Phase 3(hard 五家之一):/v1/memory 同步写;老服务无 write_mode → 回落 /v1/memories。 */
    async remember(space, item, signal) {
        const userId = this.extra('userId');
        const json = {
            project: space.externalId,
            content: item.content,
            memory_type: item.category ?? 'factual',
            user_id: userId === '' || userId === '*' ? 'dsh-user' : userId,
            session_id: `dsh-${space.spaceId}`,
            importance: item.importance ?? 0.7,
            write_mode: 'sync',
        };
        let payload;
        try {
            payload = await httpJson(this.http, `${this.base()}/v1/memory`, { headers: this.headers('/v1/memory'), json, signal, timeoutMs: 30_000 });
        }
        catch {
            const { write_mode: _writeMode, ...legacy } = json;
            payload = await httpJson(this.http, `${this.base()}/v1/memories`, { headers: this.headers('/v1/memories'), json: legacy, signal, timeoutMs: 30_000 });
        }
        const id = str(obj(payload)?.id) ?? str(obj(payload)?.memory_id);
        return { completion: 'committed', ...(id === undefined ? {} : { externalId: id }) };
    }
    /** hard 删:/v1/memory/{id} 失败回落 /v1/memories/{id}（双形态同构）。 */
    async forget(space, externalId, signal) {
        try {
            await httpJson(this.http, `${this.base()}/v1/memory/${encodeURIComponent(externalId)}`, { method: 'DELETE', headers: this.headers('/v1/memory'), signal });
        }
        catch {
            await httpJson(this.http, `${this.base()}/v1/memories/${encodeURIComponent(externalId)}`, { method: 'DELETE', headers: this.headers('/v1/memories'), signal });
        }
        return { completion: 'committed' };
    }
    /**
     * 遍历：profile 形态优先（带 project + include_pending），失败回落 collection 形态。
     * 两形态都没给出分页参数 → caps.paged=false，单页到底。
     */
    async list(space, req, signal) {
        const limit = clampInt(req.limit, 1, 1000, 100);
        const offset = Math.max(0, req.offset ?? 0);
        const userId = this.extra('userId');
        const params = new URLSearchParams({ project: space.externalId, include_pending: 'true' });
        let payload;
        try {
            if (userId === '' || userId === '*')
                throw new Error('project-wide scope uses the collection endpoint');
            payload = await httpJson(this.http, `${this.base()}/v1/memory/profile/${encodeURIComponent(userId)}?${params}`, { headers: this.headers('/v1/memory/profile'), signal });
        }
        catch {
            payload = await httpJson(this.http, `${this.base()}/v1/memory?${params}`, { headers: this.headers('/v1/memory'), signal });
        }
        return this.mapPage(payload, space, retaindbHit, limit, offset);
    }
}
function retaindbHit(value, space, driverId) {
    const item = obj(value);
    const externalId = str(item?.id) ?? str(item?.memory_id);
    const content = str(item?.content) ?? str(item?.memory) ?? str(item?.text);
    if (externalId === undefined || content === undefined)
        return undefined;
    return {
        driverId,
        spaceId: space.spaceId,
        externalId,
        content,
        score: num(item?.score) ?? num(item?.similarity),
        category: str(item?.memory_type) ?? str(item?.category) ?? 'general',
        updatedAt: str(item?.created_at) ?? str(item?.createdAt) ?? str(item?.updated_at),
    };
}
/** supermemory:container tag 隔离;/v4/search。 */
class SupermemoryDriver extends HttpExtDriver {
    typeId = 'supermemory';
    headers() {
        const token = this.extra('apiKey').replace(/^Bearer\s+/iu, '');
        return { Authorization: `Bearer ${token}` };
    }
    async search(space, q, signal) {
        const limit = clampInt(q.limit, 1, 50, 10);
        const payload = await httpJson(this.http, `${this.base()}/v4/search`, {
            headers: this.headers(),
            json: { q: q.query, containerTag: space.externalId, searchMode: this.extra('searchMode', 'hybrid'), limit },
            signal,
        });
        return { results: this.mapAll(payload, space, supermemoryHit, limit), hasMore: false };
    }
    /**
     * Phase 2 实装(soft 三家之一):文档入容器提取。返回体带 document id——
     * 但**提取未完不算 committed**(deletionMode=soft 也是 async-extracting):
     * externalId 直接可用(forget 寻址),状态仍走 awaiting_settle 等内容在远端成形。
     */
    async remember(space, item, signal) {
        const payload = obj(await httpJson(this.http, `${this.base()}/v3/documents`, {
            headers: this.headers(),
            json: {
                content: item.content,
                containerTag: space.externalId,
                taskType: 'memory',
                metadata: { sm_source: 'dsh-prime-memory', ...(item.category === undefined ? {} : { category: item.category }) },
            },
            signal,
            timeoutMs: 30_000,
        })) ?? {};
        const id = str(payload.id);
        return { completion: 'accepted', pendingOp: id ?? str(payload.status) ?? 'queued', ...(id === undefined ? {} : { externalId: id }) };
    }
    /** soft 删:/v4/memories DELETE,404 回落 /v3/documents/{id}(参考实现双路同构)。 */
    async forget(space, externalId, signal) {
        try {
            await httpJson(this.http, `${this.base()}/v4/memories`, { method: 'DELETE', headers: this.headers(), json: { id: externalId, containerTag: space.externalId, reason: 'Retired from dsh-prime-memory' }, signal });
        }
        catch (err) {
            if (!(err instanceof Error) || !/HTTP 404\b/u.test(err.message))
                throw err;
            await httpJson(this.http, `${this.base()}/v3/documents/${encodeURIComponent(externalId)}`, { method: 'DELETE', headers: this.headers(), signal });
        }
        return { completion: 'committed' };
    }
    /** settle 回捞面:提取完成的记忆条目(只 memories 臂,够内容指纹对上号)。 */
    async list(space, req, signal) {
        const limit = clampInt(req.limit, 1, 200, 100);
        const offset = Math.max(0, req.offset ?? 0);
        // page 由 offset 推导：旧写法硬编码 page:1，于是翻页永远重拉首页（条目多于 limit 时导入永远追不完）。
        const page = 1 + Math.floor(offset / limit);
        const payload = await httpJson(this.http, `${this.base()}/v4/memories/list`, {
            headers: this.headers(),
            json: { containerTags: [space.externalId], limit, page, sort: 'createdAt', order: 'desc' },
            signal,
        });
        return this.mapPage(payload, space, supermemoryHit, limit, offset);
    }
}
function supermemoryHit(value, space, driverId) {
    const item = obj(value);
    const externalId = str(item?.id);
    const meta = obj(item?.metadata);
    const content = str(item?.memory) ?? str(item?.chunk) ?? str(item?.content);
    if (externalId === undefined || content === undefined)
        return undefined;
    return {
        driverId,
        spaceId: space.spaceId,
        externalId,
        content,
        score: num(item?.similarity) ?? num(item?.score),
        category: str(meta?.category),
        updatedAt: str(item?.updatedAt) ?? str(item?.createdAt),
    };
}
export const HTTP_DRIVER_FACTORIES = {
    mem0: (i) => new Mem0Driver(i.id, i),
    hindsight: (i) => new HindsightDriver(i.id, i),
    openviking: (i) => new OpenVikingDriver(i.id, i),
    honcho: (i) => new HonchoDriver(i.id, i),
    retaindb: (i) => new RetainDbDriver(i.id, i),
    supermemory: (i) => new SupermemoryDriver(i.id, i),
};
