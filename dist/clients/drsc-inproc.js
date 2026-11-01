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
 * 兼容路径（旧 collector）的只读句柄（`openProjectionStore` 的返回值）。常驻 summaries
 * 是内存 Map，每请求重开等于重扫全表，故只开一次；undefined 是合法的未开哨兵。
 */
let storeHandle;
/** 清掉缓存（单测用；也供 collector 换装后强制重取）。 */
export function resetCollectorReadState() {
    modulePromise = undefined;
    storeHandle = undefined;
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
            // 对端是新版本但库未就绪（collector 的重活推迟在 setImmediate 臂）：本轮**不**回退
            // 自开库，而是抛可重试错——否则会把自开库结果永久缓存，把“优先用门面”变成
            // 只在首轮赌运气。抛错走既有降级链（背景窗当轮空窗、工具面显式报错），
            // 且不缓存 rejection，下一次读会重取门面。
            if (facade === undefined) {
                throw new Error('collector 投影库尚未就绪（稍后自动重试）');
            }
            return fromFacade(facade);
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
