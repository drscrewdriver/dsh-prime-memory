/**
 * issue #20:宿主实际监听 origin 的降级读取（DrscClient 的第三档兜底）。
 *
 * 为何不写在 index.ts 里：它有两条取数路径 + 三个抛错入口，是需要被单测钉住的可判定
 * 逻辑；埋在装配文件里就只能靠人肉真机核对，而 #20 的整条因果链正是「没人核对过」。
 *
 * 优先取 `getOrigin()`，再退 `port`——两者的可用性已逐线实测取证，别拿一条线当事实：
 * ・0.2.0-rc.2 源码仓的 webServer **没有** getOrigin()，只有 `get port()` / `get host()`；
 * ・0.2.1-rc.5 装机宿主（app.asar 内类体）已有 `getOrigin()`，返回
 *   `${protocol}//${bindUrlHost(host)}:${listenedPort}`——protocol 认 TLS、bind host 走
 *   URL 形式转换，这两个细节本插件自己算不出来，所以新线一律用它。
 *
 * 三条硬降级理由（缺一就不能发）：
 * ① `getOrigin()` 在未 listen / 绑定地址带 zone id 时**主动抛错**（不是返回 undefined），
 *    所以必须包 try——这里抛错是预期的「还没就绪」，不是异常；
 * ② 老线无 getOrigin 时退 `port`：宿主侧 `listenedPort` 未 listen 时读到 undefined，
 *    naive 模板串会产出 `http://127.0.0.1:undefined` 这种能发出去但永远错的 URL，
 *    故仅当 `typeof port === 'number' && port > 0` 才用（这条退化路径把 TLS / 非 loopback
 *    绑定当作 http+127.0.0.1 处理——那正是旧版本写死 8080 也没解决的面，不比旧行为更差）；
 * ③ cordis Proxy 面对未授权属性会直接抛，故与 webStartup 的 trustedHosts 读取同款两层 try。
 *
 * 一律「取不到就返回 undefined」：调用方据此落回写死的 8080，即逐字节等价旧行为。
 */
/** 本模块用到的 webServer 服务面（结构类型，不依赖宿主包类型导出）。 */
export interface WebServerOriginFace {
    /** 0.2.1-rc.5 起存在；未 listen / 绑定地址无 URL 形式时抛错。 */
    getOrigin?: () => unknown;
    /** OS 分配的实际监听口；未 listen 时为 undefined（老线只有这一档）。 */
    port?: unknown;
}
/**
 * 读取宿主监听 origin；任何取不到/抛错都返回 undefined（不抛，不影响请求）。
 * @param ctx - 只用到 webServer 属性与可选的 ctx.get，故类型刻意收窄。
 */
export declare function readWebServerOrigin(ctx: unknown): string | undefined;
