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
 * 为何还要读进程参数：实测 0.2.2-rc.1 装机环境下，插件 ctx 读 webStartup / webRuntime
 * 取到 undefined（cordis Proxy 面与作用域可见性都可能挡），只读服务会退化成「只认
 * loopback」，重启後照旧 403。`--trusted-host` 的权威来源就是进程参数，故服务读取
 * 失败时以它兜底。
 */
/** `--trusted-host` 的启动参数名（repeatable，可变参）。 */
const TRUSTED_HOST_FLAG = '--trusted-host';
/** Host 头是否为 loopback 主机名(localhost / [::1] / 127.x.x.x)。 */
export function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]')
        return true;
    const parts = hostname.split('.');
    return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
/** 把 `host` / `host:port` 解析成 URL；非法值返回 undefined（不抛）。 */
function parseAuthority(authority, scheme = 'http:') {
    try {
        return new URL(`${scheme}//${authority}`);
    }
    catch {
        return undefined;
    }
}
/**
 * 白名单条目的 canonical authority：**带端口**返回 `host:port`，**不带端口**只返回
 * hostname。两个 scheme 各解一次，才能区分「用户真没写端口」与「写了本 scheme 的
 * 默认端口而被 URL 吃掉」——与宿主 isTrustedAuthority 的判据同款。
 */
function canonicalAuthority(entry, url) {
    const port = url.port !== '' ? url.port : new URL(`${url.protocol === 'http:' ? 'https:' : 'http:'}//${entry}`).port;
    return port === '' ? url.hostname : `${url.hostname}:${port}`;
}
/**
 * 请求 authority 是否命中白名单。带端口的条目只匹配该精确 authority；不带端口的
 * 条目匹配任意端口的同名主机。两侧都走 WHATWG 归一化，故大小写与冗余的默认端口
 * 不参与判定。
 * @param hostUrl - 已解析的请求 Host。
 * @param entries - `--trusted-host` 条目（verbatim）。
 * @param scheme - 监听侧协议，决定默认端口如何被 URL 吃掉。
 */
export function matchesTrustedAuthority(hostUrl, entries, scheme = 'http:') {
    return entries.some((entry) => {
        const entryUrl = parseAuthority(entry, scheme);
        if (entryUrl === undefined)
            return false;
        return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
            ? entryUrl.hostname === hostUrl.hostname
            : entryUrl.host === hostUrl.host;
    });
}
/**
 * 读 webStartup / webRuntime 的 trustedHosts（best-effort）。
 *
 * 宿主 0.2.1-a.2 起把 webRuntime 更名成 webStartup，两个名字都试；未声明 inject 时
 * cordis Proxy 面对属性读直接抛，故两层 try + 双名回退，取不到一律 undefined。
 * @param ctx - 插件上下文（只用到属性读与可选的 ctx.get）。
 */
export function readStartupTrustedHosts(ctx) {
    if (ctx === null || ctx === undefined)
        return undefined;
    const carrier = ctx;
    for (const name of ['webStartup', 'webRuntime']) {
        try {
            const direct = carrier[name];
            const svc = (direct !== undefined
                ? direct
                : typeof carrier.get === 'function'
                    ? carrier.get(name)
                    : undefined);
            if (svc !== null && typeof svc === 'object' && Array.isArray(svc.trustedHosts)) {
                const list = svc.trustedHosts.filter((v) => typeof v === 'string' && v.trim() !== '');
                if (list.length > 0)
                    return list;
            }
        }
        catch {
            /* 未声明服务的属性读抛:落下一名/缺省 */
        }
    }
    return undefined;
}
/**
 * 从进程参数解析 `--trusted-host`（repeatable，且单个 flag 后可跟多个值）。
 * @param argv - 默认 `process.argv`；测试可注入。
 */
export function readTrustedHostsFromArgv(argv = process.argv) {
    const out = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = String(argv[i]);
        if (!arg.startsWith(TRUSTED_HOST_FLAG))
            continue;
        const eq = arg.indexOf('=');
        if (eq !== -1) {
            const value = arg.slice(eq + 1).trim();
            if (value !== '')
                out.push(value);
            continue;
        }
        let j = i + 1;
        while (j < argv.length && !String(argv[j]).startsWith('-')) {
            const value = String(argv[j]).trim();
            if (value !== '')
                out.push(value);
            j += 1;
        }
        i = j - 1;
    }
    return out;
}
/**
 * 当前进程的受信 authority 列表：宿主服务优先，取不到再读进程参数。
 * @param ctx - 插件上下文。
 */
export function resolveTrustedAuthorities(ctx) {
    const fromService = readStartupTrustedHosts(ctx);
    if (fromService !== undefined && fromService.length > 0)
        return fromService;
    return readTrustedHostsFromArgv();
}
/** 归一化主机名：去 zone id、去 IPv6 方括号、小写——绑定地址的两种写法都要能对上。 */
function normalizeHostname(raw) {
    let host = String(raw).trim().toLowerCase();
    const zone = host.indexOf('%');
    if (zone !== -1)
        host = host.slice(0, zone);
    if (host.startsWith('[') && host.endsWith(']'))
        host = host.slice(1, -1);
    return host;
}
/**
 * 读宿主 `--host` 绑定的接口地址（归一化主机名，不含端口）。
 *
 * 与容器的 bindAddress 一档对齐：把 dsh web 绑到具体非 loopback 网卡时，浏览器直连
 * 该地址发出的 Host 就是它，宿主的 fence 认，插件不认就会「本机直连也 403」。
 * 绑定地址不是 DNS 重绑定目标，放行它不额外授予任何东西（端口不参与判定，同宿主）。
 * @param ctx - 插件上下文（只读 webServer 服务面）。
 */
export function readBindHostname(ctx) {
    if (ctx === null || ctx === undefined)
        return undefined;
    const carrier = ctx;
    try {
        const direct = carrier.webServer;
        const svc = (direct !== undefined
            ? direct
            : typeof carrier.get === 'function'
                ? carrier.get('webServer')
                : undefined);
        if (svc !== null && typeof svc === 'object' && typeof svc.host === 'string' && svc.host.trim() !== '') {
            return normalizeHostname(svc.host);
        }
    }
    catch {
        /* 未声明服务的属性读抛:当作没有绑定地址 */
    }
    return undefined;
}
/**
 * 围栏判定：Host 解析得出的 authority 命中 loopback 或受信白名单才放行。
 * @param host - 请求头里的 Host（verbatim）。
 * @param ctx - 插件上下文，用于读受信白名单。
 * @param scheme - 监听侧协议（决定默认端口归一化）。
 */
export function hostFenceAllows(host, ctx, scheme = 'http:') {
    if (typeof host !== 'string' || host.length === 0)
        return false;
    const hostUrl = parseAuthority(host, scheme);
    if (hostUrl === undefined)
        return false;
    if (isLoopbackHostname(hostUrl.hostname))
        return true;
    const bindHostname = readBindHostname(ctx);
    if (bindHostname !== undefined && normalizeHostname(hostUrl.hostname) === bindHostname)
        return true;
    return matchesTrustedAuthority(hostUrl, resolveTrustedAuthorities(ctx), scheme);
}
