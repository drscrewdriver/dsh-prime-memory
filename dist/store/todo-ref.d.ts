/**
 * 会话 todo 参考快照(长任务模式 §todo 参考)。
 *
 * 数据源:宿主结构化事件 `todo/write`(全量快照 `{todos:[{content,status}]}`)。
 * 记录最近两次快照,词面 Jaccard 相似度给出"大幅漂移"信号(jieba 切词,回退
 * CJK 二元组 + ASCII 词)。漂移本身只是信号——是否注入参考由长任务开关决定。
 *
 * 纯内存 per-session Map:todo 快照是易变运行态,压缩/重启后由下一条
 * todo/write 自然重建;持久化只会让过期任务清单在重启后诈尸。
 */
export interface TodoItemSnapshot {
    content: string;
    status: string;
}
export interface TodoRefEntry {
    /** 最近一次快照(渲染用)。 */
    items: TodoItemSnapshot[];
    /** 快照文本(注入与相似度用)。 */
    text: string;
    /** 上一次快照文本(漂移对照;首次记录为 undefined)。 */
    prevText: string | undefined;
    /** 与上次快照的漂移度 = 1 - Jaccard(首次 = 0;范围 [0,1])。 */
    drift: number;
    updatedAt: number;
}
/** 词面 token 集:jieba 优先,回退 CJK 二元组 + ASCII 词。 */
export declare function todoTokens(text: string): Set<string>;
/** 词面 Jaccard 相似度([0,1];两个空集视为完全相似 1)。 */
export declare function jaccard(a: Set<string>, b: Set<string>): number;
export declare function renderTodoText(items: TodoItemSnapshot[]): string;
export declare class TodoRefStore {
    private readonly entries;
    /**
     * 记录一次全量快照,返回本次漂移度。与上一快照完全相同(哈希相等)时
     * 不视为新快照:drift 归 0、updatedAt 刷新、prev 链不动——连续多次
     * todo/write(勾选进度除外)不应自我稀释漂移信号。
     */
    record(sessionId: string, items: TodoItemSnapshot[]): TodoRefEntry;
    latest(sessionId: string): TodoRefEntry | undefined;
    clear(sessionId: string): void;
}
