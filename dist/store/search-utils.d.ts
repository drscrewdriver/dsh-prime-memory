/** 标准 RRF 常数(原论文值);k 越大越偏向低排名项(分布更平滑)。 */
export declare const RRF_K = 60;
/** 衰减地板(#29 时效加权的安全边界):老记忆最多损失一半排序分,永不沉底。
 *
 * flat 档(默认):本常量恒 0.5 且**不进配置**——它是安全机制不是调参旋钮
 * (测试钉死,tests/memory-db.test.ts);95.2% bench 基线在 floor=0.5 下测得,
 * 改它=作废基线(I-6/P0-8)。
 *
 * graded 档(治理 W2,T2.6):`recall.decayFloorByType=true` 时按类型/优先级
 * 分级(`gradedFloorOf`),低优先级档 0.2 是**用户裁决的观察态**(O-1)——
 * 突破 0.5 下界的行为悬崖由 bench flat 对照臂量化,默认关。
 */
export declare const DECAY_FLOOR = 0.5;
/** 激活抬升上限:decayFactor 恒 ≤1(clamp 公式,歧义①解——治理不污染 score 标度)。 */
export declare const ACTIVATION_MAX_BOOST = 0.3;
/** 被动注入计数的抬升系数(有损下界,P1-9;log1p 饱和)。 */
export declare const ACTIVATION_INJ_COEF = 0.05;
/** 人工采用标记的抬升系数(强信号,注入的 3 倍;O-2)。 */
export declare const ACTIVATION_ADP_COEF = 0.15;
/**
 * 激活抬升(治理 W2,T2.5):boost = min(MAX_BOOST, log1p(inj)×0.05 + log1p(adp)×0.15)。
 * 无激活数据(undefined)→ 0(存量零漂移:不奖不罚)。
 */
export declare function activationBoostOf(counts: {
    injectionCount?: unknown;
    adoptedCount?: unknown;
} | undefined): number;
/**
 * 分级地板(治理 W2,T2.6;仅 `recall.decayFloorByType=true` 时被调用)。
 * 判 **normalizePriority 收敛后落库的 rec.priority**(O-9,不猜原始值)。
 * 档位表(spec §二,`-1` 哨兵**先于 <50** 判定):instruction(含-1)→0.9 /
 * priority<50→0.2 / persona≥80→0.9 / persona→0.5 / work_fact·work_method→0.5 /
 * work_task·work_artifact·episodic→0.3 / 兜底 0.5。代码库无 safety 类型(评审纠正)。
 */
export declare function gradedFloorOf(rec: {
    type?: unknown;
    priority?: unknown;
} | undefined): number;
/** 哨兵开关:生产(NODE_ENV=production)关闭,其余(dev/test)生效。 */
export declare const GOVERNANCE_SENTINEL_ACTIVE: boolean;
/**
 * 标记"回调及其异步下游处于 searchCandidates(去重候选)路径内"。
 * 仅 MemoryDb.searchCandidates 入口调用;生产 no-op 直通。
 */
export declare function markDedupPath<T>(fn: () => T): T;
/**
 * 治理代码(召回侧权重/floorOf/激活等)入口自证清白:若当前处于去重候选
 * 路径内则抛错。`who` 传函数/模块名,崩溃信息可直接定位肇事者。
 * 生产 no-op。
 */
export declare function assertNotDedupPath(who: string): void;
/** 治理扩展位(治理 W2,T2.5/T2.6):全部可选,缺省 = 逐字现状(flat 地板 + updatedAt 锚 + 无抬升)。 */
export interface DecayWeightOptions<T> {
    /** 分级地板resolver(decayFloorByType=true 时传 gradedFloorOf;缺省恒 DECAY_FLOOR)。 */
    floorOf?: (hit: T) => number;
    /** 老化锚点 resolver(激活启用时传 decayAnchorAt ?? updatedAt;缺省用 updatedAtOf)。 */
    anchorAtOf?: (hit: T) => number | undefined;
    /** 激活抬升 resolver(activation.enabled 时传 activationBoostOf;缺省恒 0)。 */
    boostOf?: (hit: T) => number;
}
/**
 * 时效衰减加权(#29,读路径专用):score × max(FLOOR, 0.5^(Δ天/半衰期)) 后重排序。
 *
 * - Δ 按 updated_at(内容版本时间)起算,缺失/非法按最老 → 地板接管(零特判分支);
 * - 乘法保相关性主导:只在相关度相近的候选之间轮转名次,不淘汰不硬过滤;
 *   hit 的原 score 字段不被改写(排序用加权分,展示仍反映检索相关度);
 * - halfLifeDays ≤ 0 直接原样返回(开关关闭);
 * - 仅用于召回/工具检索;searchCandidates(去重候选)不得应用——写路径找同语义
 *   旧记录要无视新旧,衰减会让去重漏检(同事实双记录);
 * - **治理 W2(T2.5)**:opts 提供分级地板/激活锚点/激活抬升三个扩展位,合成
 *   `decayFactor = min(1, max(floorOf, 0.5^(Δ/半衰期)) × (1 + boost))` ——
 *   clamp ≤1 保证标度不变(歧义①解);全 opts 缺省时与升级前**逐字等价**(I-10)。
 */
export declare function applyDecayWeight<T extends {
    score: number;
}>(hits: T[], halfLifeDays: number, updatedAtOf: (hit: T) => number | undefined, now?: number, opts?: DecayWeightOptions<T>): T[];
/**
 * RRF 融合多个已排序列表:每项得分 = 各列表 1/(k + rank + 1) 之和。
 * 出现在多个列表的项得分累加,按得分降序返回(附 rrfScore)。
 */
export declare function rrfMerge<T>(lists: T[][], getId: (item: T) => string, k?: number): Array<T & {
    rrfScore: number;
}>;
/**
 * RRF 原始分归一化到 0~1(hybrid 检索的展示/比较分)。
 *
 * n 条列表融合时,单项最高原始分为 n/(k+1)(各列表 rank1 全中),故按**实际路数**
 * lanes 归一:`rrfScore × (k+1) / lanes`,满分恰好 1.0,天然不越界。
 * 旧实现把分母硬编码为 2,只对「FTS + 向量」双路成立;扩至 3/4 路后满分分别
 * 达到 1.5 / 2.0,越出契约。2 路时本式与旧式逐字等价(无行为漂移)。
 *
 * 按「传入的路数」而非「非空路数」归一是有意的:向量源不可用时调用方仍传两条
 * 列表(其一为空),旧实现给 FTS rank1 的分数是 0.5;按非空路数会变成 1.0,
 * 反而破坏 2 路无漂移判据。
 *
 * 守卫:lanes 非正或非有限 → 0(退化输入不产生 NaN/Infinity)。
 */
export declare function normalizeRrf(rrfScore: number, lanes: number): number;
/** FTS5 bm25 rank(负值=更相关)转 0~1 分数。 */
export declare function bm25RankToScore(rank: number): number;
/**
 * 把自然语言查询构造成 FTS5 MATCH 表达式:token 引号化后 OR 连接,
 * 命中任一 token 即返回,BM25 自然把命中多 token 的文档排前——
 * 长查询与纯 FTS 模式(无向量)下召回率显著优于整句匹配。
 */
export declare function buildFtsQuery(raw: string): string | null;
/**
 * 写入侧分词:tokenize 后空格连接,交给 FTS5 unicode61 切词建索引。
 * 与 buildFtsQuery 用同一分词器,保证查询 token 在索引中可命中。
 */
export declare function tokenizeForFts(raw: string): string;
