import { readExtMemory } from '../config.js';
import { ExtDriverRegistry } from './registry.js';
import { DRIVER_FACTORIES } from './factory.js';
import { makeExtLane } from './lane.js';
import { parseExtra } from './util.js';
import { parseSecretRef } from './secrets.js';
import { normSyncMode } from './types.js';
import { EXT_DRIVER_TYPES } from './types.js';
export async function buildExtAssembly(opts) {
    const { cfg, logger } = opts;
    const registry = new ExtDriverRegistry(logger);
    const section = readExtMemory(cfg.extMemory);
    const syncMode = opts.syncModeOverride ?? normSyncMode(section?.syncMode);
    const disabled = {
        enabled: false,
        syncMode,
        registry,
        lane: undefined,
        async probe() {
            return { healthy: false, error: '外部记忆未开启(ext_memory.enabled=false)' };
        },
        async dispose() { },
    };
    if (section?.enabled !== true)
        return disabled;
    const spacesByDriver = new Map();
    const timeoutMs = section.requestTimeoutMs > 0 ? section.requestTimeoutMs : 15_000;
    for (const entry of section.drivers) {
        if (!entry.id || !entry.type)
            continue;
        if (!EXT_DRIVER_TYPES.includes(entry.type)) {
            logger.warn(`[memory] ext_memory.drivers "${entry.id}":type "${entry.type}" 不在 9 类清单,跳过`);
            continue;
        }
        const extra = parseExtra(entry.extra);
        // extra 值域收窄到 connection 允许的标量(对象/数组一律 JSON 化成串,不猜形状)
        const conn = { endpoint: entry.endpoint, space: entry.space };
        for (const [k, v] of Object.entries(extra)) {
            conn[k] = typeof v === 'object' ? JSON.stringify(v) : v;
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
            }
            else {
                apiKey = resolved;
            }
        }
        try {
            const driver = await DRIVER_FACTORIES[entry.type]({
                id: entry.id,
                // apiKey 只进驱动实例(请求头),不落任何日志/镜像——ext_drivers 表存的是 secret_refs
                connection: { ...conn, apiKey },
                logger,
                requestTimeoutMs: timeoutMs,
            });
            registry.register(driver, { enabled: entry.enabled });
            const externalId = entry.space || 'main';
            spacesByDriver.set(entry.id, [
                { spaceId: `${entry.id}:${externalId}`, driverId: entry.id, externalId, name: externalId, description: '' },
            ]);
        }
        catch (err) {
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
    const probeCache = new Map();
    const probeInFlight = new Map();
    const cacheMs = section.health?.cacheMs ?? 60_000;
    const probe = async (driverId) => {
        const driver = registry.get(driverId);
        if (driver === undefined)
            return { healthy: false, error: `驱动未在册:${driverId}` };
        const cached = probeCache.get(driverId);
        if (cached !== undefined && Date.now() - cached.at < cacheMs)
            return cached.value;
        const running = probeInFlight.get(driverId);
        if (running !== undefined)
            return running;
        const pending = (async () => {
            try {
                return await driver.status(AbortSignal.timeout(timeoutMs));
            }
            catch (err) {
                return { healthy: false, error: err instanceof Error ? err.message : String(err) };
            }
        })().then((value) => {
            probeCache.set(driverId, { at: Date.now(), value });
            if (value.healthy)
                lane?.noteSuccess(driverId);
            else
                lane?.noteFailure(driverId, value.error ?? 'unhealthy');
            return value;
        }).finally(() => {
            if (probeInFlight.get(driverId) === pending)
                probeInFlight.delete(driverId);
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
