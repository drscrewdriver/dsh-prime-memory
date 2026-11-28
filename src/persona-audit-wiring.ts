/**
 * 人格泄露审计接线（persona-leak-guardrails 模块 B4）。
 *
 * 三条纪律：
 * - **定时器只在 ctx.effect 里建**：热重载不泄漏（照抄 startGraphBackfillTimer 骨架）；
 * - **开关在 tick 内判**：注册时判会让"运行时打开"永远不生效（issue #16 的实证半开态）；
 * - **只读连接另开一条**：审计绝不碰插件的写链，跑审计时蒸馏照常。
 */

import { DatabaseSync } from 'node:sqlite';

import type { Context } from '@deepseek-ai/cordis';

import type { MemoryConfig } from './config.js';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { loadPersonaTerms, termsUsable } from './audit/persona-terms.js';
import { listMdFiles, runPersonaLeakAudit } from './audit/persona-leak.js';
import { retirePersonaArtifacts } from './audit/persona-retire.js';
import type { L1Store } from './store/l1.js';
import type { MemoryLogger } from './types.js';

export interface PersonaAuditDeps {
  dataDir: string;
  /** memory.db 绝对路径（审计另开只读连接）。 */
  dbPath: string;
  cfg: MemoryConfig;
  logger: MemoryLogger;
  /**
   * L1 写面（只有 `audit.autoRetire=true` 时才会被碰）。
   * 省略 ⇒ 永远只报告：审计的默认承诺不因装配差异而变。
   */
  l1?: L1Store;
}

/** 画像/md 投射根：md 臂只扫这些（与 memExport.root 同口径）。 */
function mdRoots(deps: PersonaAuditDeps): string[] {
  const roots = [deps.dataDir];
  const configured = deps.cfg.memExport?.root ?? '';
  if (configured !== '' && configured !== deps.dataDir) roots.push(configured);
  return roots;
}

/** 跑一轮审计（导出让单测/命令面直接调用，不必等定时器）。 */
export function runAuditOnce(deps: PersonaAuditDeps): void {
  const terms = loadPersonaTerms(dshHomePath());
  if (!termsUsable(terms)) {
    deps.logger.warn('[memory] 人格审计：词表全空（spirit 未安装且兜底也空），本轮跳过');
    return;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(deps.dbPath, { readOnly: true });
  } catch (err) {
    // 存储降级/库不存在：L1+L0 两臂跳过，md 臂照跑（审计不能因为库读不到就整个静默）
    deps.logger.warn(`[memory] 人格审计：库只读连接失败，本轮只扫 md（${err instanceof Error ? err.message : String(err)}）`);
    db = undefined;
  }
  try {
    const files = mdRoots(deps).flatMap((root) => listMdFiles(root));
    const report = runPersonaLeakAudit({
      dataDir: deps.dataDir,
      terms,
      windowDays: deps.cfg.audit.windowDays,
      ...(db === undefined ? {} : { db }),
      mdFiles: files,
    });
    const { summary, scanned, firstRun } = report;
    deps.logger.info(
      `[memory] 人格审计${firstRun ? '（首跑全库）' : ''}：扫 L1=${scanned.l1} L0=${scanned.l0} md=${scanned.md}，` +
        `命中 ${report.hits.length} 条（high=${summary.high} medium=${summary.medium}；l1=${summary.l1} l0=${summary.l0} md=${summary.md}）`,
    );
    if (summary.high > 0) {
      deps.logger.warn(
        `[memory] 人格泄露审计发现 ${summary.high} 条高危命中（自称/角色名/人设行），` +
          '报告见 <dataDir>/audit/persona-leak.json；默认只报告不删（audit.autoRetire=false）',
      );
    }
    // 显式开启才动库：默认路径连这条分支都进不来，审计对库始终是只读的。
    if (deps.cfg.audit.autoRetire && deps.l1 !== undefined && report.hits.length > 0) {
      void retirePersonaArtifacts(deps.l1, { dryRun: false, terms, logger: deps.logger })
        .then((out) => {
          deps.logger.warn(
            `[memory] 人格审计自动去人格化（autoRetire=true）：改写 ${out.rewritten.length} 条、退场 ${out.emptied.length} 条`,
          );
        })
        .catch((err: unknown) => {
          deps.logger.warn(`[memory] 人格审计自动去人格化失败：${err instanceof Error ? err.message : String(err)}`);
        });
    }
  } finally {
    try {
      db?.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 挂定时器。
 *
 * 首轮在启动 5 分钟后跑（避开冷启动关键路径），之后按 `audit.intervalMs`。
 * `audit.enabled=false` 时定时器空转（tick 内判），不产出任何文件。
 */
export function registerPersonaAuditTimer(ctx: Context, deps: PersonaAuditDeps): void {
  ctx.effect(() => {
    let loop: ReturnType<typeof setInterval> | null = null;
    const tick = (): void => {
      if (!deps.cfg.audit.enabled) return;
      try {
        runAuditOnce(deps);
      } catch (err) {
        deps.logger.warn(`[memory] 人格审计失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const first = setTimeout(() => {
      tick();
      loop = setInterval(tick, deps.cfg.audit.intervalMs);
    }, 300_000);
    return () => {
      clearTimeout(first);
      if (loop !== null) clearInterval(loop);
    };
  });
}
