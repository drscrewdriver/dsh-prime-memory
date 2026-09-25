/**
 * Room 层(标签自生长分类)单测。
 *
 * Room = `metadata.tags` 派生,1 个 slug tag = 1 个 Room;零 schema、零注册表。
 * 本套件钉死聚合口径与边界(空 metadata / 多 tag / 非法 tag / 计数降序)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import { NoopEmbeddingService } from '../src/store/embedding.js';
import { isTag, normTags } from '../src/metadata-validators.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-room-'));
  return dir;
}
const dbs: MemoryDb[] = [];
afterAll(async () => {
  for (const db of dbs) db.close();
  if (!dir) return;
  for (let i = 0; i < 3; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

async function mkL1(): Promise<{ l1: L1Store; db: MemoryDb }> {
  const root = await tmp();
  const db = new MemoryDb(join(root, `m-${Math.random().toString(36).slice(2)}.db`), 0);
  db.init();
  dbs.push(db);
  return { l1: new L1Store(root, db, new NoopEmbeddingService()), db };
}

const now = Date.now();
const base = { priority: 60, scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now };

describe('l1RoomCounts(Room 分类聚合)', () => {
  it('同 tag 多条记录 → 计数正确并按数降序', async () => {
    const { l1 } = await mkL1();
    await l1.appendNew([
      { id: 'a1', content: 'x', type: 'work_fact', ...base, metadata: { tags: ['git-commits'] } },
      { id: 'a2', content: 'x', type: 'work_fact', ...base, metadata: { tags: ['git-commits'] } },
      { id: 'a3', content: 'x', type: 'work_fact', ...base, metadata: { tags: ['wcag'] } },
    ]);
    const rooms = l1.listRooms();
    expect(rooms[0]).toEqual({ room: 'git-commits', count: 2 });
    expect(rooms.find((r) => r.room === 'wcag')).toEqual({ room: 'wcag', count: 1 });
  });

  it('一条记录多 tag → 每个 tag 各计一次', async () => {
    const { l1 } = await mkL1();
    await l1.appendNew([
      { id: 'b1', content: 'x', type: 'work_fact', ...base, metadata: { tags: ['alpha', 'beta'] } },
    ]);
    const rooms = l1.listRooms();
    expect(rooms).toHaveLength(2);
    expect(rooms.map((r) => r.room).sort()).toEqual(['alpha', 'beta']);
  });

  it('无 tags / 空 metadata 的记录不计入,且不抛异常', async () => {
    const { l1 } = await mkL1();
    await l1.appendNew([
      { id: 'c1', content: 'x', type: 'work_fact', ...base, metadata: {} },
      { id: 'c2', content: 'x', type: 'work_fact', ...base, metadata: { tags: [] } },
      { id: 'c3', content: 'x', type: 'work_fact', ...base, metadata: { hall: 'work' } },
    ]);
    expect(l1.listRooms()).toEqual([]);
    expect(l1.listRooms()).toHaveLength(0); // 缓存命中也不报错
  });

  it('空库 → 空列表(端点在"暂无 tags"时必须返回 [] 而非报错)', async () => {
    const { l1 } = await mkL1();
    expect(l1.listRooms()).toEqual([]);
  });

  it('非法 tag 在写回点已被归一,不会进库', () => {
    // normTags 是唯一写回入口:大写转小写、下划线/前导连字符被剔除
    expect(normTags(['-bad', 'x_9', 'UPPER', 'ok-tag'])).toEqual(['upper', 'ok-tag']);
    expect(isTag('-bad')).toBe(false);
    expect(isTag('x_9')).toBe(false);
    expect(isTag('ok-tag')).toBe(true);
  });

  it('缓存:invalidateRooms 后重算(新 tag 立即成为新 Room)', async () => {
    const { l1 } = await mkL1();
    await l1.appendNew([
      { id: 'd1', content: 'x', type: 'work_fact', ...base, metadata: { tags: ['one'] } },
    ]);
    expect(l1.listRooms()).toHaveLength(1);
    await l1.appendNew([
      { id: 'd2', content: 'x', type: 'work_fact', ...base, metadata: { tags: ['two'] } },
    ]);
    expect(l1.listRooms()).toHaveLength(1); // 仍在 TTL 内 → 命中缓存
    l1.invalidateRooms();
    expect(l1.listRooms()).toHaveLength(2); // 失效后重算 → 自生长生效
  });
});
