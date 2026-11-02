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
/** 只用到读面，形状按 collector 的 d.ts 手工声明，不引它的类型（避免跨包类型依赖）。 */
export interface CollectorReadModule {
    resolveIndexDir: (explicit?: string, env?: NodeJS.ProcessEnv) => string;
    openProjectionStore: (dir: string) => unknown;
    createQueryContext: (store: unknown) => unknown;
    search: (ctx: unknown, query: string, opts?: {
        session?: string;
        limit?: number;
        redact?: boolean;
    }) => Record<string, unknown>;
    sessionDetail: (ctx: unknown, sessionId: string, opts?: {
        turn?: string;
        fields?: string;
        tail?: number;
        redact?: boolean;
    }) => Record<string, unknown>;
    listSessions: (ctx: unknown, offset?: number, limit?: number) => Record<string, unknown>;
}
/** 注入面（单测）；缺省按裸名动态 import。 */
export type CollectorLoader = () => Promise<CollectorReadModule>;
/** 清掉缓存（单测用；也供 collector 换装后强制重取）。 */
export declare function resetCollectorReadState(): void;
/**
 * 执行一次读，返回与 HTTP 包络同形的对象（`ok:true` + 各 op 的字段）。
 *
 * 保持同形是有意的：`DrscClient` 的四个读点全部经由 `getJson`，字段映射、
 * 「session=null → 空数组」「limit 钳位」这些口径都已在那边测过；这里只负责
 * 把传输从 fetch 换成函数调用，不顺手改任何语义。
 */
export declare function callCollectorRead(query: string, load?: CollectorLoader): Promise<Record<string, unknown>>;
/** 五态：`ok` 不渲染 banner；`unknown` 是探针失败的兜底（不得当成故障去误报）。 */
export type DrscHealthState = 'ok' | 'not-running' | 'stale' | 'missing' | 'unknown';
export interface DrscHealth {
    state: DrscHealthState;
    /** 包能 import → true。`missing` 时为 false。 */
    installed: boolean;
    /** 门面可用（= collector 真跑起来了）→ true。装了没启用时为 false。 */
    mounted: boolean;
    /** 投影库 `MAX(synced_at)` 的 epoch ms；无从读取为 null。 */
    lastSyncAt: number | null;
    /** now - lastSyncAt；null = 无从计算。 */
    lagMs: number | null;
    staleAfterMs: number;
    indexPath: string | null;
    checkedAt: number;
    error?: string;
}
/** 超过这个滞后就判 `stale`（“装了但库不新鲜”）。30 分钟与同步器节拍同量级。 */
export declare const DRSC_STALE_AFTER_MS: number;
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
export declare function probeDrscHealth(opts?: {
    load?: CollectorLoader;
    now?: number;
    staleAfterMs?: number;
}): Promise<DrscHealth>;
