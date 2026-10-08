/**
 * 检索工具:
 * - rrfMerge:RRF(Reciprocal Rank Fusion,k=60)多路结果融合,hybrid 检索用;
 * - normalizeRrf:RRF 原始分按实际路数归一化到 0~1(hybrid 展示分);
 * - bm25RankToScore:FTS5 bm25 rank(负值=更相关)转 0~1 分数;
 * - applyDecayWeight:#29 时效衰减加权(读路径专用);
 * - markDedupPath / assertNotDedupPath:去重路径运行时哨兵(治理红线,见下);
 * - buildFtsQuery / tokenizeForFts:FTS5 查询构造与写入侧分词。
 *   分词走 util/text.ts 的 tokenize,读写两侧共用同一分词器,保证查询 token
 *   与索引 token 对齐;FTS 索引按分词器版本戳自动重建(sqlite.ts)。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { tokenize } from '../util/text.js';
import { PRIORITY_ABSOLUTE_INSTRUCTION, PRIORITY_DEFAULT_STORE } from './priority.js';
/** 标准 RRF 常数(原论文值);k 越大越偏向低排名项(分布更平滑)。 */
export const RRF_K = 60;
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
export const DECAY_FLOOR = 0.5;
// ── 激活抬升常量(治理 W2,T2.5;安全机制不进配置,ADR-0006 条9 同款) ──
/** 激活抬升上限:decayFactor 恒 ≤1(clamp 公式,歧义①解——治理不污染 score 标度)。 */
export const ACTIVATION_MAX_BOOST = 0.3;
/** 被动注入计数的抬升系数(有损下界,P1-9;log1p 饱和)。 */
export const ACTIVATION_INJ_COEF = 0.05;
/** 人工采用标记的抬升系数(强信号,注入的 3 倍;O-2)。 */
export const ACTIVATION_ADP_COEF = 0.15;
/**
 * 激活抬升(治理 W2,T2.5):boost = min(MAX_BOOST, log1p(inj)×0.05 + log1p(adp)×0.15)。
 * 无激活数据(undefined)→ 0(存量零漂移:不奖不罚)。
 */
export function activationBoostOf(counts) {
    if (!counts)
        return 0;
    const inj = Math.max(0, Number(counts.injectionCount) || 0);
    const adp = Math.max(0, Number(counts.adoptedCount) || 0);
    return Math.min(ACTIVATION_MAX_BOOST, Math.log1p(inj) * ACTIVATION_INJ_COEF + Math.log1p(adp) * ACTIVATION_ADP_COEF);
}
/**
 * 分级地板(治理 W2,T2.6;仅 `recall.decayFloorByType=true` 时被调用)。
 * 判 **normalizePriority 收敛后落库的 rec.priority**(O-9,不猜原始值)。
 * 档位表(spec §二,`-1` 哨兵**先于 <50** 判定):instruction(含-1)→0.9 /
 * priority<50→0.2 / persona≥80→0.9 / persona→0.5 / work_fact·work_method→0.5 /
 * work_task·work_artifact·episodic→0.3 / 兜底 0.5。代码库无 safety 类型(评审纠正)。
 */
export function gradedFloorOf(rec) {
    if (!rec)
        return DECAY_FLOOR;
    const type = typeof rec.type === 'string' ? rec.type : '';
    const p = Number(rec.priority ?? PRIORITY_DEFAULT_STORE);
    const finite = Number.isFinite(p);
    if (type === 'instruction' && p === PRIORITY_ABSOLUTE_INSTRUCTION)
        return 0.9;
    if (finite && p >= 0 && p < 50)
        return 0.2;
    if (type === 'instruction')
        return 0.9;
    if (type === 'persona')
        return finite && p >= 80 ? 0.9 : 0.5;
    if (type === 'work_fact' || type === 'work_method')
        return 0.5;
    if (type === 'work_task' || type === 'work_artifact' || type === 'episodic')
        return 0.3;
    return 0.5;
}
// ── 去重路径运行时哨兵(治理升级 Wave 0,T0.2)────────────────────────────
// 红线只写在注释挡不住机械失误(P0-1:治理权重混进去重候选路径 → 去重漏检 →
// 同事实双记录正反馈,且症状完全隐形)。searchCandidates 进入时用
// AsyncLocalStorage 标记"当前处于去重路径";治理代码入口调用
// assertNotDedupPath('自己名字') 自证清白——误入即抛,把隐形污染变成显式崩溃。
// dev/test 生效,生产构建整体 no-op(零行为面)。
const dedupPathStorage = new AsyncLocalStorage();
/** 哨兵开关:生产(NODE_ENV=production)关闭,其余(dev/test)生效。 */
export const GOVERNANCE_SENTINEL_ACTIVE = process.env.NODE_ENV !== 'production';
/**
 * 标记"回调及其异步下游处于 searchCandidates(去重候选)路径内"。
 * 仅 MemoryDb.searchCandidates 入口调用;生产 no-op 直通。
 */
export function markDedupPath(fn) {
    if (!GOVERNANCE_SENTINEL_ACTIVE)
        return fn();
    return dedupPathStorage.run(true, fn);
}
/**
 * 治理代码(召回侧权重/floorOf/激活等)入口自证清白:若当前处于去重候选
 * 路径内则抛错。`who` 传函数/模块名,崩溃信息可直接定位肇事者。
 * 生产 no-op。
 */
export function assertNotDedupPath(who) {
    if (!GOVERNANCE_SENTINEL_ACTIVE)
        return;
    if (dedupPathStorage.getStore()) {
        throw new Error(`[governance] ${who} 出现在 searchCandidates(去重候选)路径内——违反 search-utils 红线:` +
            '去重候选必须无视治理权重(衰减/地板/激活/scope/tier),否则去重漏检、同事实双记录累积(P0-1)');
    }
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
export function applyDecayWeight(hits, halfLifeDays, updatedAtOf, now = Date.now(), opts = {}) {
    if (!(halfLifeDays > 0) || hits.length === 0)
        return hits;
    const weight = (h) => {
        const anchorOf = opts.anchorAtOf ?? updatedAtOf;
        const t = anchorOf(h);
        const floor = opts.floorOf ? opts.floorOf(h) : DECAY_FLOOR;
        const boost = opts.boostOf ? opts.boostOf(h) : 0;
        if (t == null || !Number.isFinite(t))
            return Math.min(1, floor * (1 + boost));
        const days = Math.max(0, (now - t) / 86_400_000);
        return Math.min(1, Math.max(floor, 0.5 ** (days / halfLifeDays)) * (1 + boost));
    };
    return hits
        .map((h) => ({ h, weighted: h.score * weight(h) }))
        .sort((a, b) => b.weighted - a.weighted)
        .map((x) => x.h);
}
/**
 * RRF 融合多个已排序列表:每项得分 = 各列表 1/(k + rank + 1) 之和。
 * 出现在多个列表的项得分累加,按得分降序返回(附 rrfScore)。
 */
export function rrfMerge(lists, getId, k = RRF_K) {
    const map = new Map();
    for (const list of lists) {
        for (let rank = 0; rank < list.length; rank++) {
            const item = list[rank];
            const id = getId(item);
            const score = 1 / (k + rank + 1);
            const existing = map.get(id);
            if (existing) {
                existing.rrfScore += score;
            }
            else {
                map.set(id, { item, rrfScore: score });
            }
        }
    }
    return [...map.values()]
        .sort((a, b) => b.rrfScore - a.rrfScore)
        .map(({ item, rrfScore }) => ({ ...item, rrfScore }));
}
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
export function normalizeRrf(rrfScore, lanes) {
    if (!Number.isFinite(lanes) || lanes <= 0)
        return 0;
    return (rrfScore * (RRF_K + 1)) / lanes;
}
/** FTS5 bm25 rank(负值=更相关)转 0~1 分数。 */
export function bm25RankToScore(rank) {
    if (!Number.isFinite(rank))
        return 1 / (1 + 999);
    if (rank < 0) {
        const relevance = -rank;
        return relevance / (1 + relevance);
    }
    return 1 / (1 + rank);
}
/** 高频中文虚词,进 FTS 查询只添噪声。 */
const ZH_STOP_WORDS = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
    '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那',
    '吗', '吧', '呢', '啊', '呀', '哦', '嗯',
]);
/**
 * 把自然语言查询构造成 FTS5 MATCH 表达式:token 引号化后 OR 连接,
 * 命中任一 token 即返回,BM25 自然把命中多 token 的文档排前——
 * 长查询与纯 FTS 模式(无向量)下召回率显著优于整句匹配。
 */
export function buildFtsQuery(raw) {
    const tokens = [...new Set(tokenize(raw).filter((t) => !ZH_STOP_WORDS.has(t)))];
    if (tokens.length === 0)
        return null;
    const quoted = tokens.map((t) => `"${t.replaceAll('"', '')}"`);
    return quoted.join(' OR ');
}
/**
 * 写入侧分词:tokenize 后空格连接,交给 FTS5 unicode61 切词建索引。
 * 与 buildFtsQuery 用同一分词器,保证查询 token 在索引中可命中。
 */
export function tokenizeForFts(raw) {
    return tokenize(raw).join(' ');
}
