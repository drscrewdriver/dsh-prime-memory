/**
 * T0.10 判据:快照哈希投影冻结——ext_* 三表与任何新增列**不得进入**哈希输入。
 *
 * 机理(见 l1-snapshot.ts `projectConflictsForHash` 的冻结先例):manifest 的
 * `sections.*.hash` 是投影哈希,投影一扩,升级前写下的旧快照**永久失配**,
 * `exportThenPurge` 每次都会中止在"内容与快照不一致"。影子账写多频繁都不该
 * 惊动快照面——它是派生态,删了最坏重对一遍账。
 *
 * 两道钉法(照 `GOLDEN_CONFLICTS_HASH` 的先例,正反都验):
 * ① 行为面:同一库在灌入 ext 三表行前后,三段 section 哈希逐一相等;
 * ② 源码面:哈希输入构造(l1-snapshot.ts)对 `ext_`/`extSync` 零引用,
 *    sections 键集恒为 records/receipts/conflicts——有人扩节即红。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import { createL1Snapshot } from '../src/store/l1-snapshot.js';
import type { MemoryRecord } from '../src/types.js';

function row(id: string): MemoryRecord {
  const t = 1_700_000_000_000;
  return { id, content: `事实 ${id}`, type: 'work_fact', priority: 60, scene_name: 's', timestamps: [t], createdAt: t, updatedAt: t };
}

describe('snapshot hash frozen(T0.10)', () => {
  it('灌入 ext 三表行前后,manifest 三段哈希逐一相等;sections 键集冻结', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-snapfreeze-'));
    const db = new MemoryDb(join(dataDir, 'm.db'), 0);
    db.init();
    const store = new L1Store(dataDir, db, undefined, 'keyword', undefined, 0);
    await store.init();
    await store.appendNew([row('a'), row('b')]);

    const now = new Date();
    const before = await createL1Snapshot(db, join(dataDir, 'snap-1'), 't010-before', now);

    // 影子账三表各灌一行(驱动镜像/映射/出站队列)——外加一条退场,扰动所有候选输入面
    db.extSync.upsertDriver({ driverId: 'mem0-x', typeId: 'mem0', enabled: true, secretRefs: 'apiKey' });
    db.extSync.upsertShadow({ shadowId: 'sh1', driverId: 'mem0-x', spaceId: 'u1', recordId: 'a', extKey: 'EK', externalId: 'e1', syncState: 'local_dirty' });
    db.extSync.enqueueOutbox({ jobId: 'j1', driverId: 'mem0-x', spaceId: 'u1', recordId: 'a', intent: 'add', payloadDigest: 'd' });

    const after = await createL1Snapshot(db, join(dataDir, 'snap-2'), 't010-after', now);

    expect(Object.keys(after.manifest.sections).sort()).toEqual(['conflicts', 'receipts', 'records']);
    for (const key of ['records', 'receipts', 'conflicts'] as const) {
      expect(after.manifest.sections[key].hash, key).toBe(before.manifest.sections[key].hash);
      expect(after.manifest.sections[key].count, key).toBe(before.manifest.sections[key].count);
    }
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('源码守卫:哈希输入构造对 ext_* 零引用(扩节/接线即红)', () => {
    const src = readFileSync(new URL('../src/store/l1-snapshot.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/ext_(drivers|shadow|outbox)/);
    expect(src).not.toMatch(/extSync/);
  });
});
