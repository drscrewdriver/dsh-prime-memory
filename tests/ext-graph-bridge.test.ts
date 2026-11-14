/**
 * 外部图融合测(计划 T3.6 判据):
 * ① 只取 capabilities.graph 的家;边摘要按"节点 —[关系]→ 节点"成形,孤立节点单列;
 * ② 每驱动行数封顶(防 prompt 失控);③ 60s 缓存生效;④ 单家抛错 = 跳过不外溢。
 */
import { describe, expect, it, vi } from 'vitest';
import { makeExtGraphHints } from '../src/ext-memory/graph-bridge.js';
import { ExtDriverRegistry } from '../src/ext-memory/registry.js';
import { EXT_DRIVER_SPECS } from '../src/ext-memory/types.js';
import type { ExternalMemoryDriver } from '../src/ext-memory/types.js';

function mkDriver(id: string, typeId: keyof typeof EXT_DRIVER_SPECS, graphImpl?: () => Promise<never>) {
  const caps = EXT_DRIVER_SPECS[typeId].capabilities;
  const d: Record<string, unknown> = {
    id,
    typeId,
    capabilities: caps,
    scoreSemantics: EXT_DRIVER_SPECS[typeId].scoreSemantics,
    status: async () => ({ healthy: true }),
    search: async () => ({ results: [], hasMore: false }),
    remember: vi.fn(async () => ({ completion: 'committed' as const })),
    forget: vi.fn(async () => ({ completion: 'committed' as const })),
    list: vi.fn(async () => ({ hits: [], hasMore: false })),
  };
  // 游标方法按 incremental 派生，不再看 freshness：旧写法会给替身装上一个
  // “声明了但一调就报错”的方法，跟真实驱动的能力面不一致。
  if (caps.incremental) d.sincePull = vi.fn(async () => ({ entries: [], next: {} }));
  if (caps.graph || caps.related) {
    d.graph = graphImpl === undefined
      ? vi.fn(async () => ({
          nodes: [
            { externalId: 'n1', label: '甲项目', kind: 'project' },
            { externalId: 'n2', label: '乙系统', kind: 'tool' },
            { externalId: 'n3', label: '孤立节点', kind: 'person' },
          ],
          edges: [{ from: 'n1', to: 'n2', type: 'depends_on' }],
        }))
      : vi.fn(graphImpl);
  }
  if (caps.link) d.link = vi.fn(async () => ({ completion: 'committed' as const }));
  return d as unknown as ExternalMemoryDriver;
}

const spacesOf = (id: string) => [{ spaceId: `${id}:main`, driverId: id, externalId: 'main', name: '', description: '' }];

describe('外部图提示桥(T3.6)', () => {
  it('边摘要 + 孤立节点;只取 graph 能力的家;按驱动封顶行数', async () => {
    const registry = new ExtDriverRegistry();
    registry.register(mkDriver('hs', 'hindsight'));
    registry.register(mkDriver('ss', 'supermemory')); // 无 graph 能力 → 不参与
    const hints = makeExtGraphHints({
      registry,
      spacesOf,
      cfg: () => ({ maxLinesPerDriver: 10, timeoutMs: 5000, cacheMs: 60_000 }),
    });
    const lines = await hints();
    expect(lines.some((l) => l.startsWith('[hs] 甲项目 —[depends_on]→ 乙系统'))).toBe(true);
    expect(lines.some((l) => l.includes('孤立节点'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[ss]'))).toBe(false);
  });

  it('60s 缓存:窗口内不重复打外部图;invalidate 后重取', async () => {
    const registry = new ExtDriverRegistry();
    const d = mkDriver('hs', 'hindsight');
    registry.register(d);
    let t = 1_000_000;
    const hints = makeExtGraphHints({
      registry,
      spacesOf,
      cfg: () => ({ maxLinesPerDriver: 10, timeoutMs: 5000, cacheMs: 60_000 }),
      now: () => t,
    });
    await hints();
    await hints();
    expect((d.graph as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    t += 60_001;
    await hints();
    expect((d.graph as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    hints.invalidate();
    await hints();
    expect((d.graph as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it('单家抛错 = 跳过该家,其它家与整体不外溢', async () => {
    const registry = new ExtDriverRegistry();
    registry.register(mkDriver('bad', 'holographic', async () => {
      throw new Error('graph endpoint down');
    }) as ExternalMemoryDriver);
    registry.register(mkDriver('hs', 'hindsight'));
    const warn = vi.fn();
    const hints = makeExtGraphHints({
      registry,
      spacesOf,
      cfg: () => ({ maxLinesPerDriver: 10, timeoutMs: 5000, cacheMs: 60_000 }),
      logger: { info: () => {}, warn, error: () => {} },
    });
    const lines = await hints();
    expect(lines.every((l) => !l.startsWith('[bad]'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[hs]'))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
