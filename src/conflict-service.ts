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

/** 裁决结果的对外形状(snake_case,工具与端点共用)。 */
export interface ConflictResolutionView {
  pair_id: string;
  outcome: string;
  /** 裁决时刻(ISO)。空串 = 未生效。 */
  resolved_at: string;
  /** 因裁决从检索中退场的记录 id(无则空串)。 */
  removed_record_id: string;
  notice?: string;
}

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
