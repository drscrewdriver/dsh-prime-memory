/**
 * tui-command.ts — `/memory`：prime-memory 的 dsh-tui 终端面（宿主斜杠命令）。
 *
 * 背景：dsh-tui 不加载 client 半边（59 个 client 文件里的 11 个 tab 全部不执行），
 * 也调不到插件 RPC。记忆库在终端里因此完全不可见。命令面只读：
 *   status   = 库路径/维度 + L0/L1/回执/冲突计数
 *   records  = 最近 N 条 L1 原子记忆（按 updated_time 倒序）
 *   conflicts= 待裁决冲突数与前几条
 *
 * 契约（.agents/plans/dsh-tui-faces/spec.md §3）：单行 <=100、总行 <=40、无 ANSI、--json 单行。
 */
import type { Context } from '@deepseek-ai/cordis';
export type CommandKind = 'success' | 'error';
export interface CommandResult {
    kind: CommandKind;
    text: string;
}
export interface MemoryRow {
    record_id?: string;
    content?: string;
    type?: string;
    priority?: number;
    scene_name?: string;
    updated_time?: string;
    family?: string;
}
export interface MemoryStatus {
    dbPath: string;
    dims: number;
    l0: number;
    l1: number;
    receipts: number;
    conflicts: number;
    error?: string;
}
export interface MemoryCommandDeps {
    status(): MemoryStatus;
    records(limit: number): MemoryRow[];
    conflicts(limit: number): MemoryRow[];
    /** 外部记忆驱动（配置是事实源，ext_drivers 只是运行态镜像）。 */
    ext(): {
        enabled: boolean;
        syncMode: string;
        drivers: string[];
    };
    /** Room 注册表（major 或 major/minor）。 */
    rooms(): Array<{
        slug: string;
        label?: string;
        status?: string;
    }>;
    /** L2/L3 分族场景文件。 */
    scenes(): Promise<{
        chat: number;
        work: number;
        sample: string[];
    }>;
}
export declare function clip(text: string, width?: number): string;
export declare function renderLines(lines: string[], limit?: number): string;
/** 纯函数入口。scenes 读目录，所以整体异步。 */
export declare function runMemoryCommand(rawInput: string, deps: MemoryCommandDeps): Promise<CommandResult>;
/** 注册 `/memory`：无 commands 服务时静默跳过（老线安全）。 */
export declare function registerMemoryCommand(ctx: Context, deps: MemoryCommandDeps): void;
