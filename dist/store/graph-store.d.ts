import type { DatabaseSync } from 'node:sqlite';
import type { GraphEdge, GraphNode, GraphNodeSearchResult, GraphProjectionJob, GraphProjectionResult } from '../graph/types.js';
import type { MemoryFamily, MemoryLogger, MemoryRecord } from '../types.js';
/** claim 的产出:job 元数据 + 本批真实存在的来源记录(已剔除被删者)。 */
export interface GraphClaim {
    job: GraphProjectionJob;
    records: MemoryRecord[];
}
/** complete 的注入缝(测试回滚路径 / 确定性断言用)。 */
export interface CompleteOptions {
    now?: string;
    idFactory?: (prefix: 'node' | 'edge' | 'gfact') => string;
}
export declare class GraphStore {
    private db;
    private logger;
    private stmtInsertNode;
    private stmtInsertEdge;
    /** init 是否就绪(未就绪 = 图谱域整体 no-op,不抛错不传染)。 */
    get ready(): boolean;
    /**
     * 建表 + 语句缓存(MemoryDb.initSchema 内调用)。任何一步失败都只告警并保持
     * 未就绪——图谱域整体降级 no-op,检索主链路(L0/L1/FTS/向量)不受影响。
     */
    init(db: DatabaseSync, logger?: MemoryLogger): void;
    /** 插件停机时清空连接引用(dispose 序调用,防悬空引用)。 */
    close(): void;
    /** 统一事务边界(immediate 供 complete 全程持写锁)。 */
    private tx;
    /** 事务内的 upsert 体(upsertTouched 与 complete 共用;调用方负责事务)。 */
    private upsertTouchedInTx;
    /** 全量读图谱(apply scope 与检索的统一入口;图谱量级为可重建投影,百~千级)。 */
    loadGraph(): {
        nodes: GraphNode[];
        edges: GraphEdge[];
    };
    /** 事务内的全图读取(complete 用;调用方负责事务)。 */
    private loadGraphInTx;
    /** 事务内按 id 装载 L1 记录(claim 与 complete 共用;调用方负责事务)。 */
    private loadRecordsInTx;
    /** 单节点详情(expand 用;不存在/未就绪返回 null)。 */
    getNode(id: string): GraphNode | null;
    /** 与某节点相连的 active 边(expand 用;悬挂 id 返回空数组,不解析不抛)。 */
    edgesOf(nodeId: string): GraphEdge[];
    /**
     * 图谱检索(纯函数 searchGraphNodes 的存储缝;可选族过滤)。
     * families 非空时只返回本族衍生的节点(档位隔离;无族信息节点一律不可见——
     * 宁可漏不可串)。降级/异常返回空数组。
     */
    searchNodes(query: string, limit: number, families?: readonly MemoryFamily[]): GraphNodeSearchResult[];
    private newJobId;
    /**
     * 投影入队(按 GRAPH_JOB_BATCH 分片成多个 job;去重下推 SQL):
     * 已有在途 mapping(pending/running/failed 退避中)或已按当前版本完成投影的
     * 记录跳过。返回实际新建的 job 数。
     */
    queueGraphProjection(recordIds: readonly string[], priority: number): number;
    /**
     * 取下一个可执行 job 并置 running(attempts +1):只认当前 projectorVersion,
     * attempts 封顶与退避窗口在 WHERE 里过滤;来源全缺失 → job 判 dead 返 null
     * (不可重试不抛)。部分缺失时 job 收缩到真实存在的记录子集。
     */
    claimNext(): GraphClaim | null;
    /**
     * 提交投影结果(单事务,BEGIN IMMEDIATE):读全图 scope → 纯函数 apply(硬
     * 校验)→ 写回 touched 行 → job 置 completed + 登记已投影记录 + 放掉 mapping。
     * job 非 running 态(已完成/已 dead/已回收)一律幂等 no-op;任何一步抛错整体
     * 回滚,不留半写。
     */
    complete(jobId: string, result: GraphProjectionResult, opts?: CompleteOptions): void;
    /**
     * 投影失败收尾:attempts 已在 claim 时 +1——封顶转 dead(放掉 mapping,允许
     * 重新入队);未封顶转 failed + 指数退避 nextAttemptAt(mapping 保留防重复入队)。
     */
    fail(jobId: string, error: string): void;
    /** 启动回收:上次进程退出时卡在 running 的 job 放回 pending(dispose 缝不永久卡批)。 */
    recoverRunning(): number;
    /** 最近 job 列表(诊断/面板用;未就绪返回空)。 */
    listJobs(limit?: number): GraphProjectionJob[];
    /**
     * 存量补投影:从未投影(当前版本)且无在途 mapping 的 L1 记录里按创建时间
     * 升序取最多 limit 条分片入队(优先级 GRAPH_PRIORITY_BACKFILL,恒低于新蒸馏)。
     * 返回新建 job 数。
     */
    queueMissing(limit: number): number;
    /**
     * 删除传播(L1 批量删除后的惰性墓碑):来源在 L1 已全部不存在的 active/disputed
     * 节点与边标 archived(保留行,expand 可见墓碑)。挂在 MemoryDb.deleteL1Batch
     * 之后;按 L1 存活集判定(而非本次删除集合),跨多次删除与历史孤儿一并收敛。
     */
    markSourcesDeleted(deletedIds: readonly string[]): void;
    /** 清空全部图谱数据(L1 重建时调用——图谱是 L1 的投影,记录清空即图谱作废)。 */
    resetAll(): void;
}
