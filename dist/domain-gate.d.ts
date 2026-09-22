/** 8 条域锚文本(单一事实源):一段描述该域典型内容的短文本,供向量化。
 *  keywords 是嵌入关闭时的关键词降级匹配词表(命中任一 = 该域相关)。 */
export declare const HALL_ANCHORS: ReadonlyArray<{
    id: string;
    anchor: string;
    keywords: readonly string[];
}>;
/** 软门禁权重下界:相关度 0 的域仍保留 0.4 的权重(降权而非消失——不硬排除)。 */
export declare const HALL_GATE_WEIGHT_FLOOR = 0.4;
/** 无偏置权重(降级到头/无信号时全域恒 1,零干预)。 */
export declare const HALL_GATE_NEUTRAL = 1;
/**
 * 会话级域权重(拖动角点的产物)的取值范围:
 * - `0` = **该域被抑制**(用户把角拖到最内圈 = 本会话不要这个域的记忆);
 * - `1` = 中性(完全跟随智能档的域相关度判定);
 * - `MAX` = 加权上限(把角拖到最外圈 = 该域配额加倍)。
 * 与软门禁的 `HALL_GATE_WEIGHT_FLOOR`(0.4,降权不消失)是两件事:那条是**自动**判定的
 * 下界,这条是**用户显式**拖动,拖到 0 就是要求排除,不该再被 floor 兜回来。
 */
export declare const HALL_WEIGHT_MIN = 0;
export declare const HALL_WEIGHT_MAX = 1.5;
export declare const HALL_WEIGHT_NEUTRAL = 1;
export type DomainGateSource = 'embedding' | 'keyword' | 'none';
export interface DomainGateResult {
    /** 8 个域的召回权重(0.4~1;none 时全 1)。可解释:逐域读出。 */
    weights: Record<string, number>;
    source: DomainGateSource;
}
/** 余弦相似度(向量长度不等/零向量 → 0)。 */
export declare function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number;
/** 嵌入路径:查询向量 × 8 条锚向量 → 每域相关度(余弦 clamp 到 [0,1])→ 权重。 */
export declare function weightsFromVectors(queryVec: ArrayLike<number>, anchorVecs: ReadonlyArray<ArrayLike<number>>): Record<string, number>;
/** 关键词降级路径:查询文本命中某域任一关键词 → 该域权重 0.75;全无命中 → null(无偏置)。 */
export declare function weightsFromKeywords(query: string): Record<string, number> | null;
/**
 * 软门禁主入口(降级阶梯在此收敛)。`embed` 返回 undefined = 嵌入不可用。
 * 锚向量由调用方缓存后传入(`anchorVecs` 与 HALL_ANCHORS 等长;缺省 = 嵌入路径不可用)。
 */
export declare function domainGate(query: string, embed?: {
    queryVec?: ArrayLike<number>;
    anchorVecs?: ReadonlyArray<ArrayLike<number>>;
}): DomainGateResult;
export declare function neutralWeights(): Record<string, number>;
/** 命中域归属:记录的 metadata.hall;未打标/兜底值返回 null(取中性权重)。 */
export declare function domainOfHall(hall: unknown): string | null;
/** 权重的可读日志形态(每次召回可解释:8 个域权重逐个读出)。 */
export declare function formatWeights(weights: Record<string, number>): string;
/** 归一化会话级域权重(拖动角点的写入面):只认 8 角 id,数值 clamp 到 [0, MAX],
 *  非数字/非法 id 一律丢弃;结果为空对象时返回 undefined(= 无用户偏置,不写盘)。 */
export declare function normalizeHallWeights(raw: unknown): Record<string, number> | undefined;
/** 把会话级权重叠到软门禁权重上(相乘):未拖过的角 = 中性 1(判定结果原样保留);
 *  拖到 0 的角 = 0(该域被抑制)。返回新的权重表,不改入参。 */
export declare function applyHallWeights(weights: Record<string, number>, user?: Record<string, number> | null): Record<string, number>;
/** 权重生效后的过滤 + 排序(纯函数,回归锚点):权重 0 的域**整条剔除**(用户拖到底
 *  = 显式抑制,不是降权),其余按"域相关度权重 × 用户权重"降序(同权重按 score)。 */
export declare function gateByDomainWeights<T extends {
    id: string;
    score: number;
}>(hits: readonly T[], hallOf: (id: string) => unknown, weights: Record<string, number>): T[];
/** 手动挡硬过滤(纯函数,回归锚点):锁定集(多选,命中任一)= 只留锁定域;
 *  未打标/跨域按边界开关放行。验证口径:单主题咨询下其他域记忆零注入。 */
export declare function hardFilterByHallLock<T extends {
    id: string;
}>(hits: readonly T[], hallOf: (id: string) => unknown, locks: readonly string[], includeUnlabeled: boolean, includeGeneral: boolean): T[];
/** 软门禁加权排序(纯函数,回归锚点):按域权重降序(同权重按原相关度 score 降序)。
 *  低相关域被降权而非消失——排序 + 预算截断实现"每域配额",不硬排除。 */
export declare function sortByDomainWeight<T extends {
    id: string;
    score: number;
}>(hits: readonly T[], hallOf: (id: string) => unknown, weights: Record<string, number>): T[];
