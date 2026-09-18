/**
 * L1 快照与恢复路径单测(task_8c-1)。
 *
 * **先反证再正向**(计划里指定的顺序):
 * 1. 构造一条导入记忆 → 跑一次**不带保护**的清空 → 断言它**真的没了**
 *    (证明风险真实存在,不是假想)
 * 2. 恢复路径能把它**原样**取回
 * 3. 带保护的流程下,快照先于清空、内容完整
 *
 * 第 1 步不能省:不先证明"确实会丢",后面所有保护都在防一个**没验证过的风险**。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import {
  createL1Snapshot,
  hashRecords,
  listAllL1,
  readSnapshotManifest,
  readSnapshotRecords,
  restoreL1Snapshot,
  snapshotBeforeClear,
  snapshotDirName,
  snapshotPathFor,
  verifySnapshot,
} from '../src/store/l1-snapshot.js';
import type { ConversationAnchor, MemoryRecord } from '../src/types.js';

const ANCHOR_METADATA_KEY = 'dsh_source_anchors';

function rec(id: string, content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = 1_700_000_000_000;
  return {
    id,
    content,
    type: 'episodic',
    priority: 50,
    scene_name: '日常',
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 0,
    metadata: {},
    sessionId: 'default',
    family: 'chat',
    ...overrides,
  };
}

/** 一条"外部导入"的记忆:没有 L0 来源,重建时会被一并清掉 —— 正是本任务要保护的。 */
function importedMemory(id: string): MemoryRecord {
  return rec(id, '这条是外部导入的记忆,没有 L0 来源。', {
    metadata: { scene_name: '外部导入/其他工具' },
  });
}

/** 一条带锚点的真实记忆:恢复后锚点必须还在(否则证据链被悄悄拆了)。 */
function anchoredMemory(id: string): MemoryRecord {
  const anchor: ConversationAnchor = { sessionId: 'session-x', turn: 7, step: 3 };
  return rec(id, '带来源锚点的记忆。', { metadata: { [ANCHOR_METADATA_KEY]: [anchor] } });
}

async function withDb<T>(name: string, fn: (db: MemoryDb, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-snap-${name}-`));
  const db = new MemoryDb(join(dir, 'memory.db'), 0);
  db.init();
  try {
    return await fn(db, dir);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('命名与路径 —— 可追溯', () => {
  it('目录名把时间戳放前面,天然按时间排序', () => {
    const name = snapshotDirName(new Date('2026-09-17T10:20:30.000Z'), 'pre-rebuild');
    expect(name.startsWith('l1-20260917T102030Z-')).toBe(true);
    expect(name.endsWith('pre-rebuild')).toBe(true);
  });

  it('原因里的非法字符被清掉,空原因有兜底', () => {
    expect(snapshotDirName(new Date('2026-09-17T10:20:30.000Z'), 'a b/c')).toContain('a-b-c');
    expect(snapshotDirName(new Date('2026-09-17T10:20:30.000Z'), '///')).toContain('snapshot');
  });

  it('路径落在 dataDir/snapshots 下,尾斜杠不产生双斜杠', () => {
    const at = new Date('2026-09-17T10:20:30.000Z');
    expect(snapshotPathFor('C:\\data\\mem', at, 'r')).toBe('C:\\data\\mem/snapshots/l1-20260917T102030Z-r');
    expect(snapshotPathFor('C:\\data\\mem\\', at, 'r')).toBe('C:\\data\\mem/snapshots/l1-20260917T102030Z-r');
  });
});

describe('内容哈希 —— 同内容恒同哈希,顺序无关', () => {
  it('记录顺序不影响哈希', () => {
    const a = rec('a', 'A');
    const b = rec('b', 'B');
    expect(hashRecords([a, b])).toBe(hashRecords([b, a]));
  });

  it('内容变了哈希就变', () => {
    expect(hashRecords([rec('a', 'A')])).not.toBe(hashRecords([rec('a', 'A!')]));
  });

  it('**只有 metadata 变**时哈希也变(锚点就在 metadata 里,漏检等于丢溯源)', () => {
    const plain = rec('a', 'A');
    const withAnchor = rec('a', 'A', { metadata: { [ANCHOR_METADATA_KEY]: [{ sessionId: 's', turn: 1 }] } });
    expect(hashRecords([plain])).not.toBe(hashRecords([withAnchor]));
  });
});

describe('反证:清空确实会吃掉无来源记忆', () => {
  it('不带保护地 clearL1() → 导入记忆真的没了(风险是真的,不是假想)', async () => {
    await withDb('proof', async (db) => {
      expect(db.upsertL1(importedMemory('imp_1'))).toBe(true);
      expect(db.countL1()).toBe(1);

      expect(db.clearL1()).toBe(true);

      // ① 这就是风险本身
      expect(db.countL1()).toBe(0);
      expect(listAllL1(db)).toEqual([]);
    });
  });
});

describe('快照 → 清空 → 恢复', () => {
  it('快照在清空前建成,清空后能把导入记忆与锚点**原样**取回', async () => {
    await withDb('roundtrip', async (db, dir) => {
      expect(db.upsertL1(importedMemory('imp_1'))).toBe(true);
      expect(db.upsertL1(anchoredMemory('anc_1'))).toBe(true);
      expect(db.upsertL1(rec('plain_1', '普通记忆'))).toBe(true);
      const before = hashRecords(listAllL1(db));

      // ② 先快照,再清空
      const snap = await snapshotBeforeClear(db, dir, 'pre-rebuild', new Date('2026-09-17T10:20:30.000Z'));
      expect(snap.manifest.sections.records.count).toBe(3);
      expect(snap.manifest.sections.records.hash).toBe(before);

      expect(db.clearL1()).toBe(true);
      expect(db.countL1()).toBe(0);

      // ③ 恢复
      const result = await restoreL1Snapshot(db, snap.dir);
      expect(result).toEqual({ restored: 3, failed: 0 });
      expect(hashRecords(listAllL1(db))).toBe(before);

      // ④ 锚点必须原样还在 —— 否则恢复出来的记忆再也无法取证
      const restored = listAllL1(db).find((r) => r.id === 'anc_1');
      expect(restored?.metadata?.[ANCHOR_METADATA_KEY]).toEqual([{ sessionId: 'session-x', turn: 7, step: 3 }]);
    });
  });

  it('恢复是幂等的:恢复两遍与一遍等价', async () => {
    await withDb('idem', async (db, dir) => {
      db.upsertL1(importedMemory('imp_1'));
      const snap = await snapshotBeforeClear(db, dir, 'pre-rebuild');
      const expected = hashRecords(listAllL1(db));
      db.clearL1();

      await restoreL1Snapshot(db, snap.dir);
      const once = hashRecords(listAllL1(db));
      await restoreL1Snapshot(db, snap.dir);
      const twice = hashRecords(listAllL1(db));

      expect(once).toBe(expected);
      expect(twice).toBe(once);
      expect(db.countL1()).toBe(1);
    });
  });

  it('清单可读回,且列出各节行数与哈希', async () => {
    await withDb('manifest', async (db, dir) => {
      db.upsertL1(rec('a', 'A'));
      const snap = await createL1Snapshot(db, join(dir, 'snap'), 'pre-rebuild', new Date('2026-09-17T00:00:00.000Z'));
      const manifest = await readSnapshotManifest(snap.dir);
      expect(manifest).toMatchObject({ version: 1, reason: 'pre-rebuild' });
      expect(manifest?.sections.records.count).toBe(1);
      expect(manifest?.sections.receipts.count).toBe(0);
      expect(manifest?.sections.conflicts.count).toBe(0);
      expect(typeof manifest?.vecCount).toBe('number');
    });
  });

  it('快照正文可独立读回(不依赖库)', async () => {
    await withDb('records', async (db, dir) => {
      db.upsertL1(rec('a', 'A'));
      const snap = await createL1Snapshot(db, join(dir, 'snap'), 'r');
      const records = await readSnapshotRecords(snap.dir);
      expect(records.map((r) => r.id)).toEqual(['a']);
    });
  });
});

describe('verifySnapshot —— 按内容比对,能查出静默改写', () => {
  it('库未变时报 ok', async () => {
    await withDb('verify-ok', async (db, dir) => {
      db.upsertL1(rec('a', 'A'));
      const snap = await createL1Snapshot(db, join(dir, 'snap'), 'r');
      await expect(verifySnapshot(db, snap.dir)).resolves.toEqual({ ok: true, diffs: [] });
    });
  });

  it('清空后报不一致,且**差异说明带行数**(不只是说"不一致")', async () => {
    await withDb('verify-diff', async (db, dir) => {
      db.upsertL1(rec('a', 'A'));
      const snap = await createL1Snapshot(db, join(dir, 'snap'), 'r');
      db.clearL1();
      const check = await verifySnapshot(db, snap.dir);
      expect(check.ok).toBe(false);
      expect(check.diffs[0]).toContain('1 条');
      expect(check.diffs[0]).toContain('0 条');
    });
  });

  it('**行数不变但内容被改**也能查出(行数断言做不到这一点)', async () => {
    await withDb('verify-silent', async (db, dir) => {
      db.upsertL1(rec('a', '原始正文'));
      const snap = await createL1Snapshot(db, join(dir, 'snap'), 'r');
      db.upsertL1(rec('a', '被静默改过的正文'));
      const check = await verifySnapshot(db, snap.dir);
      expect(check.ok).toBe(false);
      expect(db.countL1()).toBe(1); // 行数确实没变
    });
  });

  it('清单缺失时报不一致而不是抛错', async () => {
    await withDb('verify-missing', async (db, dir) => {
      const check = await verifySnapshot(db, join(dir, 'no-such-snap'));
      expect(check.ok).toBe(false);
      expect(check.diffs[0]).toContain('缺失');
    });
  });

  it('快照版本不符时拒绝采信', async () => {
    await withDb('verify-version', async (db, dir) => {
      const snapDir = join(dir, 'v9');
      const { atomicWriteJson } = await import('../src/util/io.js');
      await atomicWriteJson(`${snapDir}/manifest.json`, { version: 9, sections: {} });
      await expect(readSnapshotManifest(snapDir)).resolves.toBeUndefined();
    });
  });
});

describe('恢复的边界', () => {
  it('坏记录被计数而不是静默丢弃', async () => {
    await withDb('bad-record', async (db, dir) => {
      const snapDir = join(dir, 'bad');
      const { atomicWriteJson } = await import('../src/util/io.js');
      await atomicWriteJson(`${snapDir}/l1-records.json`, [{ id: 'ok', content: 'fine' }, { id: 42 }, { nope: true }]);
      const warn: string[] = [];
      const result = await restoreL1Snapshot(db, snapDir, { info: () => {}, warn: (m) => warn.push(m) });
      expect(result).toEqual({ restored: 1, failed: 2 });
      expect(warn.join()).toContain('2 条失败');
    });
  });

  it('空快照恢复 0 条,不报错', async () => {
    await withDb('empty', async (db, dir) => {
      const snap = await createL1Snapshot(db, join(dir, 'snap'), 'r');
      await expect(restoreL1Snapshot(db, snap.dir)).resolves.toEqual({ restored: 0, failed: 0 });
    });
  });

  it('快照目录不存在时恢复为空,不抛', async () => {
    await withDb('missing-snap', async (db, dir) => {
      await expect(restoreL1Snapshot(db, join(dir, 'nope'))).resolves.toEqual({ restored: 0, failed: 0 });
    });
  });
});
