/**
 * Room merge/rename 游标重写单测(分类管理 beta.5,破坏性面)。
 * 钉死:①dryRun 零写入;②实跑重写 tags 且**其余 metadata 键保全**(roomCandidates/
 * roomReview/hall/sourceAnchors);③含已退场行(口径与计数一致);④cap 续跑;
 * ⑤执行前备份文件落盘;⑥registry markMerged/renameSlug 语义;⑦单飞。
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import { NoopEmbeddingService } from '../src/store/embedding.js';
import { RoomRegistryStore } from '../src/store/rooms-registry.js';
import { mergeRoom, renameRoom } from '../src/room-review.js';
import type { MemoryLogger, MemoryRecord } from '../src/types.js';
import type { MemoryConfig } from '../src/config.js';

let dir: string;
const dbs: MemoryDb[] = [];
afterAll(async () => {
  for (const db of dbs) db.close();
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

const logger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

async function mkL1(): Promise<{ l1: L1Store; registry: RoomRegistryStore; db: MemoryDb; root: string }> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-roommerge-'));
  const root = join(dir, `rt-${Math.random().toString(36).slice(2)}`);
  await mkdir(root, { recursive: true });
  const db = new MemoryDb(join(root, 'm.db'), 0);
  db.init();
  dbs.push(db);
  const registry = new RoomRegistryStore(root);
  await registry.init();
  await registry.register({ slug: 'beta' }); // 目标 Room 预注册(markMerged 收 aliases 用)
  return { l1: new L1Store(root, db, new NoopEmbeddingService()), registry, db, root };
}

const now = Date.now();
async function seed(l1: L1Store, id: string, tags: string[], over: Partial<MemoryRecord> = {}): Promise<void> {
  l1.upsert({
    id,
    content: `内容 ${id}`,
    type: 'work_fact',
    priority: 60,
    scene_name: `scene-${id.slice(-1)}`,
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 0,
    metadata: { tags: [...tags] },
    family: 'work',
    scope: 'global',
    workspaceId: '',
    ...over,
  });
}

describe('mergeRoom', () => {
  it('dryRun:返回 affected+预览,零写入', async () => {
    const { l1, registry } = await mkL1();
    await seed(l1, 'a1', ['alpha']);
    const r = await mergeRoom({ l1, registry, logger }, 'alpha', 'beta', { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.affected).toBe(1);
    expect(r.applied).toBe(0);
    expect(l1.getByIds(['a1'])[0].metadata?.tags).toEqual(['alpha']);
    expect(registry.bySlug('beta')).toBeDefined(); // 目标已预注册,不影响
  });

  it('实跑:重写 tags,其余 metadata 键保全,含已退场行,备份落盘', async () => {
    const { l1, registry, root } = await mkL1();
    await seed(l1, 'live1', ['alpha'], { metadata: { tags: ['alpha'], roomCandidates: ['x'], roomReview: 'pending', hall: 'work' } });
    await seed(l1, 'mixed', ['alpha', 'keep'], { metadata: { tags: ['alpha', 'keep'], cogHall: 'work' } });
    await seed(l1, 'retired1', ['alpha'], { validTo: now + 1000 });
    const spy = vi.spyOn(l1, 'invalidateRooms');
    const r = await mergeRoom({ l1, registry, logger }, 'alpha', 'beta', { dryRun: false });
    expect(r.applied).toBe(3); // 含退场行
    expect(r.families).toEqual(['work']);
    expect((r.scenes ?? []).length).toBeGreaterThan(0);
    expect(r.backupFile).toBeTruthy();
    expect(await readFile(r.backupFile!, 'utf8')).toContain('alpha');
    expect(spy).toHaveBeenCalled();
    // tags 重写 + 其余键保全
    const l = l1.getByIds(['live1'])[0];
    expect(l.metadata?.tags).toEqual(['beta']);
    expect(l.metadata?.roomCandidates).toEqual(['x']);
    expect(l.metadata?.hall).toBe('work');
    const m = l1.getByIds(['mixed'])[0];
    expect(m.metadata?.tags).toEqual(['beta', 'keep']); // 非 from 的 tag 保留
    expect(m.metadata?.cogHall).toBe('work');
    const rt = l1.getByIds(['retired1'])[0];
    expect(rt.metadata?.tags).toEqual(['beta']); // 退场行也重写(口径一致)
  });

  it('cap 续跑:单次上限内重写,hasMore 指示剩余', async () => {
    const { l1, registry } = await mkL1();
    for (let i = 0; i < 5; i++) await seed(l1, `c${i}`, ['old']);
    // 编排层循环到收敛(cap 只控单轮批量):一次调用即全部重写
    const r1 = await mergeRoom({ l1, registry, logger }, 'old', 'new', { dryRun: false, cap: 3 });
    expect(r1.applied).toBe(5);
    expect(r1.hasMore).toBe(false);
    // L1Store.rewriteTag 单轮语义:cap=3 → 只重写 3 条,hasMore 指示剩余
    for (let i = 0; i < 5; i++) await seed(l1, `d${i}`, ['old2']);
    const single = l1.rewriteTag('old2', 'new2', 3);
    expect(single.rewritten).toBe(3);
    expect(single.hasMore).toBe(true);
    expect(l1.getByIds(['c0'])[0].metadata?.tags).toEqual(['new']);
  });

  it('from === to 拒绝', async () => {
    const { l1, registry } = await mkL1();
    await expect(mergeRoom({ l1, registry, logger }, 'same', 'same')).rejects.toThrow('from 与 to 相同');
  });
});

describe('renameRoom', () => {
  it('rename = merge 1:1 + 注册表改名(aliases 收旧名)', async () => {
    const { l1, registry } = await mkL1();
    await registry.register({ slug: 'old' });
    await seed(l1, 'a', ['old']);
    const r = await renameRoom({ l1, registry, logger }, 'old', 'renamed', { dryRun: false });
    expect(r.applied).toBe(1);
    expect(registry.bySlug('renamed')!.aliases).toContain('old');
  });

  it('目标已注册 → renameSlug 抛错,但记录重写已完成(仅注册表改名失败)', async () => {
    const { l1, registry } = await mkL1();
    await registry.register({ slug: 'target' });
    await registry.register({ slug: 'old2' });
    await seed(l1, 'a', ['old2']);
    await expect(renameRoom({ l1, registry, logger }, 'old2', 'target', { dryRun: false })).rejects.toThrow(/已存在/);
    expect(l1.getByIds(['a'])[0].metadata?.tags).toEqual(['target']); // 记录重写已完成
  });
});
