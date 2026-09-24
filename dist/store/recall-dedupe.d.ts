import type { MemoryLogger } from '../types.js';
/** 会话条目上限(按 updatedAt 淘汰最旧;防文件无限增长)。 */
export declare const RECALL_DEDUPE_SESSION_CAP = 200;
/** 单会话记录 id 上限(按插入序淘汰最旧;Set 迭代序即插入序)。 */
export declare const RECALL_DEDUPE_IDS_CAP = 512;
export declare class RecallDedupeStore {
    private readonly logger?;
    private readonly file;
    private readonly entries;
    private persistFailed;
    /** 只读降级原因(undefined = 正常):非空时去重集合照常生效,但停止回写。 */
    private degraded;
    private degradedLogged;
    /** 本进程上次成功写入的磁盘内容(紧凑 JSON);并发冲突判据:磁盘与它不同 = 别人写过。 */
    private lastPersisted;
    /** 串行化持久化写(避免并发原子写撞临时文件名);init 链最前(先载入再落盘,防丢更新)。 */
    private writeChain;
    constructor(dataDir: string, logger?: MemoryLogger | undefined);
    /**
     * 载入持久化映射(合并进内存——构造与载入之间发生的 mark 不丢);失败降级内存态。
     *
     * **读侧分类**(文件层加固 T2):缺失合法;损坏/不可读 → 告警 + 只读降级(禁写);
     * 未知版本 → **仍按当前形状读取** + 只读降级(本 store 无迁移路径)。
     */
    private init;
    /** 该会话的已注入集合(热路径同步读;未出现过的会话返回空集合,惰性建条)。 */
    seen(sessionId: string): Set<string>;
    /** 标记本轮实际注入的记录 id(写穿;调用方保证只传模型真实看到的条目)。 */
    mark(sessionId: string, recordIds: string[]): void;
    /** 清空该会话的记录(compact/clear 后上下文已丢失,记忆需可重新注入)。 */
    reset(sessionId: string): void;
    /** 等待在途持久化写完成(测试/停机用)。 */
    flush(): Promise<void>;
    private persist;
    private serialize;
}
