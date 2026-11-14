/**
 * 外部记忆装配层(计划 T1.11 的 index 侧收口):cfg.extMemory → registry + lane +
 * 探活缓存,一个对象交给宿主。**总闸关时这里就是全部成本**:不构造驱动、
 * provider 为 undefined(L1Store 的第 5 路结构性不存在)、零定时器零连接。
 *
 * 空间模型(Phase 1):一驱动一空间,`space.externalId` 取配置 `space` 字段
 * (缺省 'main');discover 多空间面在 Phase 3 随拉取一起接。
 *
 * 探活缓存(60s + in-flight 去重)从参考实现 byterover 驱动(9 家里唯一做对的)
 * 照搬:无缓存的 status 会让面板轮询把用户配置的错误端点打成 DDoS 现场。
 */
import type { MemoryConfig } from '../config.js';
import type { MemoryLogger } from '../types.js';
import type { ExtLaneProvider } from '../store/l1.js';
import { ExtDriverRegistry } from './registry.js';
import { type ExtLane } from './lane.js';
import { type SecretStore } from './secrets.js';
import { normSyncMode, type ExtHealthResult, type ExtSyncMode } from './types.js';
export interface ExtAssembly {
    enabled: boolean;
    syncMode: ReturnType<typeof normSyncMode>;
    registry: ExtDriverRegistry;
    /** 交给 L1Store 的第 5 路 provider;无可装配驱动 = undefined(路不存在)。 */
    extLane?: ExtLaneProvider;
    lane: ExtLane | undefined;
    /** 真探活(带 60s 缓存 + in-flight 去重);驱动不在册返回 error 结果。 */
    probe(driverId: string): Promise<ExtHealthResult>;
    dispose(): Promise<void>;
}
export declare function buildExtAssembly(opts: {
    cfg: MemoryConfig;
    logger: MemoryLogger;
    secretStore?: SecretStore;
    /** 共存门控后的有效档位(T4.2;缺席 = 读 cfg)。 */
    syncModeOverride?: ExtSyncMode;
}): Promise<ExtAssembly>;
