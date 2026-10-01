/**
 * 统一召回治理权重(治理升级 W1,T1.10b;W2 扩 decayFactor,W3 扩 tierMultiplier)。
 *
 * **红线(P0-1/I-1)**:纯函数、只挂读召回出口(hooks/recall.ts + 工具检索出口,
 * 照 `domain-gate.ts:sortByDomainWeight` 范式),**严禁进 MemoryDb/searchCandidates/
 * SQL 排序**——入口处 `assertNotDedupPath` 自证清白。
 *
 * **零漂移契约(I-10)**:所有旋钮默认关,关闭时调用方**不调用本函数**,召回路径
 * 逐字现状;本函数自身对"未登记治理归属"的记录一律乘 1(fail-open,I-23——
 * 读不到治理归属等价于"正常记忆",绝不让记忆凭空消失)。
 *
 * 组合语义(2026-10-01 终审钉死,spec §二):`sortByDomainWeight` 只排序不改写
 * score(domain-gate.ts:177),本函数挂其**之后**,把治理权重并入合成排序键后整体
 * 重排——score 字段**不被改写**(展示分不变),既有域门禁调用点**不动**。
 */
import { assertNotDedupPath } from './search-utils.js';
import type { MemoryRecord } from '../types.js';
import { normApplicability } from '../repo-scope.js';
// tier 轴(治理 W3)刻意不在最小闭包:tierEnabled 参数保留(恒按 false 语义 = 乘子 1),
// 等治理波整体落地后再启用——W1 只交付 repo 围栏。

/** 治理权重上下文(调用方从 config + 会话 cwd 组装)。 */
export interface GovernanceContext {
  /** 总开关(recall.scopeFence.enabled;W2/W3 扩展各自的开关)。false → 原样返回。 */
  enabled: boolean;
  /** 当前会话的 repoKey(basename(归一 cwd);'' = 无法识别 → 不围栏)。 */
  currentRepoKey: string;
  /** repo 不匹配乘子(recall.scopeFence.crossRepoMultiplier,默认 0.2)。 */
  crossRepoMultiplier: number;
  /** tier 检索降权开关(governance.tier.enabled,治理 W3;默认 false = tier 不参与)。 */
  tierEnabled?: boolean;
}

/** 单条命中治理后的合成权重(排序键;score 不改写)。治理关闭恒 1。 */
export function governanceWeightOf(
  rec: MemoryRecord | undefined,
  ctx: GovernanceContext,
): number {
  // tier 乘子(治理 W3,T3.9):独立"刻意降级"因子,wiki=0.05(近乎退出召回,
  // 工具 includeWiki 可绕);不参与软下界(spec §二阶段 3)。开关关 = 恒 1。
  // tier 乘子(治理 W3)在最小闭包中恒 1:tierEnabled 参数保留,语义=不参与。
  const tierMult = 1;
  if (!ctx.enabled) return tierMult;
  if (!rec) return tierMult; // 读不到归属 → 不减权(fail-open,绝不因治理丢召回)
  // chat 族不围栏:污染面在项目之间,个人记忆本就跨项目(P0-7 同源判断)。
  if (rec.family !== 'work') return tierMult;
  const repoKeyName = String(rec.repoKeyName ?? '');
  // work 无 repo 归属 → 不围栏(默认 global 语义,零漂移)
  if (!repoKeyName) return tierMult;
  // 记录声明 cross-project → 绝不围栏(P0-7:跨项目 SOP 不可被单 repo 限死)
  if (normApplicability(rec.applicability) === 'cross-project') return tierMult;
  // 同仓 → 原样
  if (repoKeyName === ctx.currentRepoKey) return tierMult;
  // 跨仓 → 软减权(非硬排除;与域门禁 0.4 叠乘 ≥0.08)
  const m = Number(ctx.crossRepoMultiplier);
  return Number.isFinite(m) && m > 0 && m <= 1 ? m : 0.2;
}

/**
 * 对召回出口的 hits 施加治理权重:**只重排,不改写 score、不过滤、不扩集**。
 * `recordsById` 由调用方用一次批量点查组装(命中量 ≤ limit,微秒级);
 * 排序稳定:同权重保持原相对顺序(比较仅在不等时返回,Array.prototype.sort
 * 在现代 V8 为稳定排序)。
 */
export function applyGovernanceWeights<T extends { id: string; score: number }>(
  hits: T[],
  recordsById: ReadonlyMap<string, MemoryRecord>,
  ctx: GovernanceContext,
): T[] {
  assertNotDedupPath('applyGovernanceWeights(治理权重只准作用读召回出口)');
  if (!ctx.enabled || hits.length <= 1) return hits;
  return hits
    .map((h, i) => {
      const w = governanceWeightOf(recordsById.get(h.id), ctx);
      return { h, key: h.score * w, i };
    })
    .sort((a, b) => b.key - a.key || a.i - b.i)
    .map((x) => x.h);
}

/**
 * 四象限守卫的真值表(P0-7):work×global 任何 repo 下不减权。
 * 导出供测试直接引用,保证实现与文档同一处表达。
 */
export const SCOPE_FENCE_QUADRANTS: ReadonlyArray<{
  family: 'chat' | 'work';
  repoKeyName: string;
  applicability: string;
  currentRepoKey: string;
  expected: 1 | 'crossRepo';
}> = [
  { family: 'chat', repoKeyName: '', applicability: '', currentRepoKey: 'other', expected: 1 },
  { family: 'work', repoKeyName: '', applicability: '', currentRepoKey: 'other', expected: 1 },
  { family: 'work', repoKeyName: 'alpha', applicability: 'cross-project', currentRepoKey: 'other', expected: 1 },
  { family: 'work', repoKeyName: 'alpha', applicability: '', currentRepoKey: 'alpha', expected: 1 },
  { family: 'work', repoKeyName: 'alpha', applicability: 'this-repo', currentRepoKey: 'other', expected: 'crossRepo' },
];


