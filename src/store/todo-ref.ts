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
export function todoTokens(text: string): Set<string> {
  const out = new Set<string>();
  const ascii = text.match(/[A-Za-z0-9_./-]+/g);
  for (const w of ascii ?? []) out.add(w.toLowerCase());
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 词面 Jaccard 相似度([0,1];两个空集视为完全相似 1)。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function renderTodoText(items: TodoItemSnapshot[]): string {
  return items.map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n');
}

export class TodoRefStore {
  private readonly entries = new Map<string, TodoRefEntry>();

  /**
   * 记录一次全量快照,返回本次漂移度。与上一快照完全相同(哈希相等)时
   * 不视为新快照:drift 归 0、updatedAt 刷新、prev 链不动——连续多次
   * todo/write(勾选进度除外)不应自我稀释漂移信号。
   */
  record(sessionId: string, items: TodoItemSnapshot[]): TodoRefEntry {
    const text = renderTodoText(items);
    const prev = this.entries.get(sessionId);
    if (prev && prev.text === text) {
      prev.updatedAt = Date.now();
      prev.drift = 0;
      return prev;
    }
    const sim = prev ? jaccard(todoTokens(prev.text), todoTokens(text)) : 1;
    const entry: TodoRefEntry = {
      items,
      text,
      prevText: prev?.text,
      drift: prev ? Math.round((1 - sim) * 1000) / 1000 : 0,
      updatedAt: Date.now(),
    };
    this.entries.set(sessionId, entry);
    return entry;
  }

  latest(sessionId: string): TodoRefEntry | undefined {
    return this.entries.get(sessionId);
  }

  clear(sessionId: string): void {
    this.entries.delete(sessionId);
  }
}
