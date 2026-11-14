/**
 * 外源导入任务编排（计划 ext-to-l1-import task_4.4）。
 *
 * ## 为什么单独一层
 * 入库内核在 `puller.importSpace`（翻页 + 幂等 + 墓碑 + 影子），它一次调用会把整批跑完。
 * 但"导入"作为面板动作还需要三件内核不该管的事：
 *   1. **进度可观察**：跑几分钟的任务没有进度，与"点了没反应"长得一模一样；
 *   2. **断点可续**：嵌入是本次最贵的一项（逐条向量化），崩了从头再来等于双倍成本；
 *   3. **可中断**：用户看到量级不对必须能停。
 * 把这三件塞进 puller 会让泵同时承担"后台对账"与"前台长任务"两种生命周期，两者重启语义不同。
 *
 * ## 结果必须留事后凭证
 * 照 `ReindexRunSummary` 的先例：进度条只在 running 期间存在，而"远端 0 条待导入"的
 * 导入会瞬间跑完，与"按钮坏了"不可分辨。所以除进度外还存 `l1TotalBefore/l1TotalAfter`——
 * 效果就是这两个数的差，不是"我看它转了一下"。
 */
import type { MemoryLogger } from '../types.js';
import type { ExtPuller, ExtImportSummary } from './puller.js';
import type { ExtSyncStore } from './schema.js';
/** 一轮导入的收尾凭证。 */
export interface ImportRunSummary {
    finishedAt: number;
    durationMs: number;
    pulled: number;
    imported: number;
    skipped: number;
    conflicts: number;
    failed: number;
    offset: number;
    truncation: ExtImportSummary['truncation'];
    /** 导入前本地 L1 总数（效果凭证的另一半）。 */
    l1TotalBefore: number;
    /** 导入后本地 L1 总数：与 before 的差就是"真正新增了几条"，与 imported 应当一致。 */
    l1TotalAfter: number;
}
export interface ImportProgress {
    running: boolean;
    driverId: string;
    spaceId: string;
    offset: number;
    imported: number;
    skipped: number;
    startedAt: number;
    cancelRequested: boolean;
    error?: string;
    /** 上一次导入的结果（从未跑过则缺省）。 */
    last?: ImportRunSummary;
}
export interface ExtImporterDeps {
    puller: Pick<ExtPuller, 'importSpace'>;
    ext: ExtSyncStore;
    logger?: MemoryLogger;
    /** 本地 L1 总数（效果凭证用）。 */
    l1Total: () => number;
    /** 默认护栏（面板不填时用）。 */
    cfg: () => {
        maxItems: number;
        timeBudgetMs: number;
    };
}
export interface ExtImporter {
    /** 受理即返回，**不在此回传进度**：进度只有一套语义，就是 `status()`。 */
    start(input: {
        driverId: string;
        spaceId?: string;
        maxItems?: number;
        restart?: boolean;
    }): {
        accepted: true;
        startedAt: number;
    };
    status(): ImportProgress | null;
    cancel(): {
        cancelled: boolean;
    };
    /** 清断点：下一次从头来（面板"重新开始"用）。 */
    resetBreakpoint(input: {
        driverId: string;
        spaceId?: string;
    }): {
        cleared: boolean;
    };
}
export declare function makeExtImporter(deps: ExtImporterDeps): ExtImporter;
