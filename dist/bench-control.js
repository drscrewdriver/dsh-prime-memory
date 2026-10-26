import { snapshotDistillUsage } from './llm-usage.js';
/** 服务名(消费方:bench/harness/dsh-bench-runner 的 lifecycle 赛道)。 */
export const BENCH_CONTROL_SERVICE = 'dsh-memory-bench';
/** 注册控制服务,返回注销函数(调用方在插件 dispose 时执行)。 */
export function registerBenchControl(ctx, rebuild, modes, logger) {
    const surface = {
        // bench 场景自带可控数据集，需要确定性重建：水位落差的“二次确认”
        // 属于人机交互护栏，不该阻断自动化赛道，故显式 force。
        rebuildStart: () => rebuild.start(true),
        rebuildStatus: () => rebuild.getStatus(),
        setSessionMode: (sessionId, mode) => modes.set(sessionId, mode),
        getSessionMode: (sessionId) => modes.get(sessionId),
        getDistillUsage: () => snapshotDistillUsage(),
    };
    const dispose = ctx.provide(BENCH_CONTROL_SERVICE, surface);
    logger.info('[memory] bench 控制服务已提供(dsh-memory-bench,仅基准/调试部署)');
    return dispose;
}
