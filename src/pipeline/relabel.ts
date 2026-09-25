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
import { WING_FALLBACK, type MemoryLogger, type MemoryRecord } from '../types.js';
import type { MemoryBackend } from '../store/memory-backend.js';
import type { MemoryConfig } from '../config.js';
import { labelWingChunk, tagChunk } from '../wing-backfill.js';
import { isWingId, normTags } from '../metadata-validators.js';
import { yieldLoop } from '../util/yield.js';

/** 机械写回上限(首次全量巡检可能上千条待补 cogHall;分次反刍消化,防单次跑飞)。 */
const MECH_CAP = 800;
/** LLM 重标定批上限(每块 20 条由标注器内部控制)。 */
const LLM_CAP = 60;
/** LLM 批大小(一次调用判定的记录数;批次进度/预算/让位都以此为粒度)。 */
const LLM_CHUNK = 20;

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
  /** 记忆后端(后台边界:可 worker 化;热路径不走这里)。 */
  backend: MemoryBackend;
  logger: MemoryLogger;
}

/** 测试注入口:分别替换 wing 标注器与 tags 标注器(默认走真实 LLM 路径)。 */
export interface RelabelOverrides {
  wingLabeler?: (chunk: MemoryRecord[]) => Promise<Array<{ record: MemoryRecord; wing: string }>>;
  tagger?: (chunk: MemoryRecord[]) => Promise<Array<{ record: MemoryRecord; tags: string[] }>>;
}

export interface RelabelOpts {
  /**
   * 批次进度回调(relabeling 阶段的 detail/子进度由此驱动)。
   *
   * 第 4 参 `label` 用于**区分机械段与 LLM 段**:机械巡检按 200 条/批推进,
   * LLM 段按 20 条/批推进,两者粒度不同,面板必须能分辨(否则用户看到的是
   * 一个忽快忽慢的"重标定批次")。
   */
  progress?: (text: string, done: number, total: number, label?: string) => void;
  /** LLM 段墙钟预算(毫秒);超时停止,剩余计入 deferred 留待下次反刍。默认 90s。 */
  timeBudgetMs?: number;
}

export async function relabelPass(
  deps: RelabelDeps,
  overrides: RelabelOverrides = {},
  opts: RelabelOpts = {},
): Promise<RelabelStats> {
  const { ctx, cfg, backend, logger } = deps;
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

  // ── 机械校验 + 修正(游标分批 + 有界写回) ──
  //
  // 分批而非全量:轻量投影只取 id/type/metadata,不拉 content(巡检用不到正文)。
  // 每批后 yieldLoop 让位 → 巡检不会饿死面板 RPC,因此无需另设墙钟预算;
  // 写回上限仍由 MECH_CAP 兜底(超限的记录留给下次反刍,不入账)。
  const PAGE = 200;
  const total = await backend.size();
  const needWingIds: string[] = [];
  const needWingSeen = new Set<string>();
  let scanned = 0;
  let offset = 0;
  let mechWrites = 0;
  let mechCapWarned = false;
  for (;;) {
    const page = await backend.allLite(PAGE, offset);
    if (page.length === 0) break;
    for (const r of page) {
      const meta = { ...r.metadata } as Record<string, unknown>;
      let changed = false;
      let stripped = false;
      let cogFixed = false;

      // Wing 合法性:非法值剥离,转入 LLM 重标队列(词表校验统一走 metadata-validators)
      const wing = meta.hall;
      if (typeof wing === 'string' && wing !== '' && !isWingId(wing)) {
        delete meta.hall;
        changed = true;
        stripped = true;
      }

      // 认知 hall:type 可派生而未写/不一致 → 修正
      const expected = cognitiveHallOf(r.type);
      if (expected && meta[COG_HALL_METADATA_KEY] !== expected) {
        meta[COG_HALL_METADATA_KEY] = expected;
        changed = true;
        cogFixed = true;
      }

      if (changed) {
        // 计数只记**已落盘**的条数(超上限或写失败都不入账,面板数字才对得上库)
        if (mechWrites < MECH_CAP && await backend.patchMetadata(r.id, meta)) {
          mechWrites++;
          if (stripped) stats.wingInvalidFixed++;
          if (cogFixed) stats.cogHallFixed++;
        } else if (mechWrites >= MECH_CAP) {
          // 达上限:本轮不再写,留待下次反刍(静默跳过会让人误以为已处理完,故留痕一次)
          if (!mechCapWarned) {
            mechCapWarned = true;
            logger.info(`[memory] 反刍重标定:机械写回达上限 ${MECH_CAP} 条,其余留待下次反刍`);
          }
        } else {
          logger.warn(`[memory] 反刍重标定机械写回失败(id=${r.id},跳过)`);
        }
      }

      // 未打标 wing(含刚剥离非法值的)进 LLM 队列。
      // 只记 id:批上限只有 60 条,内容在进入 LLM 段时按 id 补水即可,
      // 没必要把上千条完整记录(含正文)全揣在内存里。
      const after = meta.hall;
      if (typeof after !== 'string' || after === '') {
        if (!needWingSeen.has(r.id)) {
          needWingSeen.add(r.id);
          needWingIds.push(r.id);
        }
      }
    }
    scanned += page.length;
    offset += PAGE;
    opts.progress?.(`标注校验:机械巡检 ${scanned}/${total} 条`, scanned, total, '机械巡检');
    await yieldLoop(); // 每批让位:面板状态 RPC 优先于后台巡检
  }
  stats.checked = scanned;

  // ── LLM 重标定(有界;wing.enabled 关闭则跳过) ──
  const wingEnabled = normWingEnabled(cfg.hall?.enabled);
  if (wingEnabled.length === 0 || needWingIds.length === 0) return stats;

  // 按需补水:标注器需要 content 才能构造提示词,而巡检只取了轻量投影。
  // 只给有界批(LLM_CAP 条)按 id 精确取(主键索引),不做全量回填。
  const batch = await backend.getByIds(needWingIds.slice(0, LLM_CAP));
  if (batch.length === 0) return stats;
  logger.info(
    `[memory] 反刍重标定:未打标/待重标 ${needWingIds.length} 条,本次 LLM 处理 ${batch.length} 条(候选 ${[...wingEnabled, WING_FALLBACK].join(' / ')})`,
  );

  const wingLabeler =
    overrides.wingLabeler ??
    ((chunk: MemoryRecord[]) =>
      labelWingChunk(ctx, cfg, logger, chunk, [...wingEnabled, WING_FALLBACK].join(' / ')));

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
    opts.progress?.(`重标定:LLM 补 wing 第 ${i + 1}/${chunks.length} 批(已完成 ${doneCount}/${batch.length} 条)`, doneCount, batch.length, '补 Wing');
    let rows: Array<{ record: MemoryRecord; wing: string }>;
    try {
      rows = await wingLabeler(chunks[i]);
    } catch (err) {
      // labelWingChunk 自身已兜底(不向调用方抛);能走到这里只可能是注入桩抛错。
      // 即便如此也必须留痕——静默吞掉批次是本次「整批丢弃却无日志」的直接教训。
      stats.llmSkipped += chunks[i].length;
      doneCount += chunks[i].length;
      logger.warn(
        `[memory] 重标定第 ${i + 1}/${chunks.length} 批标注器抛错,跳过 ${chunks[i].length} 条: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const dropped = chunks[i].length - rows.length;
    if (dropped > 0) {
      logger.warn(`[memory] 重标定第 ${i + 1}/${chunks.length} 批丢弃 ${dropped} 条(详见上方 wing 回填日志)`);
    }
    stats.llmSkipped += dropped;
    stats.wingLabeled += rows.length;

    // 写前重读:机械阶段可能已写过 cogHall,标注器持有旧副本——以库内最新为基线合并
    const freshRows = await backend.getByIds(rows.map(({ record }) => record.id));
    const freshById = new Map(freshRows.map((r) => [r.id, r]));
    for (const { record, wing } of rows) {
      const current = freshById.get(record.id) ?? record;
      const meta = { ...(current.metadata ?? {}) } as Record<string, unknown>;
      meta.hall = wing;
      try {
        await backend.patchMetadata(current.id, meta);
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
    opts.progress?.(`重标定:提炼涌现标签 第 ${i + 1}/${tagChunks.length} 批`, doneCount, batch.length, '提炼标签');
    let tagRows: Array<{ record: MemoryRecord; tags: string[] }>;
    try {
      tagRows = await tagger(tagChunks[i]);
    } catch (err) {
      logger.warn(
        `[memory] 重标定 tags 第 ${i + 1}/${tagChunks.length} 批标注器抛错,跳过 ${tagChunks[i].length} 条: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const freshTagRows = await backend.getByIds(tagRows.map(({ record }) => record.id));
    const freshForTags = new Map(freshTagRows.map((r) => [r.id, r]));
    for (const { record, tags: rawTags } of tagRows) {
      const tags = normTags(rawTags); // 归一+校验在写回点强制:无论标签来自真实 LLM 还是注入桩
      if (tags.length === 0) continue;
      const current = freshForTags.get(record.id) ?? record;
      const meta = { ...(current.metadata ?? {}) } as Record<string, unknown>;
      meta.tags = tags;
      try {
        await backend.patchMetadata(current.id, meta);
        stats.tagged++;
        await yieldLoop();
      } catch {
        /* 标签写失败不影响主流程 */
      }
    }
  }

  return stats;
}
