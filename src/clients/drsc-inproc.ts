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

/** 只用到读面，形状按 collector 的 d.ts 手工声明，不引它的类型（避免跨包类型依赖）。 */
export interface CollectorReadModule {
  resolveIndexDir: (explicit?: string, env?: NodeJS.ProcessEnv) => string;
  openProjectionStore: (dir: string) => unknown;
  createQueryContext: (store: unknown) => unknown;
  search: (
    ctx: unknown,
    query: string,
    opts?: { session?: string; limit?: number; redact?: boolean },
  ) => Record<string, unknown>;
  sessionDetail: (
    ctx: unknown,
    sessionId: string,
    opts?: { turn?: string; fields?: string; tail?: number; redact?: boolean },
  ) => Record<string, unknown>;
  listSessions: (ctx: unknown, offset?: number, limit?: number) => Record<string, unknown>;
}

/** 注入面（单测）；缺省按裸名动态 import。 */
export type CollectorLoader = () => Promise<CollectorReadModule>;

const defaultLoader: CollectorLoader = async () =>
  (await import(/* @vite-ignore */ COLLECTOR_PACKAGE)) as unknown as CollectorReadModule;

let modulePromise: Promise<CollectorReadModule> | undefined;
let queryContext: unknown;
/**
 * 只读句柄（`openProjectionStore` 的返回值）。常驻 summaries 是内存 Map，
 * 每请求重开等于重扫全表，故只开一次；undefined 是合法的未开哨兵
 * （句柄真为 undefined 时 createQueryContext 会在首读即报错，不会静默重开）。
 */
let storeHandle: unknown;

/** 清掉缓存（单测用；也供 collector 换装后强制重开）。 */
export function resetCollectorReadState(): void {
  modulePromise = undefined;
  queryContext = undefined;
  storeHandle = undefined;
}

/** 载入并缓存 collector 模块；失败不缓存 rejection，否则一次抖动会永久打死后续所有读。 */
async function moduleOf(load: CollectorLoader): Promise<CollectorReadModule> {
  const pending = (modulePromise ??= load().catch((err: unknown) => {
    if (modulePromise === pending) modulePromise = undefined;
    throw err;
  }));
  return pending;
}

async function contextFor(load: CollectorLoader): Promise<unknown> {
  if (queryContext !== undefined) return queryContext;
  const mod = await moduleOf(load);
  if (storeHandle === undefined) {
    storeHandle = mod.openProjectionStore(mod.resolveIndexDir());
  }
  queryContext = mod.createQueryContext(storeHandle);
  return queryContext;
}

/** 把 HTTP 查询串拆成参数表（与 collector 路由同源解析口径：它也只读 searchParams）。 */
function paramsOf(query: string): URLSearchParams {
  return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
}

/**
 * 执行一次读，返回与 HTTP 包络同形的对象（`ok:true` + 各 op 的字段）。
 *
 * 保持同形是有意的：`DrscClient` 的四个读点全部经由 `getJson`，字段映射、
 * 「session=null → 空数组」「limit 钳位」这些口径都已在那边测过；这里只负责
 * 把传输从 fetch 换成函数调用，不顺手改任何语义。
 */
export async function callCollectorRead(
  query: string,
  load: CollectorLoader = defaultLoader,
): Promise<Record<string, unknown>> {
  const ctx = await contextFor(load);
  const mod = await moduleOf(load);
  const p = paramsOf(query);
  const op = p.get('op') ?? '';
  // collector 的 redact 臂：HTTP 侧是 `redact=1`；缺省是原文臂。我们所有读点都硬要求脱敏。
  const redact = p.get('redact') !== null && p.get('redact') !== '0';

  if (op === 'search') {
    const limit = positiveInt(p.get('limit'));
    return {
      ok: true,
      ...mod.search(ctx, p.get('q') ?? '', {
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
    const detail = mod.sessionDetail(ctx, sessionId, {
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
    return { ok: true, ...mod.listSessions(ctx, offset, limit) };
  }

  throw new Error(`collector 未知 op: ${op === '' ? '(missing)' : op}`);
}

/** 只接受「正整数」形式的参数；非法/缺省一律 undefined（交由调用点决定缺席语义）。 */
function positiveInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
