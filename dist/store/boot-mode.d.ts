import type { MemoryLogger } from '../types.js';
export type BootMode = 'on' | 'off' | 'last';
/** 两轴挡位键：注入 / 提取。 */
export type BootAxis = 'inject' | 'extract';
export declare function isBootMode(v: unknown): v is BootMode;
export declare class BootModeStore {
    private readonly logger?;
    private readonly file;
    private readonly modes;
    /** 串行化写，避免并发原子写撞临时文件名（同 SessionModeStore 惯例）。 */
    private writeChain;
    constructor(dataDir: string, logger?: MemoryLogger | undefined);
    /** 权威挡位；未落盘过返回 undefined（调用方回落 volatile / 出厂默认）。 */
    get(axis: BootAxis): BootMode | undefined;
    set(axis: BootAxis, mode: BootMode): Promise<void>;
}
