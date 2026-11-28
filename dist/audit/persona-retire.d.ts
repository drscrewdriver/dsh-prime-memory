/**
 * 存量去人格化（persona-leak-guardrails task_6.1）。
 *
 * 与「审计」分工明确：审计**只报告**（默认不改库），本模块**显式改库**且必须人工点名触发。
 *
 * 写面纪律（踩过的坑都在这里）：
 *  1. **摘特征后保留**（裁决①）——「本鱼已核实 X」→「已核实 X」，不是删条目；
 *  2. **摘完为空才退场**，且走 `L1Store.retire()` 这个汇流口——退场判据是全仓唯一的
 *     `dsh_superseded` 标记，不是某个 `retired` 列（库里根本没有那列）；
 *  3. **改正文走 `reviseInPlace`**：它会同时更新检索库 + `l1_fts` + **JSONL 追加版本行**。
 *     只改 DB 而事实源留旧文，下次「重建记忆」会把旧人格词静默回滚。
 */
import { type PersonaLeakTerms } from './persona-terms.js';
import type { MemoryRecord } from '../types.js';
/** 去人格化需要的 L1Store 窄面（只取两个方法，测试可喂假身）。 */
export interface RetireStoreLike {
    getByIds(ids: string[]): MemoryRecord[];
    reviseInPlace(record: MemoryRecord): Promise<void>;
    retire(ids: string[], info: {
        at: string;
        reason: 'manual' | 'obsolete' | 'superseded' | 'conflict';
    }): number;
    /** 分页取活跃记录（全库扫描用）。 */
    list(opts: {
        retired?: boolean;
        limit: number;
        offset: number;
    }): {
        items: MemoryRecord[];
        total: number;
    };
}
/**
 * 分页取出全部活跃 L1 记录。
 *
 * 为什么不用一次大 limit：真机 2436 条还能一把捞，但这个数是会长大的，
 * 而一次性把几千条正文塞进数组的代价是峰值内存——分页是免费的保险。
 */
export declare function collectActiveRecords(store: Pick<RetireStoreLike, 'list'>, pageSize?: number): MemoryRecord[];
export interface RetirePlan {
    scanned: number;
    /** 摘特征后仍保留的条目（内容被改写）。 */
    rewritten: Array<{
        record: MemoryRecord;
        content: string;
        before: number;
        after: number;
    }>;
    /** 摘完为空、需要退场的条目。 */
    emptied: MemoryRecord[];
}
/**
 * 纯计划：只算「改哪些、退哪些」，**不写库**。
 *
 * 抽成纯函数是为了让「摘完为空才退」这条判据可以被单测钉住——藏在写路径里就只剩真机可验。
 */
export declare function planPersonaRetire(records: readonly MemoryRecord[], terms: PersonaLeakTerms): RetirePlan;
export interface RetireOutcome {
    scanned: number;
    rewritten: Array<{
        recordId: string;
        name: string;
        before: number;
        after: number;
    }>;
    emptied: Array<{
        recordId: string;
        name: string;
    }>;
    /** dryRun 时两个数组仍会填（预览），但库不变。 */
    applied: boolean;
}
export interface RetireOptions {
    /** 只算不写（默认 **true**——误删不可逆，必须显式 `dryRun: false`）。 */
    dryRun: boolean;
    /** 词表；缺省现读 spirit 数据。 */
    terms?: PersonaLeakTerms;
    /** 只处理这些 id；缺省全库。 */
    recordIds?: readonly string[];
    /** 待处理记录池；缺省 ⇒ 自己分页取全库活跃记录。 */
    records?: readonly MemoryRecord[];
    logger?: {
        info(message: string): void;
        warn(message: string): void;
    };
}
/**
 * 执行（或预览）存量去人格化。
 *
 * @returns 逐条结果；`applied=false` 时库一字未动
 */
export declare function retirePersonaArtifacts(store: RetireStoreLike, opts: RetireOptions): Promise<RetireOutcome>;
