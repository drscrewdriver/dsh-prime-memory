export interface RunProcessOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
    /** 错误文案前缀(哪家 CLI 炸的一眼可辨)。 */
    label?: string;
}
export interface RunProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
export declare class ExtProcessError extends Error {
    readonly killed: boolean;
    constructor(message: string, killed?: boolean);
}
export type ProcessRunner = (command: string, args: readonly string[], opts: RunProcessOptions) => Promise<RunProcessResult>;
export declare const runProcess: ProcessRunner;
/** SIGTERM → 宽限 → SIGKILL 的通用等待形态(供常驻子进程驱动复用,Phase 1 先用即发即走)。 */
export declare const TERM_GRACE_MS = 1500;
