/**
 * 驱动配置面纯函数(计划 ext-driver-config-ui T1.1):校验、合并、删除 `ext_memory.drivers[]`。
 *
 * ## 为什么校验必须在服务端而不是 UI
 * UI 的必填/格式提示只是便利;RPC 是公开写口,校验缺失就等于"绕过面板即可写入非法配置"。
 * 非法配置最坏的后果不是报错而是静默半生效:装配期 `assertRuntime` 会拒绝并跳过该驱动,
 * 用户在面板看到"配置已保存"但驱动从不出现——所以形状与白名单在这里一次收口。
 *
 * ## apiKey 的两条纪律(与 T3.5 凭据面配套)
 * 1. **不回显**:任何返回给 client 的形状都不含明文(调用方拿不到就等于不会写错),
 *    因此 upsert 必须支持"空串 = 保持原值"——否则用户每改一次 endpoint 就得重填密钥,
 *    留空即清空是比拒绝更坏的失败;
 * 2. **推荐 `secret://ref`**:值本身是引用而非机密,可安全存在于 profile。
 */
import { EXT_DRIVER_TYPES } from './types.js';
/** 驱动 id 形状:小写起头、可含数字点横线下划线、≤32。 */
export const DRIVER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
function str(raw) {
    return typeof raw === 'string' ? raw.trim() : '';
}
/** 长度超限拒绝而不是静默截断:截断会造出一个“用户写的不是存进去的”的隐性改名。 */
function lenError(name, value, max) {
    return value.length > max ? `${name} 过长(${value.length} > ${max})` : undefined;
}
/** endpoint 判据:HTTP(S) baseUrl 或本地绝对路径(CLI/store 型驱动)。 */
function endpointLooksValid(v) {
    if (/^https?:\/\//iu.test(v))
        return true;
    // POSIX 绝对路径 或 Windows 盘符路径(holographic 用 store 文件、mnemon-native 用可执行/数据目录)
    return /^\//u.test(v) || /^[A-Za-z]:[\\/]/u.test(v) || /^[\\\\]{2}/u.test(v);
}
/**
 * 入参规范化:字段裁剪 + 白名单校验。
 * `type` 走 `EXT_DRIVER_TYPES`(9 类)而非 schema union——配置面纪律禁 union,
 * 且 union 会炸配置树(Phase 0 记录),白名单在消费侧收口。
 */
export function normalizeDriverInput(raw) {
    if (typeof raw !== 'object' || raw === null)
        return { ok: false, error: '需要对象' };
    const o = raw;
    const id = str(o.id);
    const type = str(o.type);
    const endpoint = str(o.endpoint);
    const space = str(o.space);
    const extra = str(o.extra);
    const apiKey = str(o.apiKey);
    const tooLong = lenError('id', id, 32) ??
        lenError('type', type, 32) ??
        lenError('endpoint', endpoint, 512) ??
        lenError('apiKey', apiKey, 512) ??
        lenError('space', space, 200) ??
        lenError('extra', extra, 2000);
    if (tooLong !== undefined)
        return { ok: false, error: tooLong };
    if (!DRIVER_ID_RE.test(id)) {
        return { ok: false, error: `id 非法:须小写字母或数字起头、可含 . _ -、长度 ≤32(收到「${id}」)` };
    }
    if (!EXT_DRIVER_TYPES.includes(type)) {
        return { ok: false, error: `type「${type}」不在 9 类清单(${EXT_DRIVER_TYPES.join('/')})` };
    }
    if (endpoint === '') {
        return { ok: false, error: 'endpoint 必填(http(s):// 或绝对路径)' };
    }
    if (!endpointLooksValid(endpoint)) {
        return { ok: false, error: `endpoint「${endpoint}」须为 http(s):// 开头或绝对路径` };
    }
    if (extra !== '') {
        try {
            const parsed = JSON.parse(extra);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                return { ok: false, error: 'extra 须为 JSON 对象(或空串)' };
            }
        }
        catch (err) {
            return { ok: false, error: `extra 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}` };
        }
    }
    return {
        ok: true,
        meta: { enabledProvided: o.enabled !== undefined },
        driver: {
            id,
            type,
            // 缺省当“未说”处理(缺省 true 仅供新建);更新侧靠 meta 分辨“未传”与“显式 false”
            enabled: o.enabled === undefined ? true : o.enabled === true,
            endpoint,
            apiKey,
            space,
            extra,
        },
    };
}
/**
 * upsert：同 id 原位替换（保持列表顺序稳定，面板不会因编辑跳行），不同 id 追加。
 *
 * **空 apiKey = 保留旧值**：client 侧永远拿不到明文，若不保留就等于“改任何字段都会清空密钥”。
 * 新驱动（id 不存在）时空串就是真空值（holographic/自托管可无 key），不做特殊处理。
 *
 * `enabledProvided` 同理：面板只改 endpoint 时不带 enabled，若无条件用 normalize 的缺省 true，
 * “已停用”的驱动会被静默启用——这类“没动的字段被动了”是配置面最难发现的一类坑。
 */
export function upsertDriverInList(list, driver, meta = { enabledProvided: true }) {
    const idx = list.findIndex((d) => d.id === driver.id);
    if (idx === -1)
        return { list: [...list, driver], created: true };
    const prev = list[idx];
    const next = {
        ...driver,
        apiKey: driver.apiKey === '' ? prev.apiKey : driver.apiKey,
        // space 留空同样保留:它是 namespace 定位符,编辑 endpoint 时不该被抹平
        space: driver.space === '' ? prev.space : driver.space,
        extra: driver.extra === '' ? prev.extra : driver.extra,
        enabled: meta.enabledProvided ? driver.enabled : prev.enabled,
    };
    const out = list.slice();
    out[idx] = next;
    return { list: out, created: false };
}
/** remove：按 id 摘除;不存在时原样返回(幂等，删除已消失的驱动不是错误)。 */
export function removeDriverFromList(list, id) {
    const next = list.filter((d) => d.id !== id);
    return { list: next, removed: next.length !== list.length };
}
/**
 * 单条写前的列表健康检查：`id` 形状不合法或**目标准则会被写入的列表里存在重复 id** 时返回错误。
 *
 * 重复 id 不是假想敌：profile YAML 可以手写出两条同 id，而装配侧 `registry.register`
 * 同名会覆写——于是“配置里两条”实际只有一条在跑，面板按 id 回显时更是无法区分。
 * 写入前拒住（并提示先人工清理）比默默合并诚实：用户改的是哪一条，系统得能回答。
 */
export function driverErrorOf(list, id) {
    if (!DRIVER_ID_RE.test(id))
        return `驱动 id「${id}」形状不合法（小写字母/数字起头，可含 . _ -，≤32）`;
    const dup = list.filter((d) => d.id === id).length;
    if (dup > 1)
        return `配置里有 ${dup} 条同 id 驱动「${id}」：请先人工合并为一条再在面板改`;
    return undefined;
}
/** 全表健康检查：重复 id 与非法形状逐条给出错误串（空数组 = 可安全写入）。 */
export function driverListErrors(list) {
    const out = [];
    const seen = new Set();
    const twice = new Set();
    for (const d of list) {
        if (seen.has(d.id))
            twice.add(d.id);
        seen.add(d.id);
    }
    for (const id of twice)
        out.push(`重复 id「${id}」`);
    for (const d of list) {
        if (!DRIVER_ID_RE.test(d.id))
            out.push(`非法 id「${d.id}」`);
        if (!EXT_DRIVER_TYPES.includes(d.type))
            out.push(`驱动「${d.id || '(无 id)'}」的 type「${d.type}」不在 9 类清单`);
    }
    return out;
}
/**
 * 总闸写后读回：与 drivers 同理，“宿主是否真按提交值落了 enabled”不在我们手里。
 * 只比 `enabled` 一个字段（它是个标量，不存在数组深合并残留那类坑）。
 */
export function verifyEnabledReadback(expected, readback) {
    if (readback === undefined || readback === null || typeof readback !== 'object') {
        return { state: 'unverified', message: '宿主未供配置读回能力：总闸写入已提交，但未校验（重载后请在面板核对）。' };
    }
    const got = readback.enabled;
    if (got !== expected) {
        return { state: 'mismatch', message: `总闸读回与提交不一致：extMemory.enabled=${String(got)}，提交的是 ${String(expected)}：请核对 profile。` };
    }
    return { state: 'confirmed', message: '' };
}
/** 面板回读用的脱敏形状:只说"密钥是否已配置",永不带出明文或长度指纹。 */
export function toPublicDriver(d) {
    const ref = d.apiKey.startsWith('secret://') ? d.apiKey.slice('secret://'.length) : '';
    return { id: d.id, type: d.type, enabled: d.enabled, endpoint: d.endpoint, space: d.space, hasApiKey: d.apiKey !== '', secretRef: ref };
}
/** 读回比对的字段集：不含 `apiKey`——它写出去是明文、读回来可能被脱敏，比不得。 */
const READBACK_KEYS = ['id', 'type', 'enabled', 'endpoint', 'space', 'extra'];
/**
 * 写后读回比对：把"宿主 `forms.update` 对数组的合并语义未知"变成**运行时自检**。
 *
 * 为什么需要它：如果宿主是按下标深合并，写短了的 drivers 数组会**残留尾部旧元素**：
 * 面板显示已删、profile 里驱动还在、重载后它又出现。这不是假想风险，而是 patch 型
 * 配置写入的经典坑。读回不一致时调用方必须报"未完全生效"，而不是假定成功。
 *
 * `readback` 为 undefined = 宿主不供读回能力 → `unverified`（降级不谎报，也不阻断）。
 * 比对口径用身份与路由字段，不比 apiKey（写出去是明文、读回来可能被脱敏）。
 */
export function verifyDriversReadback(expected, readback) {
    if (readback === undefined || readback === null || typeof readback !== 'object') {
        return { state: 'unverified', message: '宿主未供配置读回能力：写入已提交，但 drivers 合并结果未校验（重载后请在驱动列表核对）。' };
    }
    const got = readback.drivers;
    if (!Array.isArray(got)) {
        return { state: 'mismatch', message: '读回的 extMemory.drivers 不是数组：profile 可能未被正确写入，请核对 YAML。' };
    }
    const actual = got;
    if (actual.length !== expected.length) {
        const extra = actual.filter((a) => !expected.some((e) => e.id === a.id)).map((a) => String(a.id ?? '')).filter((s) => s !== '');
        return {
            state: 'mismatch',
            message: extra.length > 0
                ? `宿主合并后多出 ${extra.length} 条驱动（id：${extra.join('/')}）：典型为数组按下标深合并残留，请手工清理 profile 的 ext_memory.drivers。`
                : `宿主合并后 drivers 条数为 ${actual.length}，提交的是 ${expected.length}：请核对 profile。`,
        };
    }
    for (let i = 0; i < expected.length; i++) {
        const want = expected[i];
        const have = actual[i];
        const bad = READBACK_KEYS.filter((k) => have?.[k] !== want[k]);
        if (bad.length > 0) {
            return { state: 'mismatch', message: `驱动「${want.id}」读回与提交不一致（字段：${bad.join('/')}）：请核对 profile。` };
        }
    }
    return { state: 'confirmed', message: '' };
}
