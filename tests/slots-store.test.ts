/**
 * SlotStore 单元测试(task_13):CRUD / 上限 / 预算截断 / 机械过期 / rev 单调 /
 * 活引用副本语义 / 宽容读盘。
 *
 * 确定性约定:过期断言一律传显式 `now`(冻结基准),不依赖真实墙钟。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SlotStore } from '../src/store/slots.js';
import type { MemoryLogger } from '../src/types.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-slots-store-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as MemoryLogger;

/** 同构构造器(避开默认参数,便于各用例独立 dataDir)。 */
function openStore(file: string, opts: { maxSlots?: number; maxBodyChars?: number } = {}): SlotStore {
  return new SlotStore(file, noopLogger, {
    maxSlots: opts.maxSlots ?? 8,
    maxBodyChars: opts.maxBodyChars ?? 512,
    maxTitleChars: 60,
  });
}

async function newStore(opts: { maxSlots?: number; maxBodyChars?: number } = {}) {
  const dataDir = join(await tmp(), `case-${Math.random().toString(36).slice(2)}`);
  const file = SlotStore.pathFor(dataDir);
  const store = openStore(file, opts);
  await store.load();
  return { store, file, dataDir };
}

describe('SlotStore 持久化', () => {
  it('文件缺失时用默认空态且不抛错', async () => {
    const { store } = await newStore();
    expect(store.list()).toEqual([]);
    expect(store.open()).toEqual([]);
    expect(store.count()).toBe(0);
    expect(store.revision()).toBe(0);
  });

  it('upsert 落盘为合法 JSON(version/rev/slots)且字段补默认值', async () => {
    const { store, file } = await newStore();
    const slot = await store.upsert({ title: '  网络规则  ' });
    expect(slot.id).toMatch(/^slot_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(slot.title).toBe('网络规则'); // trim
    expect(slot.kind).toBe('rule');
    expect(slot.status).toBe('open');
    expect(slot.priority).toBe(50);
    expect(slot.body).toBe('');
    expect(slot.refs).toEqual([]);
    expect(slot.pinned).toBe(false);
    expect(slot.origin).toBe('user');
    expect(Number.isNaN(Date.parse(slot.createdAt))).toBe(false);

    const raw = JSON.parse(await readFile(file, 'utf-8')) as {
      version: number;
      rev: number;
      slots: { id: string }[];
    };
    expect(raw.version).toBe(1);
    expect(raw.rev).toBe(1);
    expect(raw.slots.map((s) => s.id)).toEqual([slot.id]);
  });

  it('跨实例读回(跨会话可见性的存储底座)', async () => {
    const { store, file, dataDir } = await newStore();
    await store.upsert({ title: 'A' });
    await store.upsert({ title: 'B' });
    const reopened = openStore(file);
    await reopened.load();
    expect(reopened.list().map((s) => s.title)).toEqual(['A', 'B']);
    expect(reopened.revision()).toBe(2); // 持久 rev 被恢复
    expect(SlotStore.pathFor(dataDir)).toBe(file);
  });

  it('原子写不留 .tmp 孤儿(F3)', async () => {
    const { store, dataDir } = await newStore();
    await store.upsert({ title: 'A' });
    await store.upsert({ title: 'B' });
    const entries = await readdir(dataDir);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(entries).toContain('slots.json');
  });

  it('损坏 JSON / 坏条目:宽容读盘,不抛错', async () => {
    const { file } = await newStore();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{ not json', 'utf-8');
    const broken = openStore(file);
    await broken.load();
    expect(broken.list()).toEqual([]);

    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        rev: 7,
        slots: [
          { id: 'slot_ok', title: '好条目', kind: 'todo', status: 'open', priority: 30, refs: ['r1', 42] },
          { title: '缺 id' },
          'not-an-object',
          { id: 'slot_badkind', title: 'X', kind: 'nonsense', status: 'nonsense', priority: 999 },
        ],
      }),
      'utf-8',
    );
    const partial = openStore(file);
    await partial.load();
    expect(partial.list().map((s) => s.id)).toEqual(['slot_ok', 'slot_badkind']);
    expect(partial.list()[0]?.refs).toEqual(['r1']); // 非字符串 refs 被丢
    expect(partial.list()[1]?.kind).toBe('rule'); // 非法 kind 回落
    expect(partial.list()[1]?.priority).toBe(100); // 越界 priority 钳制
    expect(partial.revision()).toBe(7);
  });
});

describe('SlotStore CRUD 与不变式', () => {
  it('list()/open() 返回副本:外部改动不污染内部态(I2)', async () => {
    const { store } = await newStore();
    const slot = await store.upsert({ title: 'A', refs: ['r1'] });
    const dumped = store.list();
    dumped[0]!.title = '被改坏';
    dumped[0]!.refs.push('r2');
    expect(store.list()[0]?.title).toBe('A');
    expect(store.list()[0]?.refs).toEqual(['r1']);

    await store.close(slot.id, 'done');
    expect(store.open()).toEqual([]);
    expect(store.list()[0]?.status).toBe('done');
  });

  it('超上限拒绝写入并给出明确错误,不静默丢弃(I3)', async () => {
    const { store } = await newStore({ maxSlots: 2 });
    await store.upsert({ title: 'A' });
    await store.upsert({ title: 'B' });
    await expect(store.upsert({ title: 'C' })).rejects.toThrow(/上限/);
    await expect(store.upsert({ title: 'C' })).rejects.toThrow(/memory_slot_close/);
    expect(store.list().map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('空标题拒绝写入', async () => {
    const { store } = await newStore();
    await expect(store.upsert({ title: '   ' })).rejects.toThrow(/title/);
    expect(store.count()).toBe(0);
  });

  it('close():不存在返回 false 且不 bump rev;存在则置状态并 bump', async () => {
    const { store } = await newStore();
    const slot = await store.upsert({ title: 'A' });
    const revAfterWrite = store.revision();
    expect(await store.close('slot_missing', 'done')).toBe(false);
    expect(store.revision()).toBe(revAfterWrite);
    expect(await store.close(slot.id, 'dropped')).toBe(true);
    expect(store.revision()).toBe(revAfterWrite + 1);
    expect(store.list()[0]?.status).toBe('dropped');
  });

  it('体积钳制:title/body/priority/refs/status 边界', async () => {
    const { store } = await newStore({ maxBodyChars: 32 });
    const slot = await store.upsert({
      title: 'T'.repeat(80),
      kind: 'pointer',
      body: 'B'.repeat(100),
      priority: 999,
      pinned: true,
      refs: ['ok', ...Array.from({ length: 40 }, (_, i) => `r${i}`)],
      status: 'expired',
      origin: 'agent',
    });
    expect(slot.title.length).toBe(60);
    expect(slot.body.length).toBe(32);
    expect(slot.priority).toBe(100);
    expect(slot.pinned).toBe(true);
    expect(slot.origin).toBe('agent');
    expect(slot.refs.length).toBe(32);
    expect(slot.status).toBe('open'); // 过期只由 expireDue 机械产生
  });

  it('rev 单调递增,且只读操作不改变 rev', async () => {
    const { store } = await newStore();
    expect(store.revision()).toBe(0);
    const a = await store.upsert({ title: 'A' });
    expect(store.revision()).toBe(1);
    store.list();
    store.open();
    store.count();
    store.alwaysOn(2048);
    expect(store.revision()).toBe(1);
    await store.upsert({ title: 'B' });
    expect(store.revision()).toBe(2);
    await store.close(a.id, 'done');
    expect(store.revision()).toBe(3);
    await store.expireDue(Date.now());
    expect(store.revision()).toBe(3); // 无到期条目 → 不写盘
  });
});

describe('alwaysOn 预算截断', () => {
  it('只取 pinned && open,按 priority 降序', async () => {
    const { store } = await newStore();
    await store.upsert({ title: '低', priority: 10, pinned: true, body: 'x' });
    await store.upsert({ title: '高', priority: 90, pinned: true, body: 'x' });
    await store.upsert({ title: '未 pin', priority: 99, pinned: false, body: 'x' });
    const closed = await store.upsert({ title: '已关', priority: 95, pinned: true, body: 'x' });
    await store.close(closed.id, 'done');

    const { slots, truncatedCount } = store.alwaysOn(4096);
    expect(slots.map((s) => s.title)).toEqual(['高', '低']);
    expect(truncatedCount).toBe(0);
  });

  it('超预算按 priority 截断并报 truncatedCount(I4 数据面)', async () => {
    const { store } = await newStore();
    await store.upsert({ title: '高', priority: 90, pinned: true, body: 'A'.repeat(100) });
    await store.upsert({ title: '中', priority: 50, pinned: true, body: 'B'.repeat(100) });
    await store.upsert({ title: '低', priority: 10, pinned: true, body: 'C'.repeat(100) });
    const { slots, truncatedCount } = store.alwaysOn(150);
    expect(slots.map((s) => s.title)).toEqual(['高']);
    expect(truncatedCount).toBe(2);
  });

  it('单条超预算仍保留(避免"写了却永远看不到")', async () => {
    const { store } = await newStore();
    await store.upsert({ title: '唯一', priority: 10, pinned: true, body: 'A'.repeat(500) });
    const { slots, truncatedCount } = store.alwaysOn(16);
    expect(slots.map((s) => s.title)).toEqual(['唯一']);
    expect(truncatedCount).toBe(0);
  });

  it('空槽位零注入素材', async () => {
    const { store } = await newStore();
    expect(store.alwaysOn(2048)).toEqual({ slots: [], truncatedCount: 0 });
  });

  it('返回副本:调用方 mutate 不污染 store', async () => {
    const { store } = await newStore();
    await store.upsert({ title: 'A', pinned: true, body: 'x' });
    const { slots } = store.alwaysOn(4096);
    slots[0]!.title = '改坏';
    expect(store.list()[0]?.title).toBe('A');
  });
});

describe('expireDue 机械过期', () => {
  const NOW = Date.parse('2026-09-22T00:00:00.000Z');

  it('validUntil 已过 → expired;未到/无期限不动;重复调用为 0', async () => {
    const { store } = await newStore();
    const past = await store.upsert({ title: '过期', validUntil: '2026-09-21T00:00:00.000Z' });
    const future = await store.upsert({ title: '未到', validUntil: '2026-09-23T00:00:00.000Z' });
    const forever = await store.upsert({ title: '长期', validUntil: '不是日期' });
    expect(await store.expireDue(NOW)).toBe(1);
    expect(store.list().find((s) => s.id === past.id)?.status).toBe('expired');
    expect(store.list().find((s) => s.id === future.id)?.status).toBe('open');
    expect(store.list().find((s) => s.id === forever.id)?.status).toBe('open');
    expect(await store.expireDue(NOW)).toBe(0);
  });

  it('只动 open 槽位;过期后不再进 alwaysOn', async () => {
    const { store } = await newStore();
    const done = await store.upsert({ title: '已关', pinned: true, validUntil: '2026-09-21T00:00:00.000Z' });
    await store.close(done.id, 'done');
    const expiring = await store.upsert({ title: '到期', pinned: true, validUntil: '2026-09-21T00:00:00.000Z' });
    expect(await store.expireDue(NOW)).toBe(1);
    expect(store.list().find((s) => s.id === done.id)?.status).toBe('done');
    expect(store.list().find((s) => s.id === expiring.id)?.status).toBe('expired');
    expect(store.alwaysOn(4096).slots).toEqual([]);
  });

  it('过期结果落盘(重启后仍是 expired)', async () => {
    const { store, file } = await newStore();
    await store.upsert({ title: '到期', validUntil: '2026-09-21T00:00:00.000Z' });
    await store.expireDue(NOW);
    const reopened = openStore(file);
    await reopened.load();
    expect(reopened.list()[0]?.status).toBe('expired');
  });
});
