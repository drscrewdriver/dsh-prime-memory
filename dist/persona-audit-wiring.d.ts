/**
 * 人格泄露审计接线（persona-leak-guardrails 模块 B4）。
 *
 * 三条纪律：
 * - **定时器只在 ctx.effect 里建**：热重载不泄漏（照抄 startGraphBackfillTimer 骨架）；
 * - **开关在 tick 内判**：注册时判会让"运行时打开"永远不生效（issue #16 的实证半开态）；
 * - **只读连接另开一条**：审计绝不碰插件的写链，跑审计时蒸馏照常。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from './config.js';
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
/** 跑一轮审计（导出让单测/命令面直接调用，不必等定时器）。 */
export declare function runAuditOnce(deps: PersonaAuditDeps): void;
/**
 * 挂定时器。
 *
 * 首轮在启动 5 分钟后跑（避开冷启动关键路径），之后按 `audit.intervalMs`。
 * `audit.enabled=false` 时定时器空转（tick 内判），不产出任何文件。
 */
export declare function registerPersonaAuditTimer(ctx: Context, deps: PersonaAuditDeps): void;
