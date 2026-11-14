/**
 * 面板武装令牌(计划 ext-driver-config-ui T1.2):一次性 nonce,给"只有用户能改配置"
 * 提供 RPC 面的可验证凭据。
 *
 * ## 它防什么、不防什么(诚实边界)
 * - **防**:工具链/其它本机进程直接 POST 写端点。它们没有面板上下文,拿不到 nonce。
 * - **不防**:模型操作用户浏览器去点面板(computer-use)。那等价于"用户在场",
 *   按产品语义就是用户操作——nonce 在这里没有增量价值,不假装能拦。
 *
 * ## 为什么不落盘
 * nonce 是**进程内会话凭据**:重启即失效才是对的语义(重启后面板要重新点一次武装)。
 * 落盘会把"一次性"变成"可复用",与目的相反。
 *
 * 上限 3 + TTL 120s:同一面板反复刷新不涨内存,过期令牌不留场。
 */
import { randomBytes } from 'node:crypto';
const TTL_MS = 120_000;
const MAX_PENDING = 3;
/** nonce → 过期时刻(ms)。Map 插入序 = 签发序,挤兑时淘汰最早。 */
const pending = new Map();
/** 签发一次性令牌:先扫掉过期项,超限则挤掉最早签发的。 */
export function arm(now = Date.now()) {
    for (const [n, exp] of pending) {
        if (exp <= now)
            pending.delete(n);
    }
    while (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next();
        if (oldest.done === true)
            break;
        pending.delete(oldest.value);
    }
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = now + TTL_MS;
    pending.set(nonce, expiresAt);
    return { nonce, expiresAt };
}
/** 消费校验:在场且未过期才通过,且**一次即销**(重放必失败)。 */
export function consume(nonce, now = Date.now()) {
    if (typeof nonce !== 'string' || nonce === '')
        return false;
    const exp = pending.get(nonce);
    if (exp === undefined)
        return false;
    pending.delete(nonce);
    return exp > now;
}
/** 当前未消费令牌数(测试与诊断用)。 */
export function pendingCount() {
    return pending.size;
}
export function resetForTest() {
    pending.clear();
}
