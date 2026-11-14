/**
 * Phase 2 推送泵测试(T2.1-T2.4 判据):用真 MemoryDb/L1Store 汇流口 + 程序化
 * fake 驱动,钉死四道闸与两条状态机路径:
 * ① 双闸/syncMode/族白名单关 → **零入队**(旁路默认零行为);
 * ② 脱敏硬闸:remember 收到的内容必已过词表(密钥不出境);
 * ③ Phase 2 白名单:hard-delete 驱动挂 pending 不派发;
 * ④ 写放大闸:同 digest 重入队 → done skip 不再 remember;
 * ⑤ exact 家 committed → shadow clean;async 家 accepted → awaiting_settle →
 *    list 指纹回捞 linked / 超时 orphan;失败退避至 dead。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import type { MemoryRecord } from '../src/types.js';
import { ExtDriverRegistry } from '../src/ext-memory/registry.js';
import { makeExtPusher, shadowIdFor, type ExtPusherConfig } from '../src/ext-memory/pusher.js';
import { EXT_DRIVER_SPECS } from '../src/ext-memory/types.js';
import type { ExternalHit, ExternalMemoryDriver } from '../src/ext-memory/types.js';
import { recordDigest, normContentKey } from '../src/ext-memory/util.js';
import { pickNextTaskIndex } from '../src/pipeline/runner.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    // Windows 下 sqlite 的 -shm 句柄释放有延迟:EBUSY 重试几次后放弃(不拖死整套)
    for (let i = 0; i < 5; i++) {
      try {
        await rm(d, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
});

function rec(id: string, content: string, family: 'chat' | 'work' = 'work'): MemoryRecord {
  const t = Date.now();
  return { id, content, type: 'work_fact', priority: 60, scene_name: 's', timestamps: [t], createdAt: t, updatedAt: t, family };
}

const cfgBase: ExtPusherConfig = {
  masterEnabled: true,
  enabled: true,
  syncMode: 'push-only',
  families: new Set(['work']),
  maxItems: 200,
  timeBudgetMs: 120_000,
  settleTimeoutMs: 50,
  maxAttempts: 3,
  backoffMs: [1, 3, 10],
  allowHardDelete: false,
  settleScanLimit: 100,
};

async function harness(opts: { driver?: ExternalMemoryDriver; cfg?: Partial<ExtPusherConfig> } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-pusher-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'm.db'), 0);
  db.init();
  const l1 = new L1Store(dataDir, db, undefined, 'keyword', undefined, 0);
  await l1.init();
  const registry = new ExtDriverRegistry();
  const driver = opts.driver ?? fakeDriver('hs', 'hindsight');
  registry.register(driver);
  const wake = vi.fn();
  let cfg = { ...cfgBase, ...opts.cfg };
  const pusher = makeExtPusher({
    registry,
    spacesOf: (id) => [{ spaceId: `${id}:main`, driverId: id, externalId: 'main', name: '', description: '' }],
    ext: db.extSync,
    l1,
    cfg: () => cfg,
    wake,
  });
  l1.setExtSyncHook(pusher.hook);
  return {
    db, l1, driver, registry, wake, pusher, db_ext: db.extSync,
    setCfg: (patch: Partial<ExtPusherConfig>) => { cfg = { ...cfg, ...patch }; },
    close: () => db.close(),
  };
}

function fakeDriver(id: string, typeId: keyof typeof EXT_DRIVER_SPECS): ExternalMemoryDriver {
  const caps = EXT_DRIVER_SPECS[typeId].capabilities;
  const d: Record<string, unknown> = {
    id,
    typeId,
    capabilities: caps,
    scoreSemantics: EXT_DRIVER_SPECS[typeId].scoreSemantics,
    status: async () => ({ healthy: true }),
    search: async () => ({ results: [], hasMore: false }),
    remember: vi.fn(async () => ({ completion: 'committed' as const, externalId: 'ext-1' })),
    forget: vi.fn(async () => ({ completion: 'committed' as const })),
    // list 返回分页形状（计划 ext-to-l1-import）：旧形状是 ExternalHit[]，
    // 改后回捞读 `page.hits`，不适配就是“hits undefined → find 抛错 → 静默不命中”。
    list: vi.fn(async () => ({ hits: [] as ExternalHit[], hasMore: false })),
  };
  // 能力声明要求的条件核逐一在场(assertRuntime 互校):游标方法只看 incremental，不看 freshness
  if (caps.incremental) d.sincePull = vi.fn(async () => ({ entries: [], next: {} }));
  if (caps.graph || caps.related) d.graph = vi.fn(async () => ({ nodes: [], edges: [], generatedAt: '' }));
  if (caps.link) d.link = vi.fn(async () => ({ completion: 'committed' as const }));
  return d as unknown as ExternalMemoryDriver;
}

describe('推送入队闸(T2.1)', () => {
  it('双闸任一关 / shadow-read / chat 族 → 零入队零 wake', async () => {
    const h = await harness();
    try {
      h.setCfg({ enabled: false });
      await h.l1.appendNew([rec('a', '甲')]);
      expect(h.db_ext.countOutbox().pending).toBe(0);
      h.setCfg({ enabled: true, syncMode: 'shadow-read' });
      await h.l1.appendNew([rec('b', '乙')]);
      expect(h.db_ext.countOutbox().pending).toBe(0);
      h.setCfg({ syncMode: 'push-only' });
      await h.l1.appendNew([rec('c', '丙', 'chat')]);
      expect(h.db_ext.countOutbox().pending).toBe(0);
      expect(h.wake).not.toHaveBeenCalled();
      // work 族在双闸开后入队并 wake
      await h.l1.appendNew([rec('d', '丁')]);
      expect(h.db_ext.countOutbox().pending).toBe(1);
      expect(h.wake).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });

  it('retire 只对已在账影子造 forget 队;未推过的退场零入队', async () => {
    const h = await harness();
    try {
      await h.l1.appendNew([rec('a', '推过的')]);
      await h.pusher.runBatch(); // linked(externalId=ext-1)
      const pendingBefore = h.db_ext.countOutbox().pending;
      expect(pendingBefore).toBe(0);
      expect(h.db_ext.getShadowByRecord(h.driver.id, `${h.driver.id}:main`, 'a')).toBeDefined();
      // 'ghost' 从未入库(无影子) → forget 不造队
      h.l1.retire(['a', 'ghost'], { at: new Date().toISOString(), reason: 'manual' });
      expect(h.db_ext.countOutbox().pending).toBe(1); // 只有 a 的 forget
    } finally {
      h.close();
    }
  });
});

describe('推送派发(T2.2)', () => {
  it('exact 路径:remember committed → shadow clean 带 externalId,job done;重推同 digest → skip', async () => {
    const h = await harness();
    try {
      await h.l1.appendNew([rec('a', '部署走 nginx')]);
      const s1 = await h.pusher.runBatch();
      expect(s1.done).toBe(1);
      const remember = h.driver.remember as ReturnType<typeof vi.fn>;
      expect(remember).toHaveBeenCalledTimes(1);
      const shadow = h.db_ext.getShadowByRecord(h.driver.id, `${h.driver.id}:main`, 'a')!;
      expect(shadow.externalId).toBe('ext-1');
      expect(shadow.syncState).toBe('clean');
      expect(shadow.dbDigest).toBe(recordDigest(rec('a', '部署走 nginx')));
      // 同内容再触发(hook 会再入队)→ done skip 不再 remember
      h.db_ext.enqueueOutbox({ jobId: 'j2', driverId: h.driver.id, spaceId: `${h.driver.id}:main`, recordId: 'a', intent: 'add' });
      const s2 = await h.pusher.runBatch();
      expect(s2.skipped).toBe(1);
      expect(remember).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });

  it('脱敏硬闸:密钥正文出境前被替换,remember 只收到 [REDACTED:]', async () => {
    const h = await harness();
    try {
      await h.l1.appendNew([rec('a', '凭据是 Bearer abcdefghijklmnopqrstuvwxyz012345 请记好')]);
      await h.pusher.runBatch();
      const remember = h.driver.remember as ReturnType<typeof vi.fn>;
      const item = remember.mock.calls[0]![1] as { content: string };
      expect(item.content).toContain('[REDACTED:');
      expect(item.content).not.toContain('abcdefghijklmnop');
      // shadow 存的是**脱敏后**指纹(settle 内容匹配与重推跳过都以出境形态为准)
      const shadow = h.db_ext.getShadowByRecord(h.driver.id, `${h.driver.id}:main`, 'a')!;
      expect(shadow.contentNorm).toBe(normContentKey(item.content));
    } finally {
      h.close();
    }
  });

  it('Phase 2 白名单:hard 驱动任务挂 pending 不派发(allowHardDelete=false)', async () => {
    const hard = fakeDriver('m0', 'mem0');
    const h = await harness({ driver: hard });
    try {
      await h.l1.appendNew([rec('a', '甲')]);
      const s = await h.pusher.runBatch();
      expect(s.gated).toBe(1);
      expect(hard.remember as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(h.db_ext.countOutbox().pending).toBe(1); // 挂起不丢(60s 远期重排防热转)
      h.setCfg({ allowHardDelete: true });
      // 翻脸后手动到票验证放行(真实运行靠 60s 重排自然到达)
      const gated = h.db_ext.pickDueOutbox(Date.now() + 120_000, 10)[0]!;
      h.db_ext.setOutboxStatus(gated.jobId, 'pending', { nextAttemptAt: 0 });
      const s2 = await h.pusher.runBatch();
      expect(s2.done).toBe(1);
    } finally {
      h.close();
    }
  });

  it('失败退避→dead:remember 恒抛,attempts 达 maxAttempts 转 dead', async () => {
    const boom = fakeDriver('hs', 'hindsight');
    boom.remember = vi.fn(async () => { throw new Error('503'); });
    const h = await harness({ driver: boom });
    try {
      await h.l1.appendNew([rec('a', '甲')]);
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 20));
        await h.pusher.runBatch();
        if (h.db_ext.countOutbox().dead === 1) break;
      }
      expect(h.db_ext.countOutbox().dead).toBe(1);
      expect(h.db_ext.countOutbox().pending).toBe(0);
    } finally {
      h.close();
    }
  });
});

describe('awaiting-settle 回捞(T2.3)', () => {
  it('accepted → awaiting_settle;list 指纹命中 → linked;未命中超时 → orphan', async () => {
    const async1 = fakeDriver('hs', 'hindsight');
    async1.remember = vi.fn(async () => ({ completion: 'accepted' as const, pendingOp: 'op-1' }));
    const h = await harness({ driver: async1 });
    try {
      await h.l1.appendNew([rec('a', '待回捞内容')]);
      const s1 = await h.pusher.runBatch();
      expect(s1.done).toBe(1);
      const shadow = h.db_ext.getShadowByRecord(h.driver.id, `${h.driver.id}:main`, 'a')!;
      expect(shadow.syncState).toBe('awaiting_settle');
      expect(shadow.pendingOp).toBe('op-1');
      // list 未命中:未超时 → 继续 pending;超时 → orphan(测试环境无 runner 泵,显式驱 runBatch)
      let orphaned = false;
      for (let i = 0; i < 10 && !orphaned; i++) {
        await new Promise((r) => setTimeout(r, 20));
        await h.pusher.runBatch();
        orphaned = h.db_ext.getShadowByRecord(h.driver.id, `${h.driver.id}:main`, 'a')?.syncState === 'orphan';
      }
      expect(orphaned).toBe(true);
      expect(h.db_ext.countOutbox().dead).toBe(1);
      // 再来一条,list 命中 → settle linked
      (async1.list as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        hits: [
          { driverId: 'hs', spaceId: 's', externalId: 'far-9', content: ' 待回捞内容 ', score: 1 },
        ],
        hasMore: false,
      }));
      await h.l1.appendNew([rec('a9', '待回捞内容')]);
      await h.pusher.runBatch(); // a9 → awaiting_settle
      let linked = false;
      for (let i = 0; i < 10 && !linked; i++) {
        await new Promise((r) => setTimeout(r, 20));
        await h.pusher.runBatch(); // 驱 settle 轮
        const st = h.db_ext.getShadowByRecord(h.driver.id, `${h.driver.id}:main`, 'a9');
        linked = st?.syncState === 'clean' && st.externalId === 'far-9';
      }
      expect(linked).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe('forget 传导(T2.4)', () => {
  it('有 externalId → 远端 forget + 影子删除;无 externalId → 清账了事', async () => {
    const h = await harness();
    try {
      await h.l1.appendNew([rec('a', '会被退场')]);
      await h.pusher.runBatch(); // linked ext-1
      h.l1.retire(['a'], { at: new Date().toISOString(), reason: 'manual' });
      const s = await h.pusher.runBatch();
      expect(s.done).toBe(1);
      expect(h.db_ext.getShadowByRecord(h.driver.id, `${h.driver.id}:main`, 'a')).toBeUndefined();
      expect(h.driver.forget as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        { spaceId: `${h.driver.id}:main`, driverId: h.driver.id, externalId: 'main', name: '', description: '' },
        'ext-1',
      );
      expect(shadowIdFor(h.driver.id, 'sp', 'r')).toBe(shadowIdFor(h.driver.id, 'sp', 'r'));
      expect(shadowIdFor(h.driver.id, 'sp', 'r')).not.toBe(shadowIdFor(h.driver.id, 'sp', 'r2'));
    } finally {
      h.close();
    }
  });
});

describe('runner 优先级(计划:graph 后 rebuild 前)', () => {
  it('pickNextTaskIndex: live > graph > ext-sync > rebuild(队首)', () => {
    const t = (kind: 'live' | 'graph' | 'ext-sync' | 'rebuild') => ({ kind, run: async () => 0 });
    expect(pickNextTaskIndex([t('rebuild'), t('ext-sync'), t('graph'), t('live')])).toBe(3);
    expect(pickNextTaskIndex([t('rebuild'), t('ext-sync'), t('graph')])).toBe(2);
    expect(pickNextTaskIndex([t('rebuild'), t('ext-sync')])).toBe(1);
    expect(pickNextTaskIndex([t('rebuild')])).toBe(0);
  });
});
