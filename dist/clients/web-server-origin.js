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
/**
 * 读取宿主监听 origin；任何取不到/抛错都返回 undefined（不抛，不影响请求）。
 * @param ctx - 只用到 webServer 属性与可选的 ctx.get，故类型刻意收窄。
 */
export function readWebServerOrigin(ctx) {
    const svc = getWebServerFace(ctx);
    if (svc === undefined)
        return undefined;
    // 首选宿主自算的 origin：protocol 与 bind host 形式都由它给定
    try {
        if (typeof svc.getOrigin === 'function') {
            const origin = svc.getOrigin();
            if (typeof origin === 'string' && origin.trim() !== '')
                return origin.trim();
        }
    }
    catch {
        /* 未 listen / 绑定地址带 zone id：落到 port 一档，再落不动即交给调用方缺省 */
    }
    try {
        const port = svc.port;
        if (typeof port !== 'number' || !Number.isFinite(port) || port <= 0)
            return undefined;
        return `http://127.0.0.1:${port}`;
    }
    catch {
        return undefined;
    }
}
/** webServer 实例读取（服务可能晚于本插件就绪；属性读抛则当作未就绪）。 */
function getWebServerFace(ctx) {
    if (typeof ctx !== 'object' || ctx === null)
        return undefined;
    const carrier = ctx;
    try {
        const direct = carrier.webServer;
        const svc = direct !== undefined
            ? direct
            : typeof carrier.get === 'function'
                ? carrier.get('webServer')
                : undefined;
        return typeof svc === 'object' && svc !== null ? svc : undefined;
    }
    catch {
        return undefined;
    }
}
