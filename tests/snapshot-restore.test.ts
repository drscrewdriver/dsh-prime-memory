/**
 * 快照清单 / 回灌端点(task_27)——把"清理不可逆"补成"清理可回滚"。
 *
 * ## 这个文件防的是什么
 * `cleanup-retired` 是本插件**唯一不可逆**的动作,而 `exportThenPurge` 早已忠实落盘。
 * 但在此之前 `restoreL1Snapshot` 在整个 `src/` 里**零调用** —— 只有测试在调它。
 * 于是"先有导出物再清理"只成立了一半:导出物在,**回灌出口不在**;真出事只能
 * 人工解析 `l1-records.json` 再想办法塞回库里。
 *
 * 本文件把接线后的行为钉死,并额外加一条结构性守卫:该原语必须存在生产调用方
 * (与 `deleteL1Batch` 只有一个调用方那条守卫同源——一个是"只能这么删",
 * 一个是"删了能这么回来")。
 *
 * ## 纪律
 * - 默认**干跑**:省略 `dryRun` 即视为 true,且干跑帧**确实不写库**(有断言);
 * - 名字寻址,**不接受路径**:非法名一律抛错而不是静默返零;
 * - `missing` 必须**在写库之前**算——写完再算恒为 0,那字段就废了(有断言)。
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const { L1Store } = await import('../src/store/l1.js');
const { MemoryDb } = await import('../src/store/sqlite.js');
const { createL1Snapshot, snapshotPathFor } = await import('../src/store/l1-snapshot.js');
const { handleEndpoint, buildEndpointDeps } = await import('../src/stats.js');
const { memorySchema } = await import('../src/config.js');

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} } as never;
const DEFAULTS = (memorySchema as unknown as (v: unknown) => Record<string, unknown>)({});

const dirs: string[] = [];
afterAll(async () => {
  // Windows 上失败的用例可能没走到 close():EBUSY 不该盖住真正的断言失败
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
});

function rec(id: string, content: string): Record<string, unknown> {
  const t = 1_700_000_000_000;
  return { id, content, type: 'work_fact', priority: 60, scene_name: 's', timestamps: [t], createdAt: t, updatedAt: t, version: 0, metadata: {}, family: 'work' };
}

/** 直查基础表(端点返回的是"意图",表里有没有行才是"事实")。 */
function n(db: InstanceType<typeof MemoryDb>, sql: string, id: string): number {
  return (
    (db as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db
      .prepare(sql)
      .get(id) as { n: number }
  ).n;
}
const rowCount = (db: InstanceType<typeof MemoryDb>, id: string): number =>
  n(db, 'SELECT COUNT(*) AS n FROM l1_records WHERE record_id = ?', id);
const ftsCount = (db: InstanceType<typeof MemoryDb>, id: string): number =>
  n(db, 'SELECT COUNT(*) AS n FROM l1_fts WHERE record_id = ?', id);

interface H {
  dataDir: string;
  db: InstanceType<typeof MemoryDb>;
  store: InstanceType<typeof L1Store>;
  deps: ReturnType<typeof buildEndpointDeps>;
  /** 建一个"开/关高权限"的 deps(权限门专项用)。 */
  depsWith: (mutate: boolean) => ReturnType<typeof buildEndpointDeps>;
}

async function setup(tag: string): Promise<H> {
  const dataDir = await mkdtemp(join(tmpdir(), `dsh-snap-${tag}-`));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
  db.init();
  const store = new L1Store(dataDir, db, undefined, 'keyword', noopLogger, 0);
  await store.init();
  await store.appendNew([rec('r1', '被清理的记忆甲'), rec('r2', '活动记忆乙'), rec('r3', '活动记忆丙')] as never);
  store.retire(['r1'], { at: '2026-09-18T12:00:00.000Z', reason: 'manual' });
  const cfg = { ...DEFAULTS, dataDir } as Record<string, unknown>;
  const base = { ctx: {} as never, cfg: cfg as never, stores: { l1: store } as never, logger: noopLogger };
  // `MemoryRpcSources` 未导出,用 Parameters 取形即可(不为了测试把它变成公共 API)。
  const depsWith = (mutate: boolean) =>
    buildEndpointDeps(
      base,
      { live: { get: () => ({ memoryMutate: mutate }) } } as unknown as Parameters<typeof buildEndpointDeps>[1],
      undefined,
    );
  return { dataDir, db, store, deps: depsWith(true), depsWith };
}

interface RestoreView {
  name: string;
  dir: string;
  dryRun: boolean;
  inSnapshot: number;
  targets: number;
  missing: number;
  restored: number;
  failed: number;
  vectorsWritten: number;
  unretired: number;
  stillRetired: string[];
  notFound: string[];
  notice?: string;
}
interface ListView {
  items: { name: string; dir: string; createdAt: string; reason: string; records: number; receipts: number; conflicts: number; vecCount: number }[];
  total: number;
}
const list = (deps: ReturnType<typeof buildEndpointDeps>, payload: unknown = {}) =>
  handleEndpoint('dsh-memory/snapshots-list', payload, deps) as Promise<ListView>;
const restore = (deps: ReturnType<typeof buildEndpointDeps>, payload: unknown) =>
  handleEndpoint('dsh-memory/snapshot-restore', payload, deps) as Promise<RestoreView>;

describe('快照清单', () => {
  it('还没建过快照 → 空列表,不抛(部署状态不是调用错误)', async () => {
    const h = await setup('empty');
    expect(await list(h.deps)).toEqual({ items: [], total: 0 });
    h.db.close();
  });

  it('列出清理产物,`name` 与 `reason` 可对上;忽略没有合法清单的目录', async () => {
    const h = await setup('list');
    const purge = await h.store.purgeRetired(['r1'], 'cleanup-retired');
    expect(purge.purged).toBe(1);
    expect(purge.name).not.toBe('');
    // 半截写入的产物:目录在、清单不在 —— 选中它恢复会得到 0 条却报"成功"
    await mkdir(join(h.dataDir, 'snapshots', 'l1-20200101T000000Z-half'), { recursive: true });

    const l = await list(h.deps);
    expect(l.total).toBe(1);
    expect(l.items[0].name).toBe(purge.name);
    expect(l.items[0].reason).toBe('cleanup-retired');
    expect(l.items[0].records).toBe(3); // 拍的是删除前的全量
    expect(l.items[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(l.items.some((i) => i.name.includes('half'))).toBe(false);
    h.db.close();
  });

  it('按时间**倒序**(最新的在前),且 limit 只截断返回不截断 total', async () => {
    const h = await setup('order');
    await createL1Snapshot(h.db, snapshotPathFor(h.dataDir, new Date('2026-01-01T00:00:00Z'), 'old'), 'old');
    await createL1Snapshot(h.db, snapshotPathFor(h.dataDir, new Date('2026-02-01T00:00:00Z'), 'new'), 'new');
    const all = await list(h.deps);
    expect(all.total).toBe(2);
    expect(all.items.map((i) => i.reason)).toEqual(['new', 'old']);
    const one = await list(h.deps, { limit: 1 });
    expect(one.items.length).toBe(1);
    expect(one.total).toBe(2);
    h.db.close();
  });
});

describe('快照回灌(清理的回程票)', () => {
  it('干跑→真跑闭环:被物理删掉的记录能回到检索面', async () => {
    const h = await setup('loop');
    const purge = await h.store.purgeRetired(['r1'], 'cleanup-retired');
    expect(rowCount(h.db, 'r1')).toBe(0);
    expect(ftsCount(h.db, 'r1')).toBe(0);

    // ① 默认干跑:算得出来,但**一行都不写**
    const dry = await restore(h.deps, { name: purge.name });
    expect(dry).toMatchObject({ dryRun: true, inSnapshot: 3, targets: 3, missing: 1, restored: 0, failed: 0, vectorsWritten: 0 });
    expect(rowCount(h.db, 'r1')).toBe(0);
    expect(ftsCount(h.db, 'r1')).toBe(0);

    // ② 显式真跑
    const real = await restore(h.deps, { name: purge.name, dryRun: false });
    expect(real).toMatchObject({ dryRun: false, inSnapshot: 3, targets: 3, missing: 1, restored: 3, failed: 0, notFound: [] });
    // `missing` 是**写库前**算的:真跑后也就找回了这一条
    expect(rowCount(h.db, 'r1')).toBe(1);
    expect(real.dir).toContain('snapshots');
    // 回到主表**但没回到检索面** —— 这是本次接线最容易漏掉的一跳(详见下一条用例)
    expect(ftsCount(h.db, 'r1')).toBe(0);
    expect(real.stillRetired).toContain('r1');
    h.db.close();
  });

  it('`unretire:true` 一步回滚:记录重新出现在检索面', async () => {
    const h = await setup('unretire');
    const purge = await h.store.purgeRetired(['r1'], 'cleanup-retired');
    const r = await restore(h.deps, { name: purge.name, dryRun: false, unretire: true });
    expect(r.unretired).toBeGreaterThan(0);
    expect(r.stillRetired).toEqual([]);
    expect(r.notice).toBeUndefined();
    expect(rowCount(h.db, 'r1')).toBe(1);
    expect(ftsCount(h.db, 'r1')).toBe(1); // 真的回到召回里了
    h.db.close();
  });

  it('恢复的是"当时的状态":r1 仍是退场态,且**如实报出**而不是假装恢复完了', async () => {
    const h = await setup('state');
    const purge = await h.store.purgeRetired(['r1'], 'cleanup-retired');
    // 干跑也要预告这一跳(否则真跑才发现"恢复了却搜不到")
    const dry = await restore(h.deps, { name: purge.name });
    expect(dry.stillRetired).toContain('r1');
    const real = await restore(h.deps, { name: purge.name, dryRun: false });
    expect(rowCount(h.db, 'r1')).toBe(1);
    // 快照里 r1 带着退场标记 → upsert 时仍被判定为已退场,故 FTS 不该有它
    expect(ftsCount(h.db, 'r1')).toBe(0);
    expect(real.stillRetired).toContain('r1');
    expect(real.notice).toContain('退场态');
    h.db.close();
  });

  it('`ids` 精确回灌(不整库倒灌),且报出快照里没有的 id', async () => {
    const h = await setup('ids');
    const purge = await h.store.purgeRetired(['r1'], 'cleanup-retired');
    // 先干掉 r2 伪造出"库里少两条"的局面,再只要求找回 r1
    h.db.deleteL1Batch(['r2']);
    expect(rowCount(h.db, 'r2')).toBe(0);

    const r = await restore(h.deps, { name: purge.name, ids: ['r1', 'r2', 'never-existed'], dryRun: false });
    expect(r.targets).toBe(2); // r1 + r2(快照里有)
    expect(r.notFound).toEqual(['never-existed']); // 请求了但快照里没有
    expect(rowCount(h.db, 'r1')).toBe(1);
    expect(rowCount(h.db, 'r2')).toBe(1);
    h.db.close();
  });

  it('幂等:同一份快照连恢复两遍等价(upsert 而非 insert)', async () => {
    const h = await setup('idem');
    const purge = await h.store.purgeRetired(['r1'], 'cleanup-retired');
    const a = await restore(h.deps, { name: purge.name, dryRun: false });
    const b = await restore(h.deps, { name: purge.name, dryRun: false });
    expect(a.restored).toBe(b.restored);
    expect(rowCount(h.db, 'r1')).toBe(1); // 没有变成两行
    h.db.close();
  });
});

describe('名字寻址与权限门', () => {
  it('只收目录名:路径 / .. / 无 l1- 前缀 一律抛错,不静默返零', async () => {
    const h = await setup('name');
    for (const bad of ['../secret', 'sub/dir', 'l1-x/../y', 'l1-..-x', 'plain']) {
      await expect(restore(h.deps, { name: bad })).rejects.toThrow(/name 非法/);
    }
    await expect(restore(h.deps, {})).rejects.toThrow(/需要 name/);
    await expect(restore(h.deps, { name: '   ' })).rejects.toThrow(/需要 name/);
    h.db.close();
  });

  it('名字合法但快照不存在 → 返回 notice,不抛也不假装成功', async () => {
    const h = await setup('ghost');
    const r = await restore(h.deps, { name: 'l1-20200101T000000Z-ghost', dryRun: false });
    expect(r.restored).toBe(0);
    expect(r.inSnapshot).toBe(0);
    expect(r.notice).toContain('找不到快照');
    h.db.close();
  });

  it('清单版本不符的目录 = 找不到(不被半截产物骗过)', async () => {
    const h = await setup('badver');
    const dir = join(h.dataDir, 'snapshots', 'l1-20200101T000000Z-badver');
    await mkdir(dir, { recursive: true });
    const { atomicWriteJson } = await import('../src/util/io.js');
    await atomicWriteJson(join(dir, 'manifest.json'), { version: 999 });
    const r = await restore(h.deps, { name: 'l1-20200101T000000Z-badver', dryRun: false });
    expect(r.notice).toContain('找不到快照');
    expect(await list(h.deps)).toMatchObject({ total: 0 });
    h.db.close();
  });

  it('回灌走 memoryMutate 门;列表**不**走(看得见才知道要不要恢复)', async () => {
    const h = await setup('gate');
    const purge = await h.store.purgeRetired(['r1'], 'cleanup-retired');
    const off = h.depsWith(false);
    await expect(restore(off, { name: purge.name })).rejects.toThrow(/高权限/);
    await expect(restore(off, { name: purge.name, dryRun: false })).rejects.toThrow(/高权限/);
    expect((await list(off)).total).toBe(1);
    h.db.close();
  });
});

describe('结构性守卫:原语必须有生产调用方', () => {
  it('`restoreL1Snapshot` 不再只被测试调用,且两个端点都在分发器里', async () => {
    // 这条守卫是本次修复的**验收判据本身**:此前该函数在整个 src/ 里零调用,
    // 于是"导出物可恢复"只是句注释。谁把接线删掉,这条立刻变红。
    const l1 = await readFile(new URL('../src/store/l1.ts', import.meta.url), 'utf8');
    expect(l1).toMatch(/restoreL1Snapshot\(/);
    const stats = await readFile(new URL('../src/stats.ts', import.meta.url), 'utf8');
    expect(stats).toContain("case 'dsh-memory/snapshots-list'");
    expect(stats).toContain("case 'dsh-memory/snapshot-restore'");
    // 白名单与 case 表逐项一致由 contract-keys.test.ts 守;这里只确认清单里有它
    const { MEMORY_ENDPOINTS } = await import('../src/stats.js');
    expect(MEMORY_ENDPOINTS).toContain('dsh-memory/snapshot-restore');
    expect(MEMORY_ENDPOINTS).toContain('dsh-memory/snapshots-list');
  });
});
