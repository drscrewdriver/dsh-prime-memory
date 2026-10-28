/**
 * L1 记忆 priority 的归一单源（issue #19）。
 *
 * 存在理由：priority 是磁盘契约列，且被 memoryRecall 投影的 `viewSchema` 严格校验
 * （`requireCounter` 判非负整数）。任一写入口把 LLM 回传的负数/超界/小数原样落库，
 * 投影出网即抛 → 宿主把整会话包成 `SESSION_QUERY_CORRUPT_SESSION` → **一条脏数据
 * 打死整个会话历史**。故所有喂进 `l1_records.priority` 的路径必须过同一夹取。
 *
 * 语义（用户选定）：非有限值→`fallback`；小数 `Math.round`；结果夹到整数 `[0,100]`。
 * `fallback` 形参是为保留各写点既有的缺省差异（upsert 绑定层历史上用 50，抽取用 60），
 * 避免为修范围而把某处的默认值静默漂移。
 *
 * 注意：**不动** `store/slots.ts` 里的同名私有 `clampPriority`（floor/50，服务 memorySlots
 * 另一条链）；本文件只服务 L1 记忆 priority。
 */
export const PRIORITY_DEFAULT = 60;
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 100;
/** 夹取到 `[PRIORITY_MIN, PRIORITY_MAX]` 的整数；非有限值回落 `fallback`。 */
export function clampPriority(value, fallback = PRIORITY_DEFAULT) {
    const sanitize = (x) => Math.max(PRIORITY_MIN, Math.min(PRIORITY_MAX, Math.round(x)));
    // null/undefined 显式回落（Number(null) 得 0，若不当缺省处理会把旧 `?? 50` 漂移成 0）。
    if (value === null || value === undefined)
        return sanitize(fallback);
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n))
        return sanitize(fallback);
    return sanitize(n);
}
/** 是否会被夹取改变（负 / 超界 / 非整数 / 非有限 / 缺失）——供读侧判定要不要 warn。 */
export function isDirtyPriority(value) {
    if (value === null || value === undefined)
        return true;
    const n = typeof value === 'number' ? value : Number(value);
    return !Number.isInteger(n) || n < PRIORITY_MIN || n > PRIORITY_MAX;
}
