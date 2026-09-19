import type { MemoryLogger, MemoryMode } from '../types.js';
export declare function isMemoryMode(v: unknown): v is MemoryMode;
/** 合法角 id 判定(锁域只认 8 角;general 是兜底值不是角,不可锁定)。 */
export declare function isHallCorner(v: unknown): v is string;
export declare class SessionModeStore {
    private readonly defaultMode;
    private readonly logger?;
    private readonly file;
    private readonly entries;
    private readonly loaded;
    private persistFailed;
    /** 档位切换回调(index.ts 装配 runner 的同步动作:切片落袋/挂起,ADR-0003)。 */
    private onModeChange?;
    /** 串行化持久化写(避免并发原子写撞临时文件名)。 */
    private writeChain;
    constructor(dataDir: string, defaultMode: Extract<MemoryMode, 'auto' | 'chat' | 'work'>, logger?: MemoryLogger | undefined);
    /** 载入持久化映射(index.ts 启动时 await;失败降级内存态)。 */
    init(): Promise<void>;
    get default(): MemoryMode;
    /** 同步读取:未设置过的会话返回默认档。 */
    get(sessionId: string): MemoryMode;
    /**
     * 该会话是否有**显式**档位条目(区别于 `get()` 的默认档回落)。
     *
     * 子代理档位继承(§A)靠它判断"这一层是否设过":未设过则继续沿父链上溯,
     * 而不是立刻吃默认档——后者正是"用户显式 off 被绕过"的成因。
     */
    hasEntry(sessionId: string): boolean;
    /** 会话级注入覆盖原始值:undefined = 未覆盖,跟随全局。 */
    getRecall(sessionId: string): boolean | undefined;
    /** 解析后的注入开关:会话覆盖 ?? 全局运行时开关(部署级 cfg.recall.enabled
     *  与主闸 s.enabled 不经此处,仍按既有硬门生效——覆盖打不穿部署上限)。 */
    resolvedRecall(sessionId: string, globalRecall: boolean): boolean;
    /** 设置会话级注入覆盖(undefined = 清除覆盖跟随全局。写穿持久化)。 */
    setRecall(sessionId: string, recall: boolean | undefined): void;
    /** 会话级域锁定(多选):空数组 = 中心(智能档,无锁域)。 */
    getHalls(sessionId: string): string[];
    /** 兼容读取(单选口径,取第一个锁定域):undefined = 中心。 */
    getHall(sessionId: string): string | undefined;
    /** 锁定域边界开关:未打标是否包含(缺省 true)/ general 是否包含(缺省 false)。 */
    hallBoundaries(sessionId: string): {
        includeUnlabeled: boolean;
        includeGeneral: boolean;
    };
    /** 设置会话级域锁定(多选:角 id 数组;空数组/undefined = 回中心清除锁定。写穿持久化)。
     *  单角时镜像写 `hall` 兼容键,多角时置空(旧读者按无锁域读)。 */
    setHall(sessionId: string, halls: readonly string[] | undefined, boundaries?: {
        includeUnlabeled?: boolean;
        includeGeneral?: boolean;
    }): void;
    /** 注册档位切换回调(同步调用;回调异常只记日志不阻断写穿)。 */
    setModeChangeHandler(cb: (sessionId: string, oldMode: MemoryMode, newMode: MemoryMode) => void): void;
    /** 设置会话档位(写穿持久化;持久化失败保持内存态生效)。 */
    set(sessionId: string, mode: MemoryMode): void;
    /** 等待在途持久化写完成(测试/停机用)。 */
    flush(): Promise<void>;
    private persist;
    private serialize;
}
