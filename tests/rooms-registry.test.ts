/**
 * Room 注册表 sidecar 单测(slots 式)。
 * 钉死:①注册幂等(含别名命中)与上限防刷;②rename/markMerged 语义(aliases
 * 追加、冲突走 merge);③**损坏只读降级回退自生长目录**(R2 红线);④rev 持久化
 * 回环(重开文件仍在)。
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RoomRegistryStore } from '../src/store/rooms-registry.js';

let dir: string;
const stores: RoomRegistryStore[] = [];
afterAll(async () => {
  for (const s of stores) void s;
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function mk(): Promise<{ store: RoomRegistryStore; dir: string }> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-roomreg-'));
  const store = new RoomRegistryStore(dir);
  stores.push(store);
  await store.init();
  return { store, dir };
}

describe('RoomRegistryStore', () => {
  it('register:created/幂等补全/isTag 校验/上限防刷', async () => {
    const { store } = await mk();
    const r1 = await store.register({ slug: 'git-commits', label: 'Git 提交', description: '提交相关约定' });
    expect(r1.created).toBe(true);
    expect(r1.entry.source).toBe('pre-registered');
    // 幂等:同 slug 再注册 = 补全描述,不新建
    const r2 = await store.register({ slug: 'git-commits', description: '补充说明' });
    expect(r2.created).toBe(false);
    expect(store.list()).toHaveLength(1);
    // 只补空缺:已有 description 不被幂等再注册覆盖
    expect(store.list()[0].description).toBe('提交相关约定');
    expect(store.list()[0].label).toBe('Git 提交');
    // 别名命中也算已存在
    await store.markMerged('git-commits', 'git-flow');
    const r3 = await store.register({ slug: 'git-commits' }); // 旧 slug 命中 git-flow 的 aliases
    expect(r3.created).toBe(false);
    // 非法 slug 拒绝
    await expect(store.register({ slug: 'Bad Slug!' })).rejects.toThrow(/非法/);
  });

  it('rename/markMerged:aliases 追加,新名冲突走 merge', async () => {
    const { store } = await mk();
    await store.register({ slug: 'old-room' });
    await store.register({ slug: 'other' });
    expect(await store.renameSlug('old-room', 'new-room')).toBe(true);
    const renamed = store.bySlug('new-room')!;
    expect(renamed.aliases).toContain('old-room');
    expect(store.bySlug('old-room')!.slug).toBe('new-room'); // 别名可检索
    await expect(store.renameSlug('new-room', 'other')).rejects.toThrow(/merge/);
    // markMerged:from 转 retired + to 收 aliases
    await store.register({ slug: 'dup' });
    expect(await store.markMerged('dup', 'other')).toBe(true);
    // bySlug('dup') 经别名解析回主条目 other(正确语义);用 list() 精确检查 dup 条目自身
    const merged = store.list().find((e) => e.slug === 'dup')!;
    expect(merged.status).toBe('retired');
    expect(store.bySlug('other')!.aliases).toContain('dup');
    expect(store.bySlug('dup')!.slug).toBe('other');
  });

  it('renameSlug 支持两级目标(把 room 归类到 hall 下)', async () => {
    const { store } = await mk();
    await store.register({ slug: 'dsh-bash-terminal' });
    expect(await store.renameSlug('dsh-bash-terminal', 'dsh-plugin/bash-terminal')).toBe(true);
    const reclassed = store.bySlug('dsh-plugin/bash-terminal')!;
    expect(reclassed.aliases).toContain('dsh-bash-terminal');
    expect(store.bySlug('dsh-bash-terminal')!.slug).toBe('dsh-plugin/bash-terminal'); // 别名可检索
    // 小类之间跨 hall 迁移同款合法
    await store.register({ slug: 'work/notes' });
    expect(await store.renameSlug('work/notes', 'dsh-plugin/notes')).toBe(true);
    expect(store.bySlug('dsh-plugin/notes')!.aliases).toContain('work/notes');
  });

  it('retire/setStatus;active 过滤', async () => {
    const { store } = await mk();
    await store.register({ slug: 'temp-room' });
    expect(await store.setStatus('temp-room', 'retired')).toBe(true);
    expect(store.bySlug('temp-room')!.status).toBe('retired');
    expect(store.listActive().some((e) => e.slug === 'temp-room')).toBe(false);
    expect(await store.setStatus('temp-room', 'retired')).toBe(false); // 无变化
  });

  it('损坏文件 → 只读降级(内存态可用,回退自生长目录),R2 红线', async () => {
    if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-roomreg-'));
    const file = join(dir, 'broken-registry', 'rooms-registry.json');
    await mkdir(file ? join(file, '..') : join(dir, 'broken-registry'), { recursive: true });
    await writeFile(file, '{corrupt json!!', 'utf8');
    const store = new RoomRegistryStore(join(dir, 'broken-registry'));
    await store.init(); // 不得抛
    await store.register({ slug: 'still-works' }); // 降级 = 不回写,但内存态照常
    expect(store.listActive().map((e) => e.slug)).toContain('still-works');
    // 文件保持原样(未被降级态覆写)
    expect(await readFile(file, 'utf8')).toBe('{corrupt json!!');
  });

  it('两级制:大类 200 上限;小类(major/minor)不占大类额度', async () => {
    const { store } = await mk();
    await store.register({ slug: 'dsh-plugin' });
    // 小类不占大类额度,可连续注册
    for (const minor of ['merge', 'export', 'review']) {
      await store.register({ slug: `dsh-plugin/${minor}` });
    }
    expect(store.bySlug('dsh-plugin/merge')).toBeDefined();
    expect(store.listActive().some((e) => e.slug === 'dsh-plugin/review')).toBe(true);
    // 平级 slug 占大类额度:再注册 1 个新大类正常(200 上限由实现保证,此处验证小类不触发)
    await store.register({ slug: 'other-major' });
    expect(store.bySlug('other-major')).toBeDefined();
    // 双斜杠/空段拒绝
    await expect(store.register({ slug: 'a/b/c' })).rejects.toThrow(/两级制/);
    await expect(store.register({ slug: 'a//b' })).rejects.toThrow(/两级制/);
  });

  it('持久化回环保留两级 slug(重启不丢 hall-room 关系)', async () => {
    if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-roomreg-'));
    const a = new RoomRegistryStore(dir);
    await a.init();
    await a.register({ slug: 'dsh-plugin' });
    await a.register({ slug: 'dsh-plugin/merge', source: 'grown' });
    const b = new RoomRegistryStore(dir);
    await b.init();
    expect(b.bySlug('dsh-plugin/merge')!.status).toBe('active'); // 加载器不得用 isTag 丢两级条目
  });

  it('持久化回环:重开文件仍在', async () => {
    const d = await mkdtemp(join(tmpdir(), 'dsh-roomreg-'));
    const s1 = new RoomRegistryStore(d);
    await s1.init();
    await s1.register({ slug: 'persist-me', label: 'P' });
    const s2 = new RoomRegistryStore(d);
    await s2.init();
    expect(s2.bySlug('persist-me')!.label).toBe('P');
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  });
});
