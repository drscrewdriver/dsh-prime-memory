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
import { readExtMemory } from '../config.js';
import type { MemoryLogger } from '../types.js';
import type { ExtLaneProvider } from '../store/l1.js';
import { ExtDriverRegistry } from './registry.js';
import { DRIVER_FACTORIES } from './factory.js';
import { makeExtLane, type ExtLane } from './lane.js';
import { parseExtra } from './util.js';
import { parseSecretRef, type SecretStore } from './secrets.js';
import { normSyncMode, type ExtConnection, type ExtDriverType, type ExtHealthResult, type ExtSpace, type ExtSyncMode } from './types.js';
import { EXT_DRIVER_TYPES } from './types.js';

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

export async function buildExtAssembly(opts: {
  cfg: MemoryConfig;
  logger: MemoryLogger;
  secretStore?: SecretStore;
  /** 共存门控后的有效档位(T4.2;缺席 = 读 cfg)。 */
  syncModeOverride?: ExtSyncMode;
}): Promise<ExtAssembly> {
  const { cfg, logger } = opts;
  const registry = new ExtDriverRegistry(logger);
  const section = readExtMemory(cfg.extMemory);
  const syncMode = opts.syncModeOverride ?? normSyncMode(section?.syncMode);
  const disabled: ExtAssembly = {
    enabled: false,
    syncMode,
    registry,
    lane: undefined,
    async probe() {
      return { healthy: false, error: '外部记忆未开启(ext_memory.enabled=false)' };
    },
    async dispose() {},
  };
  if (section?.enabled !== true) return disabled;

  const spacesByDriver = new Map<string, ExtSpace[]>();
  const timeoutMs = section.requestTimeoutMs > 0 ? section.requestTimeoutMs : 15_000;
  for (const entry of section.drivers) {
    if (!entry.id || !entry.type) continue;
    if (!(EXT_DRIVER_TYPES as readonly string[]).includes(entry.type)) {
      logger.warn(`[memory] ext_memory.drivers "${entry.id}":type "${entry.type}" 不在 9 类清单,跳过`);
      continue;
    }
    const extra = parseExtra(entry.extra);
    // extra 值域收窄到 connection 允许的标量(对象/数组一律 JSON 化成串,不猜形状)
    const conn: Record<string, string | number | boolean> = { endpoint: entry.endpoint, space: entry.space };
    for (const [k, v] of Object.entries(extra)) {
      conn[k] = typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean);
    }
    // 凭据解析(T3.5):apiKey 写 `secret://ref` 形态时从凭据库取(值永不进日志,
    // 未命中按未配置处理并只报 ref 名);直接写明文仍兼容(老配置不改就能跑)。
    let apiKey = entry.apiKey;
    const secretRef = parseSecretRef(entry.apiKey);
    if (secretRef !== undefined) {
      const resolved = await opts.secretStore?.get(secretRef.ref);
      if (resolved === undefined) {
        logger.warn(`[memory] 外部驱动 ${entry.id}:凭据 ref "${secretRef.ref}" 未在凭据库中(或凭据库未启用),按未配置处理`);
        apiKey = '';
      } else {
        apiKey = resolved;
      }
    }
    try {
      const driver = await DRIVER_FACTORIES[entry.type as ExtDriverType]({
        id: entry.id,
        // apiKey 只进驱动实例(请求头),不落任何日志/镜像——ext_drivers 表存的是 secret_refs
        connection: { ...conn, apiKey } as ExtConnection,
        logger,
        requestTimeoutMs: timeoutMs,
      });
      registry.register(driver, { enabled: entry.enabled });
      const externalId = entry.space || 'main';
      spacesByDriver.set(entry.id, [
        { spaceId: `${entry.id}:${externalId}`, driverId: entry.id, externalId, name: externalId, description: '' },
      ]);
    } catch (err) {
      // assertRuntime 拒绝 / 工厂抛错:该驱动整体缺席,其余照常(装配期点名)
      logger.warn(`[memory] 外部驱动 ${entry.id}(${entry.type})装配失败,已跳过:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const laneCfg = () => ({
    maxItemsPerDriver: section.lane?.maxItemsPerDriver ?? 10,
    requestTimeoutMs: timeoutMs,
    maxContentChars: 4000,
    failureThreshold: section.health?.failureThreshold ?? 3,
    openMs: section.health?.openMs ?? 300_000,
  });
  const lane = registry.size > 0 ? makeExtLane({ registry, spacesOf: (id) => spacesByDriver.get(id) ?? [], cfg: laneCfg, logger }) : undefined;

  // 探活缓存(60s)+ in-flight 去重(参考实现 byterover 的形态)
  const probeCache = new Map<string, { at: number; value: ExtHealthResult }>();
  const probeInFlight = new Map<string, Promise<ExtHealthResult>>();
  const cacheMs = section.health?.cacheMs ?? 60_000;
  const probe = async (driverId: string): Promise<ExtHealthResult> => {
    const driver = registry.get(driverId);
    if (driver === undefined) return { healthy: false, error: `驱动未在册:${driverId}` };
    const cached = probeCache.get(driverId);
    if (cached !== undefined && Date.now() - cached.at < cacheMs) return cached.value;
    const running = probeInFlight.get(driverId);
    if (running !== undefined) return running;
    const pending = (async (): Promise<ExtHealthResult> => {
      try {
        return await driver.status(AbortSignal.timeout(timeoutMs));
      } catch (err) {
        return { healthy: false, error: err instanceof Error ? err.message : String(err) };
      }
    })().then((value) => {
      probeCache.set(driverId, { at: Date.now(), value });
      if (value.healthy) lane?.noteSuccess(driverId);
      else lane?.noteFailure(driverId, value.error ?? 'unhealthy');
      return value;
    }).finally(() => {
      if (probeInFlight.get(driverId) === pending) probeInFlight.delete(driverId);
    });
    probeInFlight.set(driverId, pending);
    return pending;
  };

  return {
    enabled: true,
    syncMode,
    registry,
    extLane: lane?.provider,
    lane,
    probe,
    dispose: () => registry.disposeAll(),
  };
}
