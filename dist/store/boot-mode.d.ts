import type { MemoryLogger } from '../types.js';
export type BootMode = 'on' | 'off' | 'last';
export declare function isBootMode(v: unknown): v is BootMode;
export declare class BootModeStore {
    private readonly logger?;
    private readonly file;
    private mode;
    /** 串行化写，避免并发原子写撞临时文件名（同 SessionModeStore 惯例）。 */
    private writeChain;
    constructor(dataDir: string, logger?: MemoryLogger | undefined);
    /** 权威挡位；未落盘过返回 undefined（调用方回落 volatile / 出厂默认）。 */
    get(): BootMode | undefined;
    set(mode: BootMode): Promise<void>;
}
