/**
 * 面板路由的 Host 信任围栏：白名单来源与 authority 比对（可判定逻辑，单测钉住）。
 *
 * 为何单独成文件：围栏要判的其实是「这个 Host 是不是宿主自己信任的 authority」，
 * 而白名单有两条取数路径（宿主服务 / 启动参数）+ 一套 canonical 比对，全是能被单测
 * 钉住的逻辑；留在 stats.ts 的装配代码里就只能靠真机核对（同 web-server-origin.ts
 * 的取舍理由）。
 *
 * 背景：面板不走宿主的 /api，而是自己注册 `POST /dsh-memory/rpc/<method>`，因此也
 * 自己承担 Host 围栏。原先只认 loopback，而宿主 `admit()` 的判据是
 *
 *    loopback ‖ trustedHosts(host) ‖ bindAddress(host)
 *
 * 于是凡是「宿主认、插件不认」的访问（局域网 IP、反代域名、以及 `--host` 绑到非
 * loopback 网卡时的本机直连）都会落到插件这里 403：界面与聊天正常，只有记忆面板
 * 满屏 `transport failure for dsh-memory/stats: HTTP 403`。
 *
 * 这里补的就是后两档：Host 命中 `--trusted-host` 白名单，或命中 `--host` 绑定的接口地址，
 * 即放行。不削弱防护——
 * 该列表是用户在启动参数里显式声明的可信 authority，宿主自己的 /api 已按它放行，
 * 且 DNS-rebinding 依旧拦得住（攻击者域名解析到本机后 Host 仍是攻击者域名，不在
 * 白名单内）。
 *
 * **放宽 Host 接受档必须同步补 Origin 档**：宿主 `isTrustedApiRequest` 是「Host 准入
 * ∪ sec-fetch-site 非 cross-site ∪ Origin 必等本 authority」三段式，本文件
 * `hostFenceAllows` 只对齐了第一段。本路由不校验 content-type，跨站页面能用
 * `text/plain` 发 JSON 绕过 CORS 预检，此时唯一还拦得住写接口的就是后两段
 * （见 {@link requestFenceAllows}）。只放宽第一段 = 把本机 CSRF 面放大到整个受信网段。
 *
 * 为何还要读进程参数：实测 0.2.2-rc.1 装机环境下，插件 ctx 读 webStartup / webRuntime
 * 取到 undefined（cordis Proxy 面与作用域可见性都可能挡），只读服务会退化成「只认
 * loopback」，重启後照旧 403。`--trusted-host` 的权威来源就是进程参数，故服务读取
 * 失败时以它兜底。
 */
/** Host 头是否为 loopback 主机名(localhost / [::1] / 127.x.x.x)。 */
export declare function isLoopbackHostname(hostname: string): boolean;
/**
 * 请求 authority 是否命中白名单。带端口的条目只匹配该精确 authority；不带端口的
 * 条目匹配任意端口的同名主机。两侧都走 WHATWG 归一化，故大小写与冗余的默认端口
 * 不参与判定。
 * @param hostUrl - 已解析的请求 Host。
 * @param entries - `--trusted-host` 条目（verbatim）。
 * @param scheme - 监听侧协议，决定默认端口如何被 URL 吃掉。
 */
export declare function matchesTrustedAuthority(hostUrl: URL, entries: readonly string[], scheme?: string): boolean;
/**
 * 读 webStartup / webRuntime 的 trustedHosts（best-effort）。
 *
 * 宿主 0.2.1-a.2 起把 webRuntime 更名成 webStartup，两个名字都试；未声明 inject 时
 * cordis Proxy 面对属性读直接抛，故两层 try + 双名回退，取不到一律 undefined。
 * @param ctx - 插件上下文（只用到属性读与可选的 ctx.get）。
 */
export declare function readStartupTrustedHosts(ctx: unknown): readonly string[] | undefined;
/**
 * 从进程参数解析 `--trusted-host`（repeatable，且单个 flag 后可跟多个值）。
 * @param argv - 默认 `process.argv`；测试可注入。
 */
export declare function readTrustedHostsFromArgv(argv?: readonly string[]): readonly string[];
/**
 * 当前进程的受信 authority 列表：宿主服务优先，取不到再读进程参数。
 * @param ctx - 插件上下文。
 */
export declare function resolveTrustedAuthorities(ctx: unknown): readonly string[];
/**
 * 读宿主 `--host` 绑定的接口地址（归一化主机名，不含端口）。
 *
 * 与容器的 bindAddress 一档对齐：把 dsh web 绑到具体非 loopback 网卡时，浏览器直连
 * 该地址发出的 Host 就是它，宿主的 fence 认，插件不认就会「本机直连也 403」。
 * 绑定地址不是 DNS 重绑定目标，放行它不额外授予任何东西（端口不参与判定，同宿主）。
 * @param ctx - 插件上下文（只读 webServer 服务面）。
 */
export declare function readBindHostname(ctx: unknown): string | undefined;
/**
 * 围栏判定：Host 解析得出的 authority 命中 loopback 或受信白名单才放行。
 * @param host - 请求头里的 Host（verbatim）。
 * @param ctx - 插件上下文，用于读受信白名单。
 * @param scheme - 监听侧协议（决定默认端口归一化）。
 */
export declare function hostFenceAllows(host: unknown, ctx: unknown, scheme?: string): boolean;
/**
 * Origin 是否就是本监听器自己的 authority。
 *
 * 移植宿主 `isSameAuthorityOrigin`（dsh-client-connection/src/api-request-trust.ts），
 * 语义必须逐字对齐：按 Origin 的 scheme 重新解析 Host，让默认端口一致归一化
 * （transport 可能是 HTTPS 反代后的 HTTP）。只接受 http(s)——`null`（沙箱 iframe /
 * file: 页面）在 `new URL` 就抛，其他 scheme（file:、ftp:）在这里拒，而不是退化成
 * 「主机名相同即放行」。
 * @param origin - 请求头 Origin（verbatim）。
 * @param host - 已通过 Host 档的 Host 头（verbatim）。
 */
export declare function isSameAuthorityOrigin(origin: string, host: string): boolean;
/** 围栏要看的请求头子集（Node `IncomingMessage.headers` 的子集，便于单测注入）。 */
export interface FenceHeaders {
    host?: unknown;
    origin?: unknown;
    'sec-fetch-site'?: unknown;
}
/**
 * 完整请求围栏：Host 准入 ∪ cross-site 拒绝 ∪ Origin 必等本 authority。
 *
 * 为什么不能只判 Host：本插件路由不校验 content-type（`readJsonBody` 直接裸
 * JSON.parse），所以攻击者能用 `Content-Type: text/plain` 发 JSON —— 那是 CORS 的
 * 「简单请求」，**不触发预检**。这条路上唯一还能拦住跨站写入的就是 Origin /
 * Sec-Fetch-Site 两个头。放宽 Host 接受档（局域网 / 反代域名 / bind 地址）之后若不同步
 * 补这两档，写接口（records-delete / settings-set）就是无差别 CSRF。
 * 这是宿主 `isTrustedApiRequest` 三段式的后两段，`hostFenceAllows` 只对齐了第一段。
 * @param headers - 请求头（至少含 host）。
 * @param ctx - 插件上下文，用于读受信白名单 / 绑定地址。
 * @param scheme - 监听侧协议（决定默认端口归一化）。
 */
export declare function requestFenceAllows(headers: FenceHeaders, ctx: unknown, scheme?: string): boolean;
