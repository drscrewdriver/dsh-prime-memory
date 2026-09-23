/**
 * 反刍的标注校验/重标定阶段:对 L1 存量做一次有界巡检——
 *
 * 1. **机械校验**(零 LLM,全量扫描,有界写回):
 *    - Wing 合法性:metadata.hall 非空但不在词表(8 角 + general)→ 剥离非法值,转入 LLM 重标队列;
 *    - 认知 hall:按 type 静态映射(cognitive-hall.ts)可派生而 metadata.cogHall 缺失/不一致 → 补写修正;
 * 2. **LLM 重标定**(有界批,受 wing.enabled 门控):
 *    - 未打标 wing 的记录复用一键回填的标注器(labelWingChunk)补打;
 *    - 涌现标签(tags,Room 的前身):同一批记录由标注器顺带产出 1-3 个 slug 标签写 metadata.tags。
 *
 * 安全边界与一键回填一致:LLM 失败只跳过当前块、原记录零改动;机械与 LLM 写回都有上限,防止单次跑飞。
 * 本阶段在反刍收尾(L2/L3 之后)执行,**任何失败不拖垮反刍整体**(只 warn + 计数)。
 */
import type { Context } from '@deepseek-ai/cordis';
import { cognitiveHallOf, COG_HALL_METADATA_KEY } from '../cognitive-hall.js';
import { normWingEnabled } from '../config.js';
import { WING_FALLBACK, WING_CATALOG, type MemoryLogger, type MemoryRecord } from '../types.js';
import type { L1Store } from '../store/l1.js';
import type { MemoryConfig } from '../config.js';
import { labelWingChunk, tagChunk } from '../wing-backfill.js';

/** 机械写回上限(首次全量巡检可能上千条待补 cogHall;分次反刍消化,防单次跑飞)。 */
const MECH_CAP = 800;
/** LLM 重标定批上限(每块 20 条由标注器内部控制)。 */
const LLM_CAP = 60;
/** LLM 批大小(一次调用判定的记录数;批次进度/预算/让位都以此为粒度)。 */
const LLM_CHUNK = 20;
/** slug 标签校验:小写字母数字连字符,1-32 字符。 */
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface RelabelStats {
  /** 巡检记录总数。 */
  checked: number;
  /** 机械补写认知 hall(metadata.cogHall)条数。 */
  cogHallFixed: number;
  /** 剥离非法 wing 值条数(已转入 LLM 重标队列)。 */
  wingInvalidFixed: number;
  /** LLM 补打 wing 成功条数。 */
  wingLabeled: number;
  /** 写入涌现标签(tags)的记录条数。 */
  tagged: number;
  /** LLM 失败/跳过的记录条数(原记录零改动)。 */
  llmSkipped: number;
  /** 时间预算用尽时未处理、留待下次反刍的条数。 */
  deferred: number;
}

export interface RelabelDeps {
  ctx: Context;
  cfg: MemoryConfig;
  l1: L1Store;
  logger: MemoryLogger;
}

/** 测试注入口:分别替换 wing 标注器与 tags 标注器(默认走真实 LLM 路径)。 */
export interface RelabelOverrides {
  wingLabeler?: (chunk: MemoryRecord[]) => Promise<Array<{ record: MemoryRecord; wing: string }>>;
  tagger?: (chunk: MemoryRecord[]) => Promise<Array<{ record: MemoryRecord; tags: string[] }>>;
}

export interface RelabelOpts {
  /** 批次进度回调(relabeling 阶段的 detail/子进度由此驱动)。 */
  progress?: (text: string, done: number, total: number) => void;
  /** LLM 段墙钟预算(毫秒);超时停止,剩余计入 deferred 留待下次反刍。默认 90s。 */
  timeBudgetMs?: number;
}

function slugTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = v
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => TAG_RE.test(t));
  return [...new Set(out)].slice(0, 3);
}

/** 让出事件循环:后台批次的每一步写回之间都必须插队友好让位,
 *  保证设置面板/input 面板的状态 RPC 永远优先于后台处理(setImmediate 级延迟)。 */
const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function relabelPass(
  deps: RelabelDeps,
  overrides: RelabelOverrides = {},
  opts: RelabelOpts = {},
): Promise<RelabelStats> {
  const { ctx, cfg, l1, logger } = deps;
  const timeBudgetMs = opts.timeBudgetMs ?? 90_000;
  const stats: RelabelStats = {
    checked: 0,
    cogHallFixed: 0,
    wingInvalidFixed: 0,
    wingLabeled: 0,
    tagged: 0,
    llmSkipped: 0,
    deferred: 0,
  };

  const wingIds = new Set<string>([...WING_CATALOG.map((w) => w.id), WING_FALLBACK]);
  const all = l1.all();
  stats.checked = all.length;

  // ── 机械校验 + 修正(有界写回) ──
  const needWingLLM: MemoryRecord[] = [];
  let mechWrites = 0;
  for (const r of all) {
    const meta = { ...(r.metadata ?? {}) } as Record<string, unknown>;
    let changed = false;

    // Wing 合法性:非法值剥离,转入 LLM 重标队列
    const wing = meta.hall;
    if (typeof wing === 'string' && wing !== '' && !wingIds.has(wing)) {
      delete meta.hall;
      changed = true;
      stats.wingInvalidFixed++;
      needWingLLM.push({ ...r, metadata: meta });
    }

    // 认知 hall:type 可派生而未写/不一致 → 修正
    const expected = cognitiveHallOf(r.type);
    if (expected && meta[COG_HALL_METADATA_KEY] !== expected) {
      meta[COG_HALL_METADATA_KEY] = expected;
      changed = true;
      stats.cogHallFixed++;
    }

    if (changed && mechWrites < MECH_CAP) {
      mechWrites++;
      try {
        await l1.upsert({ ...r, metadata: meta });
        await yieldLoop(); // 每次写回后让位:面板状态 RPC 优先
      } catch (err) {
        logger.warn(`[memory] 反刍重标定机械写回失败(id=${r.id},跳过): ${err instanceof Error ? err.message : String(err)}`);
        mechWrites--;
      }
    }

    // 未打标 wing(含刚剥离非法值的)进 LLM 队列
    const after = meta.hall;
    if (typeof after !== 'string' || after === '') {
      if (!needWingLLM.some((x) => x.id === r.id)) needWingLLM.push({ ...r, metadata: meta });
    }
  }

  // ── LLM 重标定(有界;wing.enabled 关闭则跳过) ──
  const wingEnabled = normWingEnabled(cfg.hall?.enabled);
  if (wingEnabled.length === 0 || needWingLLM.length === 0) return stats;

  const batch = needWingLLM.slice(0, LLM_CAP);
  if (batch.length === 0) return stats;
  logger.info(
    `[memory] 反刍重标定:未打标/待重标 ${needWingLLM.length} 条,本次 LLM 处理 ${batch.length} 条(候选 ${[...wingEnabled, WING_FALLBACK].join(' / ')})`,
  );

  const wingLabeler =
    overrides.wingLabeler ??
    ((chunk: MemoryRecord[]) =>
      labelWingChunk(ctx, cfg, logger, chunk, [...wingEnabled, WING_FALLBACK].join(' / ')).then((rows) =>
        rows.map(({ record, hall }) => ({ record, wing: hall })),
      ));

  // ── LLM wing 重标定:20 条/批逐批推进,批间让位 + 墙钟预算 + 批次进度回显 ──
  const startedAt = Date.now();
  const overBudget = (): boolean => Date.now() - startedAt > timeBudgetMs;
  const chunks: MemoryRecord[][] = [];
  for (let i = 0; i < batch.length; i += LLM_CHUNK) chunks.push(batch.slice(i, i + LLM_CHUNK));
  let doneCount = 0;
  let taggedPool: MemoryRecord[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (overBudget()) {
      stats.deferred += batch.length - doneCount;
      opts.progress?.(`重标定:时间预算(${Math.round(timeBudgetMs / 1000)}s)用尽,剩余 ${batch.length - doneCount} 条留待下次反刍`, doneCount, batch.length);
      logger.info(`[memory] 反刍重标定:时间预算用尽,deferred ${stats.deferred} 条`);
      return stats;
    }
    opts.progress?.(`重标定:LLM 补 wing 第 ${i + 1}/${chunks.length} 批(已完成 ${doneCount}/${batch.length} 条)`, doneCount, batch.length);
    let rows: Array<{ record: MemoryRecord; wing: string }>;
    try {
      rows = await wingLabeler(chunks[i]);
    } catch {
      stats.llmSkipped += chunks[i].length;
      doneCount += chunks[i].length;
      continue;
    }
    stats.llmSkipped += chunks[i].length - rows.length;
    stats.wingLabeled += rows.length;

    // 写前重读:机械阶段可能已写过 cogHall,标注器持有旧副本——以库内最新为基线合并
    const freshById = new Map(l1.getByIds(rows.map(({ record }) => record.id)).map((r) => [r.id, r]));
    for (const { record, wing } of rows) {
      const current = freshById.get(record.id) ?? record;
      const meta = { ...(current.metadata ?? {}) } as Record<string, unknown>;
      meta.hall = wing;
      try {
        await l1.upsert({ ...current, metadata: meta });
        taggedPool.push(current);
      } catch {
        stats.wingLabeled--;
        stats.llmSkipped++;
      }
      await yieldLoop();
    }
    doneCount += chunks[i].length;
  }

  // ── 涌现标签(tags,Room 前身):同批有界 40 条,同样分批 + 预算 + 进度 ──
  const tagBatch = taggedPool.slice(0, 40);
  const tagger = overrides.tagger ?? ((chunk: MemoryRecord[]) => tagChunk(ctx, cfg, logger, chunk));
  const tagChunks: MemoryRecord[][] = [];
  for (let i = 0; i < tagBatch.length; i += LLM_CHUNK) tagChunks.push(tagBatch.slice(i, i + LLM_CHUNK));
  for (let i = 0; i < tagChunks.length; i++) {
    if (overBudget()) break;
    opts.progress?.(`重标定:提炼涌现标签 第 ${i + 1}/${tagChunks.length} 批`, doneCount, batch.length);
    let tagRows: Array<{ record: MemoryRecord; tags: string[] }>;
    try {
      tagRows = await tagger(tagChunks[i]);
    } catch {
      continue;
    }
    const freshForTags = new Map(l1.getByIds(tagRows.map(({ record }) => record.id)).map((r) => [r.id, r]));
    for (const { record, tags: rawTags } of tagRows) {
      const tags = slugTags(rawTags); // 归一+校验在写回点强制:无论标签来自真实 LLM 还是注入桩
      if (tags.length === 0) continue;
      const current = freshForTags.get(record.id) ?? record;
      const meta = { ...(current.metadata ?? {}) } as Record<string, unknown>;
      meta.tags = tags;
      try {
        await l1.upsert({ ...current, metadata: meta });
        stats.tagged++;
        await yieldLoop();
      } catch {
        /* 标签写失败不影响主流程 */
      }
    }
  }

  return stats;
}
