/**
 * DRSC 进程内读适配器（issue #20 的追加修复）。
 *
 * 为什么要换掉 HTTP：桌面宿主在**任何**注册路由之前有一道 pre-dispatch 鉴权
 * （`isAuthenticated` 只认由 `requestAudience(Host)` 派生的签名 cookie，豁免分支
 * 只有 `GET /?token=` 与已认证的 `GET /`）。插件服务端 `fetch` 没有 cookie，也没有
 * 任何可取用该 token 的服务面（`launchToken` 是宿主 `BrowserAuth` 的私有字段），
 * 于是基址修对了也只会拿到 401 —— 真机已实测（见 #20 评论）。
 *
 * 本模块改为直调 collector 导出的**只读查询面**：
 *   resolveIndexDir() → openProjectionStore(dir) → createQueryContext(store)
 *   → search / sessionDetail / listSessions
 * 全程不碰 `ProjectionSync`（写侧引擎），因此不会与 collector 自己的同步器抢水位、
 * 也不会多挂一个 interval。索引库是 WAL（实测同目录有 -wal/-shm），宿主持写连接时
 * 本侧只读句柄可并发读。
 *
 * 包名用变量做动态 import：本仓 devDeps 没有该包，静态 import 会让 typecheck 挂；
 * 运行期它由 profile 顶层 node_modules 提供（本插件已把它列为 dependency 与
 * pluginDependencies，装载序在前，故首次读时必已就位）。
 */
/** collector 包入口（裸名，由 profile 顶层 node_modules 解析）。 */
const COLLECTOR_PACKAGE = 'dsh-reference-session-collector';
const defaultLoader = async () => (await import(/* @vite-ignore */ COLLECTOR_PACKAGE));
let modulePromise;
/**
 * 对端已升版但库未就绪时的重试预算。不能无限重试：宿主**外**的脚本、以及
 * 「collector 装了但未装载」的部署里，drsReadFacade() 永远返回 undefined，
 * 死等会把读面永久堵死（比回退更糟）。也不能一上来就回退：那会把自开库
 * 结果永久缓存，把“优先用门面”变成只在首轮赌运气。
 */
const FACADE_RETRY_BUDGET = 3;
let facadeMisses = 0;
/**
 * 兼容路径（旧 collector）的只读句柄（`openProjectionStore` 的返回值）。常驻 summaries
 * 是内存 Map，每请求重开等于重扫全表，故只开一次；undefined 是合法的未开哨兵。
 */
let storeHandle;
/** 清掉缓存（单测用；也供 collector 换装后强制重取）。 */
export function resetCollectorReadState() {
    modulePromise = undefined;
    storeHandle = undefined;
    facadeMisses = 0;
}
/** 把门面对象适配成本模块统一的「模块形」，以便与兼容路径共用同一套参数映射。
 * 前三个成员在门面路径上永不会被调用：moduleOf 命中门面后直接返回，不走进兼容分支。
 */
function fromFacade(facade) {
    const unused = () => {
        throw new Error('门面路径不应自开投影库');
    };
    return {
        resolveIndexDir: unused,
        openProjectionStore: unused,
        createQueryContext: unused,
        listSessions: (ctx, offset, limit) => facade.listSessions(offset, limit),
        sessionDetail: (ctx, sessionId, opts) => facade.sessionDetail(sessionId, opts),
        search: (ctx, query, opts) => facade.search(query, opts),
    };
}
/** 取一个可用的「模块形」：优先 collector 门面（>=0.2.5），否则回退自开只读库。 */
async function moduleOf(load) {
    const pending = (modulePromise ??= (async () => {
        const mod = (await load());
        if (typeof mod.drsReadFacade === 'function') {
            const facade = mod.drsReadFacade();
            // 对端是新版本但库未就绪（collector 的重活推迟在 setImmediate 臂）：先给它几次
            // 重试机会（抛可重试错、不缓存 rejection，下一次读重取门面）；超过预算就认定
            // 本进程里不会有人 activate 它（宿主外的脚本、或 collector 装了但未装载），
            // 回退自开只读库。两条路都不会读错数据：库是同一个 WAL 文件，自开句柄只读。
            facadeMisses += 1;
            if (facade !== undefined) {
                facadeMisses = 0;
                return fromFacade(facade);
            }
            if (facadeMisses <= FACADE_RETRY_BUDGET) {
                throw new Error(`collector 投影库尚未就绪（第 ${facadeMisses}/${FACADE_RETRY_BUDGET} 次重试）`);
            }
        }
        return legacyStoreModule(mod);
    })().catch((err) => {
        if (modulePromise === pending)
            modulePromise = undefined;
        throw err;
    }));
    return pending;
}
/** 旧 collector（无 drsReadFacade）的兼容路径：自己开一份只读库。 */
async function legacyStoreModule(mod) {
    if (storeHandle === undefined) {
        storeHandle = mod.openProjectionStore(mod.resolveIndexDir());
    }
    const ctx = mod.createQueryContext(storeHandle);
    return {
        ...mod,
        listSessions: (_c, offset, limit) => mod.listSessions(ctx, offset, limit),
        sessionDetail: (_c, sessionId, opts) => mod.sessionDetail(ctx, sessionId, opts),
        search: (_c, query, opts) => mod.search(ctx, query, opts),
    };
}
/** 把 HTTP 查询串拆成参数表（与 collector 路由同源解析口径：它也只读 searchParams）。 */
function paramsOf(query) {
    return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
}
/**
 * 执行一次读，返回与 HTTP 包络同形的对象（`ok:true` + 各 op 的字段）。
 *
 * 保持同形是有意的：`DrscClient` 的四个读点全部经由 `getJson`，字段映射、
 * 「session=null → 空数组」「limit 钳位」这些口径都已在那边测过；这里只负责
 * 把传输从 fetch 换成函数调用，不顺手改任何语义。
 */
export async function callCollectorRead(query, load = defaultLoader) {
    const mod = await moduleOf(load);
    const p = paramsOf(query);
    const op = p.get('op') ?? '';
    // collector 的 redact 臂：HTTP 侧是 `redact=1`；缺省是原文臂。我们所有读点都硬要求脱敏。
    const redact = p.get('redact') !== null && p.get('redact') !== '0';
    if (op === 'search') {
        const limit = positiveInt(p.get('limit'));
        return {
            ok: true,
            ...mod.search(READ_SURFACE, p.get('q') ?? '', {
                // 非法/缺省时整个键缺席，而不是传 `limit: undefined` —— `'limit' in opts`
                // 与 `opts.limit === undefined` 不是一回事，对端可能按前者走钳位分支。
                ...(limit === undefined ? {} : { limit }),
                redact,
            }),
        };
    }
    if (op === 'session') {
        const sessionId = p.get('session');
        if (sessionId === null || sessionId === '') {
            return { ok: true, session: null, rows: [] };
        }
        const tail = positiveInt(p.get('tail'));
        const detail = mod.sessionDetail(READ_SURFACE, sessionId, {
            // collector 侧：tail 为正整数才切尾窗，键缺席即全量（#14-B 的整会话臂依赖这点）。
            ...(tail === undefined ? {} : { tail }),
            redact,
        });
        return { ok: true, ...detail };
    }
    if (op === 'sessions') {
        // 这两个是位置参数，undefined 与“没传”在 JS 里同义，无需上面对象字面量那套处置。
        const offset = positiveInt(p.get('offset')) ?? 0;
        const limit = positiveInt(p.get('limit'));
        return { ok: true, ...mod.listSessions(READ_SURFACE, offset, limit) };
    }
    throw new Error(`collector 未知 op: ${op === '' ? '(missing)' : op}`);
}
/** 只接受「正整数」形式的参数；非法/缺省一律 undefined（交由调用点决定缺席语义）。 */
function positiveInt(raw) {
    if (raw === null || raw.trim() === '')
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
/** 统一形后的模块不再需要真 QueryContext，这个占位只用来占位。 */
const READ_SURFACE = 'inproc-read-surface';
/** 超过这个滞后就判 `stale`（“装了但库不新鲜”）。30 分钟与同步器节拍同量级。 */
export const DRSC_STALE_AFTER_MS = 30 * 60 * 1000;
/** `synced_at` 实测是 TEXT ISO（如 "2026-11-01T21:00:57.415Z"），兼容数值形式。 */
function parseSyncStamp(v) {
    if (typeof v === 'string' && v.trim() !== '') {
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : null;
    }
    if (typeof v === 'number' && Number.isFinite(v) && v > 0)
        return v;
    return null;
}
/**
 * 探针（只观测，不改变读路径）。
 *
 * 三条铁律（违一条就会污染读面或误报）：
 * 1. **不经 `moduleOf`**：它会推进 `facadeMisses` 并把结果缓进 `modulePromise`，
 *    探针是观测面，不得改动读路径的重试预算与缓存——故这里直接调 `load()` 与 `drsReadFacade()`。
 * 2. **复用模块级 `storeHandle`**：`openProjectionStore` 会把摘要全表载入（Issue #1 的根因），
 *    每 60s 轮询重开一次就是事故；只在 undefined 时开。
 * 3. **读库失败一律落 `unknown`**：探针失败不等于功能坏了，不得当成故障吓用户。
 */
export async function probeDrscHealth(opts = {}) {
    const now = opts.now ?? Date.now();
    const staleAfterMs = opts.staleAfterMs ?? DRSC_STALE_AFTER_MS;
    const load = opts.load ?? defaultLoader;
    const base = {
        state: 'unknown',
        installed: false,
        mounted: false,
        lastSyncAt: null,
        lagMs: null,
        staleAfterMs,
        indexPath: null,
        checkedAt: now,
    };
    let mod;
    try {
        mod = (await load());
    }
    catch (err) {
        return { ...base, state: 'missing', error: err instanceof Error ? err.message : String(err) };
    }
    // 门面活 → 已启用（ok 态由客户端 return null，不占版面）
    try {
        if (typeof mod.drsReadFacade === 'function' && mod.drsReadFacade() !== undefined) {
            return { ...base, state: 'ok', installed: true, mounted: true };
        }
    }
    catch (err) {
        // 门面自身抛错：按“装了没启用”继续往下判，不因此报 missing
        base.error = err instanceof Error ? err.message : String(err);
    }
    // 装了没启用：读投影库水位区分 not-running / stale
    let indexPath = null;
    try {
        indexPath = mod.resolveIndexDir();
        if (storeHandle === undefined)
            storeHandle = mod.openProjectionStore(indexPath);
        const db = storeHandle.db;
        if (!db)
            return { ...base, state: 'unknown', installed: true, indexPath, error: '投影库句柄无 .db' };
        const row = db.prepare('SELECT MAX(synced_at) AS s FROM sessions').get();
        const lastSyncAt = parseSyncStamp(row?.s);
        if (lastSyncAt === null) {
            return { ...base, state: 'unknown', installed: true, indexPath, error: 'synced_at 无法解析（期望 ISO 字符串或 epoch ms）' };
        }
        const lagMs = Math.max(0, now - lastSyncAt);
        return {
            ...base,
            state: lagMs <= staleAfterMs ? 'not-running' : 'stale',
            installed: true,
            lastSyncAt,
            lagMs,
            indexPath,
            error: undefined,
        };
    }
    catch (err) {
        return {
            ...base,
            state: 'unknown',
            installed: true,
            indexPath,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
