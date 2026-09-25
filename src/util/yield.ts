/**
 * 后台批次的让位工具(共享)。
 *
 * 后台批处理(反刍重标定 / wing 回填 / 后续 worker 编排)的每一步写回之间都必须插队友好让位,
 * 保证设置面板 / input 面板的状态 RPC 永远优先于后台处理(setImmediate 级延迟)。
 *
 * 之所以提取为共享模块:原先它是 `pipeline/relabel.ts` 的文件局部常量,三处后台路径各写一份
 * 会分叉——让位语义必须全局一致,否则某条路径漏让位就会重新出现面板卡顿。
 */
export const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
