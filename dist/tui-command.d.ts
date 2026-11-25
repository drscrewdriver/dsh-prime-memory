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
export interface MemorySwitches {
    enabled: boolean;
    capture: boolean;
    distill: boolean;
    recall: boolean;
    injectBootMode: string;
    extractBootMode: string;
    memoryMutate: boolean;
    /** 部署上限：cordis.patch.yml 停用的分项，运行时开关拨不动。 */
    ceilings: {
        capture: boolean;
        distill: boolean;
        recall: boolean;
    };
}
export interface RecalledRow {
    id: string;
    content?: string;
    type?: string;
    family?: string;
    scene_name?: string;
    superseded?: boolean;
    lane?: string;
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
    /** 开关现值（live.get 投影 + 部署上限）。 */
    switches(): MemorySwitches;
    /**
     * 写总闸 enabled（命令层唯一写操作）。实现方内部走 live.update 并回读，
     * 返回是否写入、回读生效值、是否发生漂移（写入成功但回读不一致）。
     */
    setEnabled(next: boolean): Promise<{
        applied: boolean;
        effective: boolean;
        drift: boolean;
    }>;
    /** 某会话已注入的召回集（正文从 l1_records 取；superseded=正文已被摘要取代）。 */
    recalled(sessionId: string, limit: number): RecalledRow[];
    /** 最近有注入记录的会话（--last 用；按 updatedAt 倒序）。 */
    recentSessions(): Array<{
        key: string;
        at: number;
        count: number;
    }>;
}
export declare function clip(text: string, width?: number): string;
export declare function renderLines(lines: string[], limit?: number): string;
/** 纯函数入口。scenes 读目录，所以整体异步。 */
export declare function runMemoryCommand(rawInput: string, deps: MemoryCommandDeps): Promise<CommandResult>;
/** 注册 `/memory`：无 commands 服务时静默跳过（老线安全）。 */
export declare function registerMemoryCommand(ctx: Context, deps: MemoryCommandDeps): void;
