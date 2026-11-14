/**
 * 外部记忆检索路(计划 T1.10;第 5 路的 provider 侧)。
 *
 * 形状与 graphLane 的分工纪律一致:L1Store 那条缝只做"空路降级 + 红线自证",
 * 并发/限流/熔断/归因/去重全在这里。三条硬规则抄自参考实现并被 Phase 0 的
 * ext-lane 测试钉住:
 * - **并发扇出**:所有 (driver×space) 同时发,总延迟取最大项不是求和;
 *   一家挂不影响其余(allSettled),每家自享 requestTimeoutMs 的独立 deadline;
 * - **只用 rank,不比 score**:honcho 不声明可比分数,跨家 score 融合会把
 *   某家的 0.9 当成另一家的 0.9(参考实现联邦融合同款判据:异构时按位次);
 * - **族隔离**:外部件没有 family 归属——单族档(chat/work)会话整路不出
 *   (宁可漏不可串,与 graphLane 的族过滤同一原则);auto 档(family=undefined)放行。
 *
 * 熔断按 driver 一位:连续 `failureThreshold` 次失败 → 开路 `openMs`,期内该驱动
 * 不进 lane(不计失败也不放行);半开由下一次到期调用自然发生(成功即清零)。
 */
import type { L1Hit } from '../types.js';
import type { ExtLaneProvider } from '../store/l1.js';
import type { ExtDriverRegistry } from './registry.js';
import type { ExternalHit, ExternalMemoryDriver, ExtSpace } from './types.js';
import type { MemoryLogger } from '../types.js';
import { clip, extHitId, normContentKey } from './util.js';

export interface ExtLaneConfig {
  /** 单驱动在一次融合里的最大贡献条数(config lane.maxItemsPerDriver)。 */
  maxItemsPerDriver: number;
  /** 单驱动请求超时(ms)。 */
  requestTimeoutMs: number;
  /** 路内容硬截(防超大外部正文挤爆注入预算;applyRecallBudget 之前的第一刀)。 */
  maxContentChars: number;
  /** 连续失败到该值开熔断。 */
  failureThreshold: number;
  /** 熔断开路时长(ms)。 */
  openMs: number;
}

export interface ExtLaneDeps {
  registry: ExtDriverRegistry;
  /** 每驱动参与检索的空间集(装配时定;Phase 1 一驱动一空间)。 */
  spacesOf: (driverId: string) => ExtSpace[];
  cfg: () => ExtLaneConfig;
  logger?: MemoryLogger;
  now?: () => number;
}

interface BreakerState {
  failStreak: number;
  openedUntil: number;
  lastError: string;
}

/** 驱动在 lane 视角的即时状态(面板/探针共用;不导出内部 Map)。 */
export interface ExtLaneStatus {
  driverId: string;
  enabled: boolean;
  circuit: 'closed' | 'open';
  failStreak: number;
  openedUntil: number;
  lastError: string;
}

/** 跨驱动 rank 交错:每家第 i 名依次入列(按 driverId 定序,确定性可复现)。 */
export function interleaveByRank(groups: Array<{ driverId: string; hits: ExternalHit[] }>): Array<{ driverId: string; hit: ExternalHit }> {
  const sorted = [...groups].sort((a, b) => (a.driverId < b.driverId ? -1 : a.driverId > b.driverId ? 1 : 0));
  const maxDepth = sorted.reduce((m, g) => Math.max(m, g.hits.length), 0);
  const out: Array<{ driverId: string; hit: ExternalHit }> = [];
  for (let rank = 0; rank < maxDepth; rank++) {
    for (const g of sorted) {
      const hit = g.hits[rank];
      if (hit !== undefined) out.push({ driverId: g.driverId, hit });
    }
  }
  return out;
}

export interface ExtLane {
  provider: ExtLaneProvider;
  statusOf(): ExtLaneStatus[];
  /** 记一次成功(探针路径共用熔段位;lane 内调用,外部面板探活成功也回灌这里)。 */
  noteSuccess(driverId: string): void;
  noteFailure(driverId: string, message: string): void;
}

export function makeExtLane(deps: ExtLaneDeps): ExtLane {
  const breakers = new Map<string, BreakerState>();
  const nowMs = deps.now ?? (() => Date.now());
  const breakerOf = (driverId: string): BreakerState => {
    let b = breakers.get(driverId);
    if (b === undefined) {
      b = { failStreak: 0, openedUntil: 0, lastError: '' };
      breakers.set(driverId, b);
    }
    return b;
  };
  const isOpen = (driverId: string): boolean => breakerOf(driverId).openedUntil > nowMs();

  const statusOf = (): ExtLaneStatus[] =>
    deps.registry.list().map(({ driver, enabled }) => {
      const b = breakers.get(driver.id) ?? { failStreak: 0, openedUntil: 0, lastError: '' };
      return {
        driverId: driver.id,
        enabled,
        circuit: b.openedUntil > nowMs() ? 'open' : 'closed',
        failStreak: b.failStreak,
        openedUntil: b.openedUntil,
        lastError: b.lastError,
      };
    });

  const noteSuccess = (driverId: string): void => {
    const b = breakerOf(driverId);
    if (b.failStreak !== 0 || b.openedUntil !== 0 || b.lastError !== '') {
      deps.logger?.info(`[memory] 外部驱动 ${driverId} 恢复(熔断闭合)`);
    }
    b.failStreak = 0;
    b.openedUntil = 0;
    b.lastError = '';
  };
  const noteFailure = (driverId: string, message: string): void => {
    const b = breakerOf(driverId);
    b.failStreak++;
    b.lastError = message.slice(0, 300);
    const cfg = deps.cfg();
    if (b.failStreak >= cfg.failureThreshold && b.openedUntil <= nowMs()) {
      b.openedUntil = nowMs() + cfg.openMs;
      deps.logger?.warn(`[memory] 外部驱动 ${driverId} 连续失败 ${b.failStreak} 次,熔断 ${Math.round(cfg.openMs / 1000)}s:${b.lastError}`);
    }
  };

  const provider: ExtLaneProvider = async (query, limit, opts) => {
    // 族隔离:单族档会话整路缺席(auto 档 family=undefined 才进)
    if (opts?.family !== undefined) return [];
    const drivers: ExternalMemoryDriver[] = deps.registry.enabled().filter((d) => !isOpen(d.id));
    if (drivers.length === 0) return [];
    const cfg = deps.cfg();
    const perDriver = Math.min(cfg.maxItemsPerDriver, Math.max(1, limit));
    const settled = await Promise.allSettled(
      drivers.flatMap((driver) =>
        deps.spacesOf(driver.id).map(async (space): Promise<{ driverId: string; hits: ExternalHit[] }> => {
          const signal = AbortSignal.timeout(cfg.requestTimeoutMs);
          const result = await driver.search(space, { query, limit: perDriver }, signal);
          return { driverId: driver.id, hits: result.results ?? [] };
        }),
      ),
    );
    const groups: Array<[string, ExternalHit[]]> = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        groups.push([r.value.driverId, r.value.hits]);
        noteSuccess(r.value.driverId);
      }
    }
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected.length > 0) {
      // 粗粒度归因:未能对上号的失败也给"参与但零贡献"的驱动记一次(保守:
      // 只多记失败不多记成功;成功的驱动已在上面 noteSuccess 过)。
      const okDrivers = new Set(groups.map(([d]) => d));
      for (const d of drivers) {
        if (!okDrivers.has(d.id)) {
          noteFailure(d.id, rejected[0]?.reason instanceof Error ? rejected[0].reason.message : String(rejected[0]?.reason ?? 'unknown'));
        }
      }
    }
    // 驱动内保持返回序(即该家的 rank 序);跨家 rank 交错 + 内容去重 + 总量封顶
    const seenContent = new Set<string>();
    const keptGroups: Array<{ driverId: string; hits: ExternalHit[] }> = [];
    for (const [driverId, hits] of groups) {
      const deduped: ExternalHit[] = [];
      for (const h of hits) {
        const key = normContentKey(h.content);
        if (key === '' || seenContent.has(key)) continue;
        seenContent.add(key);
        deduped.push(h);
      }
      if (deduped.length > 0) keptGroups.push({ driverId, hits: deduped });
    }
    const out: L1Hit[] = [];
    for (const { driverId, hit } of interleaveByRank(keptGroups)) {
      if (out.length >= limit) break;
      // spaceId 从驱动首空间推(Phase 1 一驱动一空间;多空间时 externalId 已含空间位不冲突)
      const space = deps.spacesOf(driverId)[0];
      out.push({
        id: extHitId(driverId, space?.spaceId ?? 'main', hit.externalId),
        content: clip(hit.content, cfg.maxContentChars),
        type: hit.category === undefined ? 'external' : `external:${hit.category}`,
        scene_name: '',
        score: 0, // RRF 融合层的占位分,融合后被归一分覆盖(与 graphLane 同款)
      });
    }
    return out;
  };

  return { provider, statusOf, noteSuccess, noteFailure };
}
