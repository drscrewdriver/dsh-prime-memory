/**
 * 知识图谱投影的**唯一开关判据**（issue #16）。
 *
 * 为什么单独一个模块而不是塞进 runner：
 * - `runner` 的五处门（启动补投影 / 周期泵 / enqueue / reproject / maybeQueue）与
 *   `tools` 的写面门（memory_reproject / memory_migrate_relation）必须用**同一个**
 *   判据。判据分散 = 半开态：只改 enqueue 不改泵 → 队列只涨不取；只改泵不改启动 timer
 *   → 运行时开启后存量永不进图；只改 runner 不改工具 → 工具说"未开启"、runner 却在跑。
 * - `tools` 不该为此拉入整个 `pipeline/runner` 的依赖图。
 *
 * 语义：部署 `cfg.graph.enabled` **或** 面板 `live.graphEnabled`（取或，照
 * keywordEnabled / validityTiering 先例）。部署可以硬开、面板只能追加开 ——
 * 反过来（取与）会让面板开关变成"只能关不能开"，而它本来就只能关到部署默认。
 */
import type { MemoryConfig } from '../config.js';
import type { LiveSettingsHandle } from '../settings.js';

export function graphFeatureOn(cfg: MemoryConfig, live?: LiveSettingsHandle): boolean {
  if (cfg.graph?.enabled === true) return true;
  try {
    return live?.get()?.graphEnabled === true;
  } catch {
    // live 读取失败：不能把已开的部署开关抬下来，也不能把功能卡死 → 按未开处理（零行为变化）。
    return false;
  }
}
