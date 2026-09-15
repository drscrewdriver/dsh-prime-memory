import type { L1Hit, MemoryFamily, MemoryLogger, MemoryRecord } from '../types.js';
import type { GraphNodeSearchResult } from '../graph/types.js';
import type { L1Receipt } from './receipts.js';
import { type EmbeddingService } from './embedding.js';
import { type MemoryDb } from './sqlite.js';
export type RecallStrategy = 'keyword' | 'embedding' | 'hybrid';
/**
 * 图谱路提供者(§D 第 3 路):按查询返回图谱命中(已按 score 降序)。
 * 抽成注入式而非直接读 `db.graphStore`,是为了给 hybrid 融合留一个可替换的测试缝,
 * 并让「未接线 = 恰为 2 路」成为默认行为(既有调用方零行为变化)。
 */
export type GraphLaneProvider = (query: string, limit: number, family?: MemoryFamily) => readonly GraphNodeSearchResult[];
export interface L1SearchOptions {
    /** 按记忆类型精确过滤(后置过滤,官方做法)。 */
    type?: string;
    /** 按族过滤(undefined = 不过滤,即 auto 档与浏览路径;检索唯一缝的族语义)。 */
    family?: MemoryFamily;
    /** 分数阈值(仅召回路径传;keyword/embedding 策略生效,FTS 含小语料例外;
     *  hybrid 按官方语义在 RRF 融合前不过滤)。 */
    scoreThreshold?: number;
    /** 嵌入查询内层钳制(ms,只缩短不放大;召回路径传入给 FTS 降级留时间)。 */
    embeddingTimeoutMs?: number;
}
export declare class L1Store {
    private readonly db;
    private readonly strategy;
    private readonly recordsDir;
    private readonly legacyFile;
    private readonly helper;
    private embedSvc;
    private readonly logger?;
    /** 时效衰减半衰期(天;0=关)。 */
    private readonly decayHalfLifeDays;
    /** §D 第 3 路(图谱回链);缺省 = 不接,恰为 2 路。 */
    private readonly graphLaneProvider?;
    constructor(dataDir: string, db: MemoryDb, embed?: EmbeddingService, strategy?: RecallStrategy, logger?: MemoryLogger, 
    /** 时效衰减半衰期(天;0=关)。缺省 30 与 config 默认一致。 */
    decayHalfLifeDays?: number, 
    /** 图谱路提供者(§D 第 3 路);不传则该路不存在,融合退回双路。 */
    graphLane?: GraphLaneProvider);
    init(): Promise<void>;
    /** 旧版单文件 records.jsonl 一次性导入检索库,成功后改名 .imported。 */
    private importLegacy;
    get size(): number;
    /** 全量读取(调试/迁移用;检索请走 search)。 */
    all(): MemoryRecord[];
    /** 按 id 精确取记录(去重决策的版本号查询用,避免全表扫描)。 */
    getByIds(ids: string[]): MemoryRecord[];
    /**
     * §B 决策凭证落盘(L1Store 的薄缝)。
     * 刻意放在 store 上:`runExtraction` 已经持有 L1Store,凭证写入因此无需新增
     * 构造参数或改动签名;同时它也是「写入失败不中断蒸馏」**可注入的测试缝**——
     * 测试只需替换这一个方法就能模拟落盘故障,不必伪造整个 store。
     */
    recordReceipts(rows: readonly L1Receipt[]): number;
    /** 新记忆落盘:JSONL 按天追加(事实源)+ 检索库 upsert + 向量。 */
    appendNew(records: MemoryRecord[]): Promise<void>;
    /** 去重 update/merge 产出的记录:只更新检索库(JSONL 事实源不改写,官方语义)。 */
    upsert(record: MemoryRecord): Promise<void>;
    /** 活切换嵌入源:同步换底层服务(嵌入源三态切换用)。 */
    setEmbeddingService(svc: EmbeddingService): void;
    deleteBatch(ids: string[]): Promise<void>;
    /**
     * 三策略检索(自动召回与 memory_search 工具共用接缝)。
     * embedding 不可用时自动降级 keyword;type 后置过滤;
     * scoreThreshold 仅对 keyword/embedding 单路策略生效——hybrid 按官方语义
     * 融合完整列表(融合分已归一化 0~1,可直接用于展示/过滤)。
     */
    search(query: string, limit: number, opts?: L1SearchOptions): Promise<L1Hit[]>;
    /**
     * §D 第 4 路(时效路,hybrid 专用):把候选池按 `applyDecayWeight` 加权后的
     * 顺序作为第 4 条**已排序**列表,复用与后处理同源的加权函数(不新增独立逻辑)。
     *
     * **时效是排序信号,不是召回信号**:本路只重排 `ftsList ∪ vecList` 里的既有
     * 候选,**不引入任何新记录**。若让"无关但很新"的记忆靠时效进结果,会直接损害
     * 检索精度——这条性质由 `tests/recency-lane.test.ts` 的 id 集合不变量钉住。
     *
     * **严禁进入 `searchCandidates`**(`search-utils.ts:26-27` 约定):写路径找同语义
     * 旧记录必须**无视新旧**——一旦被时效加权,老的同义记录会被漏检,导致同事实双记录
     * 累积。故本方法只被 `search()` 调用,去重候选路径不得引用。
     */
    private recencyLane;
    /**
     * §D 第 3 路(图谱路径,hybrid 专用):图谱命中 → `sourceRecordIds` 回链 →
     * L1 记录,作为第 3 条**已排序**列表参与 RRF。
     *
     * 为什么值得:图谱是按实体/关系组织的**可重建派生投影**,能召回词法与向量
     * 都命不中的记录(同义表述、关系可达)——这正是本路相对双路的增量。
     *
     * 三条边界:
     * - **异常降级**:图谱是派生投影,不得因它失败而拖垮主检索 → 记 warn、返回空路,
     *   融合退回双路(路数随之降为 2,分数回到既有量纲);
     * - **族隔离**:图谱节点已按族过滤,但其来源记录可能跨族 → 这里再按 `family`
     *   过滤一次。宁可漏不可串(与档位隔离同源,§A 的 P0 关注点);
     * - **墓碑边界**:图谱行可能回链到已被删除的 L1 记录 → 取不到就跳过,
     *   不补空占位(占位会在 RRF 里凭空加分)。
     */
    private graphLane;
    /**
     * 时效衰减加权(#29):三路共用的读路径后处理——阈值过滤之后、截断之前
     * (才能轮转名额,而不只是重排已截断的集合)。updated_at 经主表批量点查
     * 回填(FTS 表无该列;候选池 ≤ limit×3 条主键查询,微秒级)。关闭时零开销。
     */
    private applyDecay;
    /** 浏览列表(UI 用):无关键词时按更新时间倒序分页,支持 Hall 过滤。 */
    list(opts: {
        type?: string;
        scene?: string;
        family?: string;
        hall?: string;
        limit: number;
        offset: number;
    }): {
        items: MemoryRecord[];
        total: number;
    };
    /** 场景名去重列表(UI 筛选器数据源)。 */
    distinctScenes(): string[];
    /**
     * 去重候选召回(官方 3 级):空库跳过 → 向量优先 → FTS 兜底。
     * 传入 family 时只在同族记录里召回(去重永不跨族)。
     */
    searchCandidates(query: string, limit: number, family?: MemoryFamily): Promise<MemoryRecord[]>;
    /**
     * 增量重嵌入(embedding 配置变化 / 周期性补齐用):只处理缺失向量的记录,
     * 排除已判定"当前 provider 不可嵌入"的 skip 集。返回写入/失败/跳过数——
     * failed > 0 时调用方不应标记 meta 同步完成;skipped(零向量)不算失败、
     * 不阻塞同步标记(否则补齐判据永不收敛,周期性全量重嵌死循环)。
     * onProgress/shouldCancel 供活切换的进度展示与取消。
     */
    reindex(opts?: {
        onProgress?: (done: number, total: number) => void;
        shouldCancel?: () => boolean;
    }): Promise<{
        written: number;
        failed: number;
        skipped: number;
        cancelled?: boolean;
    }>;
    private postProcess;
}
