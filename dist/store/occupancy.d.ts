import type { MemoryLogger } from '../types.js';
import type { OccupancyLedger } from '../util/context-occupancy.js';
/** 会话条目上限(按 updatedAt 淘汰最旧;防文件无限增长)。 */
export declare const OCCUPANCY_SESSION_CAP = 200;
export declare class OccupancyStore {
    private readonly logger?;
    private readonly file;
    private readonly entries;
    private persistFailed;
    /** 只读降级原因(undefined = 正常):非空时内存账目照常有效,但停止回写。 */
    private degraded;
    private degradedLogged;
    /** 本进程上次成功写入的磁盘内容(紧凑 JSON);并发冲突判据:磁盘与它不同 = 别人写过。 */
    private lastPersisted;
    /** 串行化持久化写(避免并发原子写撞临时文件名);init 链最前(先载入再落盘,防丢更新)。 */
    private writeChain;
    constructor(dataDir: string, logger?: MemoryLogger | undefined);
    /**
     * 载入持久化账目(合并进内存——构造与载入之间发生的 save 不丢);失败降级内存态。
     *
     * **读侧分类**(文件层加固 T2):缺失合法;损坏/不可读 → 告警 + 只读降级(禁写);
     * 未知版本 → **仍按当前形状读取** + 只读降级(本 store 无迁移路径)。
     */
    private init;
    /**
     * 该会话的持久化账目(热路径同步读;从未注入/已复位返回 null)。
     * 返回浅拷贝——调用方(ledgerFor 复生)会在其上做迁移;若交出内部引用,
     * 原地修改会让 save() 的数值比较误判"未变"而跳过写穿。
     */
    load(sessionId: string): OccupancyLedger | null;
    /**
     * 迁移后写穿。数值未变只刷新内存时间戳不落盘(profile 稳定区每次请求组装都
     * 触发迁移,但内容不变时不应产生文件写);stock 归零即删除条目。
     */
    save(sessionId: string, ledger: OccupancyLedger): void;
    /** 等待在途持久化写完成(测试/停机用)。 */
    flush(): Promise<void>;
    private persist;
    private serialize;
}
