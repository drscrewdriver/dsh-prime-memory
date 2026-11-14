/**
 * holographic 本地写路径(T3.2 hard 五家之一;文件库无 HTTP):
 * remember 建 fact + 内容去重 skipped + forget 摘除 + list 枚举 + 原子落盘。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_DRIVER_FACTORIES } from '../src/ext-memory/drivers/local-drivers.js';
import type { ExtSpace } from '../src/ext-memory/types.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    for (let i = 0; i < 5; i++) {
      try {
        await rm(d, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
});

async function mk(): Promise<{ store: string; space: ExtSpace }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-holo-'));
  dirs.push(dir);
  const store = join(dir, 'store.json');
  return { store, space: { spaceId: `h1:${store}`, driverId: 'h1', externalId: store, name: 's', description: '' } };
}

describe('holographic 写路径(T3.2)', () => {
  it('remember 建 fact;同内容 skipped 带 id;forget 摘除;list 枚举;盘上为合法 JSON', async () => {
    const { store, space } = await mk();
    const d = LOCAL_DRIVER_FACTORIES.holographic({ id: 'h1', connection: { space: store }, requestTimeoutMs: 5000 });
    const r1 = await d.remember(space, { content: '甲事实', category: 'decision', tags: ['x'] });
    expect(r1.completion).toBe('committed');
    expect(r1.externalId).toBeTruthy();
    const r2 = await d.remember(space, { content: '甲事实' });
    expect(r2).toEqual({ completion: 'skipped', externalId: r1.externalId });
    let page = await d.list(space, { limit: 10 });
    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]).toMatchObject({ externalId: r1.externalId, content: '甲事实', category: 'decision' });
    expect(page.hits[0]!.tags).toEqual(['x']);
    // 本地文件就是全部：单条、limit=10 → 已到底
    expect(page.hasMore).toBe(false);
    const onDisk = JSON.parse(await readFile(store, 'utf8')) as { facts: unknown[] };
    expect(onDisk.facts).toHaveLength(1);
    await d.forget(space, r1.externalId!);
    page = await d.list(space, { limit: 10 });
    expect(page.hits).toHaveLength(0);
    // forget 未知 id 幂等(目标态已达,不报错)
    await expect(d.forget(space, 'nope')).resolves.toMatchObject({ completion: 'committed' });
  });

  it('保留 store.json 其它根字段(只改 facts 不吞别人的键)', async () => {
    const { store, space } = await mk();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(store, JSON.stringify({ version: 3, meta: { owner: 'x' }, facts: [] }), 'utf8');
    const d = LOCAL_DRIVER_FACTORIES.holographic({ id: 'h1', connection: { space: store }, requestTimeoutMs: 5000 });
    await d.remember(space, { content: '乙事实' });
    const root = JSON.parse(await readFile(store, 'utf8')) as Record<string, unknown>;
    expect(root.version).toBe(3);
    expect((root.meta as { owner: string }).owner).toBe('x');
    expect((root.facts as unknown[]).length).toBe(1);
  });
});
