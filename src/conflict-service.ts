/**
 * §C 矛盾冻结的**裁决出口**(task_25)。
 *
 * 冻结把裁决权交还给人,那么必须有一个"人能把结论说回去"的出口:
 * 否则待裁决队列是只进不出的黑洞,安全阀(task_24)的自动了结会成为唯一出路——
 * 那等于把 opt-in 的冻结悄悄退回成"超时后机器自己判"。
 *
 * 工具层与 RPC 层共用本模块,保证两条出口的**语义与返回形状完全一致**
 * (与 `memory_receipts` 一样:同一份 `ReceiptsView` 供工具与端点共用)。
 */
import type { L1Store } from './store/l1.js';
import type { ConflictResolution } from './store/conflicts.js';
// 对外形状的唯一事实源在 contract.ts(它没有任何 import,客户端那档类型检查以
// `types: []` 拉它)。这里**只引用、不重声明** —— 重声明就会与端点/面板用的形状
// 悄悄分叉,而"工具、端点、面板看同一份形状"正是本模块存在的理由。
import type {
  ConflictPairView,
  ConflictsResponse as ConflictsView,
  ConflictResolveResponse as ConflictResolutionView,
} from './contract.js';

export type { ConflictPairView, ConflictsView, ConflictResolutionView };

const OUTCOMES: readonly ConflictResolution[] = ['winner', 'loser', 'both'];

function view(partial: Partial<ConflictResolutionView>): ConflictResolutionView {
  return { pair_id: '', outcome: '', resolved_at: '', removed_record_id: '', ...partial };
}

export interface ConflictResolveDeps {
  l1: Pick<
    L1Store,
    'listConflictPending' | 'resolveConflictPending' | 'deleteBatch' | 'syncGraphDisputed'
  >;
  /** `conflictFreeze.enabled`。未开启时队列恒空,直接给出提示而非静默无操作。 */
  conflictFreezeEnabled: boolean;
}

/**
 * 裁决一条待裁决对。
 *
 * 顺序刻意如此:
 * ① **先打 `resolved_at` 再退场 loser**。反过来的话,退场成功但打标失败会留下
 *    "记录已消失、队列里那条仍在待裁决"的状态——人再点一次才发现无据可依。
 *    打标用 `WHERE resolved_at = ''`,天然防重复裁决:第二次调用拿到 0 行即中止。
 * ② 退场后才**重算**图谱 `disputed`(派生字段必须由当前事实重算,见 `syncDisputed`)。
 */
export async function resolveConflictPair(
  deps: ConflictResolveDeps,
  pairId: string,
  outcome: string,
): Promise<ConflictResolutionView> {
  const clean = outcome.trim();
  if (!OUTCOMES.includes(clean as ConflictResolution)) {
    return view({
      pair_id: pairId,
      outcome: clean,
      notice: `outcome 必须是 ${OUTCOMES.join(' / ')} 之一:winner(LLM 建议的胜方为真)、loser(败方为真)、both(两者其实是各自独立的事实,都保留)。`,
    });
  }
  if (!deps.conflictFreezeEnabled) {
    return view({
      pair_id: pairId,
      outcome: clean,
      notice: '矛盾冻结未开启(conflictFreeze.enabled=false):没有待裁决对,无从裁决。',
    });
  }

  const pair = deps.l1.listConflictPending().find((p) => p.pairId === pairId);
  if (!pair) {
    return view({
      pair_id: pairId,
      outcome: clean,
      notice: '找不到该待裁决对:pair_id 有误,或它已被裁决(resolved_at 非空的不再接受二次裁决)。',
    });
  }

  const resolvedAt = new Date().toISOString();
  const removedId =
    clean === 'winner' ? pair.loserId : clean === 'loser' ? pair.winnerId : '';

  if (deps.l1.resolveConflictPending(pairId, clean as ConflictResolution, resolvedAt) === 0) {
    // 并发/重复调用:这一对在本次读取与本次写入之间被裁决了
    return view({ pair_id: pairId, outcome: clean, notice: '该对已被裁决,本次未生效(裁决不可覆盖)。' });
  }

  if (removedId) await deps.l1.deleteBatch([removedId]);

  // 图谱 disputed 重算:此刻仍未裁决的对才是争议集,已了结的节点自动复原 active
  const ids = new Set<string>();
  for (const p of deps.l1.listConflictPending()) {
    ids.add(p.winnerId);
    ids.add(p.loserId);
  }
  deps.l1.syncGraphDisputed([...ids]);

  return view({ pair_id: pairId, outcome: clean, resolved_at: resolvedAt, removed_record_id: removedId });
}

/** 裁决结果的人类可读渲染(工具路径用)。schema 产出的是可选字段,故按部分取值渲染。 */
export function renderConflictResolution(v: Partial<ConflictResolutionView>): string {
  if (v.notice) return v.notice;
  const outcome = v.outcome ?? '';
  const label = outcome === 'winner' ? '判定 LLM 建议的胜方为真' : outcome === 'loser' ? '判定败方为真' : '两者都保留(判为各自独立的事实)';
  const removed = v.removed_record_id
    ? `\n退场记录:${v.removed_record_id}(已从检索中移除,事实源保留)`
    : '\n未移除任何记录。';
  return `已裁决待裁决对 ${v.pair_id ?? ''}\n结论:${outcome}(${label})\n裁决时刻:${v.resolved_at ?? ''}${removed}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 读方向:列出待裁决对
//
// 与 `resolveConflictPair` 同理由共用本模块:工具(`memory_conflicts`)与
// RPC 端点(`dsh-memory/conflicts`)必须是**同一份形状** —— 面板与模型看同一队列,
// 否则"人看到的那条"和"模型能裁决的那条"会对不上。
// ─────────────────────────────────────────────────────────────────────────────

/** 一条待裁决对的对外形状见 `contract.ts` 的 `ConflictPairView`(此处只引用)。 */

/** 队列读取的上限(与 `records-delete` 同量级:够人看,不把页面拖死)。 */
export const CONFLICT_LIST_LIMIT_MAX = 200;
/** 默认取多少条。 */
export const CONFLICT_LIST_LIMIT_DEFAULT = 50;

export interface ConflictListDeps {
  l1: Pick<L1Store, 'listConflictPending' | 'countConflictPendingUnresolved' | 'getByIds'>;
  /** `conflictFreeze.enabled`。 */
  conflictFreezeEnabled: boolean;
}

/**
 * 列出待裁决对。
 *
 * **正文必须带上**:人工裁决的对象就是"这两条到底说了什么",只给 id 等于让人盲判。
 * 取不到正文时留空串 —— 面板据此区分"记录已不在检索库"与"内容为空",
 * 而不是拿一句"（无内容）"把两种情形糊在一起。
 *
 * 未开启冻结时返回 `enabled:false` + 空列表 + `notice`,**不抛错**:开关没开是
 * 部署状态,不是调用错误(与 `resolveConflictPair` 对同一情形的处理一致)。
 */
export function listConflictPairs(deps: ConflictListDeps, opts: { limit?: number } = {}): ConflictsView {
  const raw = Math.floor(Number(opts.limit));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, CONFLICT_LIST_LIMIT_MAX) : CONFLICT_LIST_LIMIT_DEFAULT;

  if (!deps.conflictFreezeEnabled) {
    return {
      enabled: false,
      total: 0,
      items: [],
      notice: '矛盾冻结未开启(conflictFreeze.enabled=false):队列恒空,没有待裁决对。',
    };
  }

  const pending = deps.l1.listConflictPending({ limit });
  const ids = new Set<string>();
  for (const p of pending) {
    ids.add(p.winnerId);
    ids.add(p.loserId);
  }
  const contentById = new Map<string, string>();
  for (const r of deps.l1.getByIds([...ids])) contentById.set(r.id, r.content);

  const items: ConflictPairView[] = pending.map((p) => ({
    pair_id: p.pairId,
    run_id: p.runId,
    winner_id: p.winnerId,
    winner_content: contentById.get(p.winnerId) ?? '',
    loser_id: p.loserId,
    loser_content: contentById.get(p.loserId) ?? '',
    created_at: p.createdAt,
  }));

  return { enabled: true, total: deps.l1.countConflictPendingUnresolved(), items };
}

/** 列表结果的人类可读渲染(工具路径用)。 */
export function renderConflicts(v: ConflictsView): string {
  if (!v.enabled) return v.notice ?? '矛盾冻结未开启:没有待裁决对。';
  if (v.items.length === 0) return '没有待裁决的冲突对(队列为空)。';
  const more = v.total > v.items.length ? `\n(共 ${v.total} 对,此处显示前 ${v.items.length} 对)` : '';
  const rows = v.items.map((p, i) => {
    const w = p.winner_content || '(该记录已不在检索库)';
    const l = p.loser_content || '(该记录已不在检索库)';
    return (
      `${i + 1}. pair_id ${p.pair_id}  (${p.created_at})\n` +
      `   LLM 建议胜方 ${p.winner_id}:${w}\n` +
      `   LLM 建议败方 ${p.loser_id}:${l}`
    );
  });
  return `待裁决冲突对 ${v.items.length} 条${more}\n\n${rows.join('\n\n')}\n\n` +
    '用 memory_resolve_conflict 给出结论:winner / loser / both。';
}

