/**
 * T2 读侧分类 + T3 版本分层:四态可区分、覆盖保护、分层处置落地。
 *
 * 跑法(本机删除极慢,超时必须放宽):
 *   vitest run tests/file-layer-read.test.ts --testTimeout=60000 --hookTimeout=600000
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPending } from '../src/store/pending.js';
import { EmbeddingSourceStore } from '../src/store/embedding-source.js';
import { OccupancyStore } from '../src/store/occupancy.js';
import { RecallDedupeStore } from '../src/store/recall-dedupe.js';
import { SessionModeStore } from '../src/store/session-modes.js';
import { SlotStore } from '../src/store/slots.js';
import { StateStore } from '../src/store/state.js';
import { readSnapshotManifest, readSnapshotRecords } from '../src/store/l1-snapshot.js';
import { loadRunState } from '../src/pipeline/reconcile-run.js';
import { readJsonStrict } from '../src/util/io.js';
import { flTmp } from './file-layer-tmp.js';

const logs = () => {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  return {
    info,
    warn,
    error,
    logger: {
      debug() {},
      info: (m: string) => info.push(m),
      warn: (m: string) => warn.push(m),
      error: (m: string) => error.push(m),
    },
  };
};

describe('T2.1 readJsonStrict 四态', () => {
  it('missing:文件不存在', async () => {
    const d = await flTmp('strict-missing');
    const r = await readJsonStrict(join(d, 'nope.json'));
    expect(r).toEqual({ ok: false, reason: 'missing' });
  });

  it('unreadable:存在但读不出(目标是目录)', async () => {
    const d = await flTmp('strict-unreadable');
    await mkdir(join(d, 'blocked.json'));
    const r = await readJsonStrict(join(d, 'blocked.json'));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('unreadable');
  });

  it('corrupt:读到了但不是合法 JSON', async () => {
    const d = await flTmp('strict-corrupt');
    const f = join(d, 'bad.json');
    await writeFile(f, '{ not json', 'utf8');
    const r = await readJsonStrict(f);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('corrupt');
  });

  it('unknown_version:仅在传 expectedVersion 且不匹配时产出', async () => {
    const d = await flTmp('strict-version');
    const f = join(d, 'v99.json');
    await writeFile(f, '{"version":99,"a":1}', 'utf8');
    const strict = await readJsonStrict<{ a: number }>(f, { expectedVersion: 1 });
    expect(strict.ok).toBe(false);
    expect(strict.ok === false && strict.reason).toBe('unknown_version');
    // 未传 expectedVersion:不产出 unknown_version,版本只回传
    const lenient = await readJsonStrict<{ a: number }>(f);
    expect(lenient).toEqual({ ok: true, value: { version: 99, a: 1 }, version: 99 });
    // 版本缺失 + 传了期望值 → 也算 unknown_version
    const noVer = join(d, 'nover.json');
    await writeFile(noVer, '{"a":1}', 'utf8');
    const r3 = await readJsonStrict(noVer, { expectedVersion: 1 });
    expect(r3.ok === false && r3.reason).toBe('unknown_version');
  });
});

describe('T2.9 覆盖保护', () => {
  it('损坏文件 + atomicWriteJson → 抛错且字节不变', async () => {
    const d = await flTmp('guard');
    const { atomicWriteJson } = await import('../src/util/io.js');
    const f = join(d, 'state.json');
    const broken = '{"version":2,"famil';
    await writeFile(f, broken, 'utf8');
    await expect(atomicWriteJson(f, { version: 2, families: {} })).rejects.toThrow(/拒绝覆盖/);
    expect(await readFile(f, 'utf8')).toBe(broken);
  });
});

describe('T3.1 / T3.2 state:有迁移路径 → 未知版本拒绝加载', () => {
  it('version:99 → 不迁移、不覆盖、显式报错、save 被拒', async () => {
    const d = await flTmp('state-v99');
    const f = join(d, 'state.json');
    const raw = '{"version":99,"families":{"chat":{"lastExtractAt":123}}}';
    await writeFile(f, raw, 'utf8');
    const log = logs();
    const store = new StateStore(f, log.logger);
    await store.load();
    expect(store.degraded).toMatch(/未知版本/);
    expect(log.error.some((m) => m.includes('拒绝加载'))).toBe(true);
    // 未采用文件内容:checkpoint 仍是默认值
    expect(store.forFamily('chat').lastExtractAt).toBe(0);
    await store.save();
    expect(await readFile(f, 'utf8')).toBe(raw); // 字节未变
    expect(log.warn.some((m) => m.includes('只读降级'))).toBe(true);
  });

  it('文件损坏 → 同样拒绝加载且不覆盖', async () => {
    const d = await flTmp('state-corrupt');
    const f = join(d, 'state.json');
    const broken = '{"version":2,"families":{';
    await writeFile(f, broken, 'utf8');
    const log = logs();
    const store = new StateStore(f, log.logger);
    await store.load();
    expect(store.degraded).toBe('corrupt');
    await store.save();
    expect(await readFile(f, 'utf8')).toBe(broken);
  });

  it('v1 平铺仍走迁移(回归保护)', async () => {
    const d = await flTmp('state-v1');
    const f = join(d, 'state.json');
    await writeFile(f, '{"lastExtractAt":42,"totalExtracted":7}', 'utf8');
    const store = new StateStore(f);
    await store.load();
    expect(store.didMigrate).toBe(true);
    expect(store.forFamily('chat').lastExtractAt).toBe(42);
    expect(store.degraded).toBeUndefined();
  });
});

describe('T3.2 / T3.5 无迁移路径者:未知版本允许读、禁止写', () => {
  it('slots v99 → 值被读出,但写被拒(磁盘字节不变)', async () => {
    const d = await flTmp('slots-v99');
    const f = join(d, 'slots.json');
    const raw = JSON.stringify({
      version: 99,
      rev: 3,
      slots: [{ id: 'slot_1', title: 't', kind: 'task', status: 'open', priority: 2, body: '', refs: [], pinned: false, createdAt: 'x', updatedAt: 'x' }],
    });
    await writeFile(f, raw, 'utf8');
    const log = logs();
    const store = new SlotStore(f, log.logger);
    await store.load();
    expect(store.count()).toBe(1); // 允许读:内容按当前形状解释出来了
    expect(log.warn.some((m) => m.includes('版本未知'))).toBe(true);
    await store.upsert({ title: 'new' }); // 内存照常生效
    expect(store.count()).toBe(2);
    expect(await readFile(f, 'utf8')).toBe(raw); // 但磁盘没被写
    expect(log.warn.some((m) => m.includes('只读降级'))).toBe(true);
  });

  it('slots 损坏 → 空态起步且不回写', async () => {
    const d = await flTmp('slots-corrupt');
    const f = join(d, 'slots.json');
    const broken = '{"version":1,"slots":[';
    await writeFile(f, broken, 'utf8');
    const log = logs();
    const store = new SlotStore(f, log.logger);
    await store.load();
    expect(store.count()).toBe(0);
    await store.upsert({ title: 'x' });
    expect(await readFile(f, 'utf8')).toBe(broken);
    expect(log.warn.some((m) => m.includes('损坏'))).toBe(true);
  });

  it('session-modes v99 → 可读禁写', async () => {
    const d = await flTmp('modes-v99');
    const f = join(d, 'session-modes.json');
    const raw = '{"version":99,"sessions":{"s1":{"mode":"work","updatedAt":' + Date.now() + '}}}';
    await writeFile(f, raw, 'utf8');
    const log = logs();
    const store = new SessionModeStore(d, 'auto', log.logger);
    await store.init();
    expect(store.get('s1')).toBe('work'); // 允许读
    store.set('s2', 'chat');
    await store.flush();
    expect(await readFile(f, 'utf8')).toBe(raw); // 禁写
    expect(log.warn.some((m) => m.includes('只读降级'))).toBe(true);
  });

  it('occupancy 损坏 → 不回写', async () => {
    const d = await flTmp('occ-corrupt');
    const f = join(d, 'occupancy.json');
    const broken = '{"version":1,"sessions":{';
    await writeFile(f, broken, 'utf8');
    const log = logs();
    const store = new OccupancyStore(d, log.logger);
    await store.flush();
    store.save('s1', { stockTokens: 100, recallTokens: 0, profileTokens: 0, lastInjectTokens: 0, updatedAt: Date.now() });
    await store.flush();
    expect(await readFile(f, 'utf8')).toBe(broken);
    expect(log.warn.some((m) => m.includes('损坏'))).toBe(true);
  });

  it('recall-dedupe 损坏 → 不回写', async () => {
    const d = await flTmp('dedupe-corrupt');
    const f = join(d, 'recall-dedupe.json');
    const broken = '{"version":1,"sessions":[[';
    await writeFile(f, broken, 'utf8');
    const log = logs();
    const store = new RecallDedupeStore(d, log.logger);
    await store.flush();
    store.mark('s1', ['r1']);
    await store.flush();
    expect(await readFile(f, 'utf8')).toBe(broken);
    expect(log.warn.some((m) => m.includes('损坏'))).toBe(true);
  });

  it('pending v99 → degraded 且调用方据此不回写', async () => {
    const d = await flTmp('pending-v99');
    const f = join(d, 'pending.json');
    await writeFile(f, '{"version":99,"buckets":{"auto":[],"chat":[],"work":[]}}', 'utf8');
    const log = logs();
    const res = await loadPending(f, log.logger);
    expect(res.degraded).toMatch(/未知版本/);
    expect(log.warn.some((m) => m.includes('版本未知'))).toBe(true);
  });

  it('pending 损坏 → degraded=corrupt(与 missing 可区分)', async () => {
    const d = await flTmp('pending-corrupt');
    const f = join(d, 'pending.json');
    await writeFile(f, '{"version":1,"buckets":', 'utf8');
    const log = logs();
    const res = await loadPending(f, log.logger);
    expect(res.degraded).toBe('corrupt');
    // missing 不告警也不降级
    const log2 = logs();
    const none = await loadPending(join(d, 'nothing.json'), log2.logger);
    expect(none.degraded).toBeUndefined();
    expect(log2.warn).toHaveLength(0);
  });
});

describe('T2.7 快照读回:损坏必须报错,不能返回空数组', () => {
  it('manifest 损坏 → 抛错(不是 undefined)', async () => {
    const d = await flTmp('snap-manifest');
    await writeFile(join(d, 'manifest.json'), '{"version":3,"sections"', 'utf8');
    await expect(readSnapshotManifest(d)).rejects.toThrow(/损坏/);
  });

  it('records 损坏 → 抛错(不是 [])', async () => {
    const d = await flTmp('snap-records');
    await writeFile(join(d, 'l1-records.json'), '[{"id":', 'utf8');
    await expect(readSnapshotRecords(d)).rejects.toThrow(/损坏/);
  });

  it('manifest 缺失仍返回 undefined(旧语义保留)', async () => {
    const d = await flTmp('snap-missing');
    expect(await readSnapshotManifest(d)).toBeUndefined();
  });
});

describe('T2.10 reconcile 续跑状态', () => {
  it('损坏 → 记诊断 + 按空状态继续 + 不抛', async () => {
    const d = await flTmp('reconcile-corrupt');
    const f = join(d, 'reconcile-state.json');
    await writeFile(f, '{"version":1,"done":[', 'utf8');
    const log = logs();
    await expect(loadRunState(f, log.logger)).resolves.toBeUndefined();
    expect(log.warn.some((m) => m.includes('损坏'))).toBe(true);
  });

  it('版本未知 → 记诊断(不再静默当空状态)', async () => {
    const d = await flTmp('reconcile-v99');
    const f = join(d, 'reconcile-state.json');
    await writeFile(f, '{"version":99,"done":[]}', 'utf8');
    const log = logs();
    await expect(loadRunState(f, log.logger)).resolves.toBeUndefined();
    expect(log.warn.some((m) => m.includes('版本未知'))).toBe(true);
  });

  it('缺失 → 静默 undefined', async () => {
    const d = await flTmp('reconcile-missing');
    const log = logs();
    await expect(loadRunState(join(d, 'nope.json'), log.logger)).resolves.toBeUndefined();
    expect(log.warn).toHaveLength(0);
  });
});

describe('T2.11 embedding-source 读侧', () => {
  it('损坏 → init 告警 + set 抛错 + 文件字节不变', async () => {
    const d = await flTmp('es-corrupt');
    const f = join(d, 'embedding-source.json');
    const broken = '{"source":"local",';
    await writeFile(f, broken, 'utf8');
    const log = logs();
    const store = new EmbeddingSourceStore(d, log.logger);
    await store.init();
    expect(log.warn.some((m) => m.includes('损坏'))).toBe(true);
    await expect(store.set({ source: 'off', activeModel: null })).rejects.toThrow(/拒绝覆盖/);
    expect(await readFile(f, 'utf8')).toBe(broken);
  });

  it('无文件 → 默认 remote 且不告警(历史行为不变)', async () => {
    const d = await flTmp('es-missing');
    const log = logs();
    const store = new EmbeddingSourceStore(d, log.logger);
    await store.init();
    expect(store.get()).toEqual({ source: 'remote', activeModel: null });
    expect(log.warn).toHaveLength(0);
  });
});
