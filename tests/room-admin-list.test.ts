/**
 * memory_room_admin(action=list) 的计数与退役口径。
 *
 * 两条判据来自一次真机验证（用户在 desktop 上 register→list→retire）：
 *  1. #27 本体：注册条目必须显示**真实计数**，而不是历史上写死的 0；
 *  2. 退役口径：词表面（`room-review.ts`）用 `listActive()`，故已退役条目不得再
 *     把同名自生长 Room 从「自生长未注册」清单里排除掉。原先本行用全量 `list()`
 *     排除，导致退役后的 slug 两侧都不出现——带记录时那些记录在词表上彻底隐形。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { registerMemoryTools } from '../src/tools/index.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import { SessionModeStore } from '../src/store/session-modes.js';
import type { MemoryLiveSettings } from '../src/settings.js';
import type { MemoryConfig } from '../src/config.js';
import type { MemoryLogger } from '../src/types.js';

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };
const openDirs: string[] = [];

afterAll(async () => {
  for (const dir of openDirs) {
    // Windows Defender 会短暂锁住刚写完的 memory.db，rm 重试兜底
    for (let i = 0; i < 5; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
});

interface Entry {
  slug: string;
  label?: string;
  description?: string;
  source: string;
  status: 'active' | 'retired';
}

function harness(entries: Entry[]) {
  const live = { memoryMutate: true } as MemoryLiveSettings;
  const modes = new SessionModeStore('/nonexistent', 'auto');
  const registered: Array<{ name: string; execute: (a: Record<string, unknown>) => Promise<unknown> }> = [];
  const ctx = {
    tools: { register: (t: { name: string; execute: (a: Record<string, unknown>) => Promise<unknown> }) => { registered.push(t); return () => {}; } },
  } as unknown as Parameters<typeof registerMemoryTools>[0];
  const cfg = { tools: true, recall: { maxResults: 5 }, skills: { enabled: false } } as unknown as MemoryConfig;
  const roomRegistry = {
    list: () => entries,
    listActive: () => entries.filter((e) => e.status === 'active'),
    bySlug: (slug: string) => entries.find((e) => e.slug === slug),
    setStatus: async (slug: string, status: 'active' | 'retired') => {
      const e = entries.find((x) => x.slug === slug);
      if (!e) return false;
      e.status = status;
      return true;
    },
    register: async () => ({ created: true, entry: entries[0] }),
    update: async () => true,
  } as unknown as Parameters<typeof registerMemoryTools>[7];
  return { ctx, cfg, modes, liveHandle: { supported: true, get: () => live, update: async () => {} }, registered, roomRegistry };
}

async function setupStores(tagsByRecord: Record<string, string[]>) {
  const dataDir = join(await mkdtemp(join(tmpdir(), 'room-admin-')), `t-${Date.now()}`);
  openDirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
  db.init();
  const l1 = new L1Store(dataDir, db, undefined, 'hybrid', noopLogger, 0);
  await l1.init();
  const now = Date.now();
  await l1.appendNew(
    Object.entries(tagsByRecord).map(([id, rooms]) => ({
      id,
      content: `记录 ${id} 用于 Room 计数与退役口径验证`,
      type: 'work_fact',
      priority: 50,
      scene_name: '基建',
      metadata: { tags: rooms }, // listRooms() 展开的是 metadata.tags
      timestamps: [now],
      createdAt: now,
      updatedAt: now,
    })),
  );
  return { db, l1 };
}

async function listNotice(stores: Awaited<ReturnType<typeof setupStores>>, entries: Entry[]) {
  const h = harness(entries);
  registerMemoryTools(h.ctx, h.cfg, { l1: stores.l1 }, noopLogger, h.modes, h.liveHandle, undefined, h.roomRegistry);
  const tool = h.registered.find((t) => t.name === 'memory_room_admin')!;
  const res = (await tool.execute({ action: 'list' })) as { notice: string; rooms: string };
  return res.notice;
}

describe('memory_room_admin list：计数与退役口径', () => {
  it('#27 注册条目显示真实计数，不是写死的 0', async () => {
    const stores = await setupStores({ a: ['work/dsh-host'], b: ['work/dsh-host'], c: ['yaml-settings'] });
    const notice = await listNotice(stores, [
      { slug: 'work/dsh-host', label: 'DSH 宿主', source: 'pre-registered', status: 'active' },
    ]);
    expect(notice).toContain('现有 2 条');
    expect(notice).not.toContain('现有 0 条');
    // 已注册的 slug 不再进「自生长未注册」清单
    expect(notice).toContain('自生长未注册 1 个');
    expect(notice).toContain('yaml-settings(1)');
    stores.db.close();
  });

  it('退役条目不占额度，且其 slug 回到自生长未注册面（两侧口径必须一致）', async () => {
    const stores = await setupStores({ a: ['work/dsh-host'], b: ['work/dsh-host'], c: ['yaml-settings'] });
    const entries: Entry[] = [{ slug: 'work/dsh-host', label: 'DSH 宿主', source: 'pre-registered', status: 'active' }];

    const before = await listNotice(stores, entries);
    expect(before).toContain('注册表 1 条');
    expect(before).toContain('自生长未注册 1 个'); // 只有 yaml-settings

    // 退役：词表侧（listActive）已剔除它，故显示侧也必须把它当未注册
    await harness(entries).roomRegistry.setStatus('work/dsh-host', 'retired');
    const after = await listNotice(stores, entries);

    expect(after).toContain('注册表 0 条'); // 活跃额度不再被退役项占用
    expect(after).toContain('已退役 1 条');
    expect(after).toContain('自生长未注册 2 个'); // work/dsh-host 回来了
    expect(after).toContain('work/dsh-host(2)'); // 计数没丢，仍挂在自生长面
    expect(after).toContain('[pre-registered/retired]'); // 条目本身仍可看见，便于恢复
    stores.db.close();
  });

  it('零绑定的注册条目仍显示 0（保留 `?? 0` 原语义）', async () => {
    const stores = await setupStores({ c: ['yaml-settings'] });
    const notice = await listNotice(stores, [
      { slug: 'brand-new-room', source: 'pre-registered', status: 'active' },
    ]);
    expect(notice).toContain('现有 0 条');
    stores.db.close();
  });
});
