/**
 * issue #16：知识图谱投影的开关判据与"关闭期记账"回归。
 *
 * 这三件事必须一起成立，否则就是"假开关"：
 * 1. `graphFeatureOn` 是**唯一**判据（部署 cfg.graph.enabled 或 面板 live.graphEnabled）；
 * 2. `countMissing` 与 `queueMissing` 用同一段 WHERE（面板预估的数字 = 实际会拉起的量）；
 * 3. 关闭期写入要抹掉"已投影"凭证，否则重开后 `queueMissing` 认为投过了、永不补
 *    —— 图谱内容会永久陈旧，且只能靠人工 `memory_reproject`。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { graphFeatureOn } from '../src/graph/gate.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { MemoryConfig } from '../src/config.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryRecord } from '../src/types.js';

const T = 1_700_000_000_000;

/** 只带 graph 开关的最小 cfg（其余字段本测不读）。 */
const cfg = (graphEnabled: boolean): MemoryConfig => ({ graph: { enabled: graphEnabled } }) as MemoryConfig;

/** live 句柄桩：只需要 get() 返回含 graphEnabled 的对象。 */
const live = (graphEnabled: boolean | 'throw'): LiveSettingsHandle =>
  ({
    supported: true,
    get: () => {
      if (graphEnabled === 'throw') throw new Error('volatile 不可读');
      return { graphEnabled };
    },
    update: async () => {},
  }) as unknown as LiveSettingsHandle;

function rec(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: 'episodic',
    priority: 50,
    scene_name: '日常',
    timestamps: [T],
    createdAt: T,
    updatedAt: T,
    version: 0,
    metadata: {},
    sessionId: 'default',
    family: 'chat',
  };
}

async function withDb<T>(fn: (db: MemoryDb) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-graph-gate-'));
  const db = new MemoryDb(join(dir, 'memory.db'), 0);
  db.init();
  try {
    return await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('graphFeatureOn —— 部署与面板取或（唯一判据）', () => {
  it('部署开 → 无论面板如何都开', () => {
    expect(graphFeatureOn(cfg(true), live(false))).toBe(true);
    expect(graphFeatureOn(cfg(true), undefined)).toBe(true);
  });

  it('部署关 + 面板开 → 开（面板只能追加开，这是取 or 的意义）', () => {
    expect(graphFeatureOn(cfg(false), live(true))).toBe(true);
  });

  it('都关 → 关（默认零行为变化）', () => {
    expect(graphFeatureOn(cfg(false), live(false))).toBe(false);
    expect(graphFeatureOn(cfg(false), undefined)).toBe(false);
  });

  it('live 读取抛错 → 按未开处理，不外溢异常', () => {
    // 部署关 + live 炸：不能把功能卡死成崩溃，也不能凭空打开
    expect(graphFeatureOn(cfg(false), live('throw'))).toBe(false);
    // 部署开 + live 炸：部署侧的强制开不能被 live 故障抬下来
    expect(graphFeatureOn(cfg(true), live('throw'))).toBe(true);
  });
});

describe('countMissing 与 queueMissing 同口径', () => {
  it('待投影条数 = 实际会被拉起入队的条数', async () => {
    await withDb(async (db) => {
      db.upsertL1(rec('r1', '第一条'));
      db.upsertL1(rec('r2', '第二条'));

      // 未投影、无在途 mapping → 两条都算待投影
      expect(db.graphStore.countMissing()).toBe(2);

      // queueMissing 拉起的正是这两条（同一段 WHERE）；返回值是**新建 job 数**，
      // 而一个 job 装 GRAPH_JOB_BATCH(=8) 条记录 —— 2 条只成 1 个 job。
      expect(db.graphStore.queueMissing(10)).toBe(1);

      // 入队后有了在途 mapping：再扫不会重复计（否则面板会永远报同一个数）
      expect(db.graphStore.countMissing()).toBe(0);
    });
  });

  it('invalidateProjected 幂等且不抛（关闭期写路径每题都调它，不能把主流程带崩）', async () => {
    await withDb(async (db) => {
      db.upsertL1(rec('r1', '第一条'));
      db.graphStore.queueMissing(10);
      // 记录此刻在途（不在 graph_projected_records 里），抹凭证是空操作
      expect(() => {
        db.graphStore.invalidateProjected(['r1']);
        db.graphStore.invalidateProjected(['r1']);
        db.graphStore.invalidateProjected([]);
        db.graphStore.invalidateProjected(['不存在的 id']);
      }).not.toThrow();
      // 空操作后仍然"无待投影"（在途 mapping 仍在）
      expect(db.graphStore.countMissing()).toBe(0);
    });
  });
});
