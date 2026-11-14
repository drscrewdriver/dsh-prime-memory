/**
 * 外部图融合(计划 T3.6):capabilities.graph 的三家(hindsight / holographic /
 * mnemon-native)外部图数据参与本地图谱投影。
 *
 * ## 为什么是"投影提示"而不是"落库合并"
 * 本地 graph store 是**事实库**:节点带 confidence/来源记录/族,graphLane 的
 * 检索分直接吃它。把外部节点写进去会让"外部数据主权"和"零漂移判据"同时破功
 * (外部节点没有本地来源记录,无法回溯、无法族隔离、外部删除后本地成幽灵)。
 *
 * 所以选**上下文注入**:外部图的节点/关系作为关系线索拼进投影 prompt——LLM
 * 据此对本地记录建立更准的边/别名,产物仍是**本地来源驱动**的图。外部图离线
 * 或缺席时投影行为逐字不变(注入为空 = 无后缀)。
 *
 * ## 缓存
 * 外部图变化慢而投影 job 密集;60s 缓存 + 单驱动失败跳过(图只是锦上添花,
 * 不能因为某家图接口抖动让整轮投影失败——fail-open 到无提示)。
 */
import type { MemoryLogger } from '../types.js';
import type { ExtDriverRegistry } from './registry.js';
import type { ExtSpace } from './types.js';

export interface ExtGraphHintsConfig {
  /** 每驱动贡献的节点行上限(按度数截断,防 prompt 失控)。 */
  maxLinesPerDriver: number;
  timeoutMs: number;
  cacheMs: number;
}

export interface ExtGraphHintsDeps {
  registry: ExtDriverRegistry;
  spacesOf: (driverId: string) => ExtSpace[];
  cfg: () => ExtGraphHintsConfig;
  logger?: MemoryLogger;
  now?: () => number;
}

export interface ExtGraphHints {
  (): Promise<string[]>;
  /** 测试/诊断用:清缓存。 */
  invalidate(): void;
}

/** 一行一个"节点 —关系→ 节点"的可读摘要;孤立节点只写自身。 */
function summarize(driverId: string, snap: { nodes: Array<{ externalId: string; label: string; kind: string }>; edges: Array<{ from: string; to: string; type: string; weight?: number }> }, maxLines: number): string[] {
  const labelOf = new Map(snap.nodes.map((n) => [n.externalId, n.label || n.externalId]));
  const lines: string[] = [];
  for (const e of snap.edges) {
    const from = labelOf.get(e.from) ?? e.from;
    const to = labelOf.get(e.to) ?? e.to;
    if (from === '' || to === '') continue;
    lines.push(`${from} —[${e.type}]→ ${to}`);
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines) {
    const linked = new Set(snap.edges.flatMap((e) => [e.from, e.to]));
    for (const n of snap.nodes) {
      if (linked.has(n.externalId)) continue;
      lines.push(`${n.label || n.externalId}(${n.kind})`);
      if (lines.length >= maxLines) break;
    }
  }
  return lines.length === 0 ? [] : lines.map((l) => `[${driverId}] ${l}`);
}

export function makeExtGraphHints(deps: ExtGraphHintsDeps): ExtGraphHints {
  const nowMs = deps.now ?? (() => Date.now());
  let cache: { at: number; lines: string[] } | undefined;

  const hints = async (): Promise<string[]> => {
    const cfg = deps.cfg();
    if (cfg.maxLinesPerDriver <= 0) return [];
    if (cache !== undefined && nowMs() - cache.at < cfg.cacheMs) return cache.lines;
    const lines: string[] = [];
    for (const driver of deps.registry.enabled()) {
      if (!driver.capabilities.graph || driver.graph === undefined) continue;
      const space = deps.spacesOf(driver.id)[0];
      if (space === undefined) continue;
      try {
        const snap = await driver.graph(space, AbortSignal.timeout(cfg.timeoutMs));
        lines.push(...summarize(driver.id, snap, cfg.maxLinesPerDriver));
      } catch (err) {
        deps.logger?.warn(`[memory] 外部图融合跳过 ${driver.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    cache = { at: nowMs(), lines };
    return lines;
  };

  const fn = hints as ExtGraphHints;
  fn.invalidate = () => {
    cache = undefined;
  };
  return fn;
}
