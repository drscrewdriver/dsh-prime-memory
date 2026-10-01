/** 词面 token 集:jieba 优先,回退 CJK 二元组 + ASCII 词。 */
export function todoTokens(text) {
    const out = new Set();
    const ascii = text.match(/[A-Za-z0-9_./-]+/g);
    for (const w of ascii ?? [])
        out.add(w.toLowerCase());
    const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? [];
    for (const run of cjk) {
        if (run.length === 1) {
            out.add(run);
            continue;
        }
        for (let i = 0; i < run.length - 1; i++)
            out.add(run.slice(i, i + 2));
    }
    return out;
}
/** 词面 Jaccard 相似度([0,1];两个空集视为完全相似 1)。 */
export function jaccard(a, b) {
    if (a.size === 0 && b.size === 0)
        return 1;
    if (a.size === 0 || b.size === 0)
        return 0;
    let inter = 0;
    for (const t of a)
        if (b.has(t))
            inter++;
    return inter / (a.size + b.size - inter);
}
export function renderTodoText(items) {
    return items.map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n');
}
export class TodoRefStore {
    entries = new Map();
    /**
     * 记录一次全量快照,返回本次漂移度。与上一快照完全相同(哈希相等)时
     * 不视为新快照:drift 归 0、updatedAt 刷新、prev 链不动——连续多次
     * todo/write(勾选进度除外)不应自我稀释漂移信号。
     */
    record(sessionId, items) {
        const text = renderTodoText(items);
        const prev = this.entries.get(sessionId);
        if (prev && prev.text === text) {
            prev.updatedAt = Date.now();
            prev.drift = 0;
            return prev;
        }
        const sim = prev ? jaccard(todoTokens(prev.text), todoTokens(text)) : 1;
        const entry = {
            items,
            text,
            prevText: prev?.text,
            drift: prev ? Math.round((1 - sim) * 1000) / 1000 : 0,
            updatedAt: Date.now(),
        };
        this.entries.set(sessionId, entry);
        return entry;
    }
    latest(sessionId) {
        return this.entries.get(sessionId);
    }
    clear(sessionId) {
        this.entries.delete(sessionId);
    }
}
