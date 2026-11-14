/**
 * T0.3 判据:影子表三件套——建表失败不传染主库、未就绪全量 no-op、
 * outbox 的 pending 唯一索引让重复点火结构性合并。
 *
 * T0.12 的结构性半边也钉在这里:`src/ext-memory/**` 的 import 白名单 =
 * node 内建 + 本仓相对路径,**不新增任何 npm 依赖**——9 家驱动必须是手写
 * 胶水(否则把 9 个发布节奏绑进主包,且供应商 SDK 会击穿 22 版本 peer 枚举)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { ExtSyncStore } from '../src/ext-memory/schema.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function freshDb(): Promise<MemoryDb> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-extschema-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'e.db'), 8);
  db.init();
  return db;
}

describe('ext-memory schema(T0.3)', () => {
  it('随主库 init 建表;同路径重开(幂等 DDL)不抛', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-extschema-'));
    dirs.push(dataDir);
    const dbPath = join(dataDir, 'e.db');
    const db1 = new MemoryDb(dbPath, 8);
    db1.init();
    expect(db1.extSync.ready).toBe(true);
    db1.close();
    const db2 = new MemoryDb(dbPath, 8);
    db2.init(); // CREATE IF NOT EXISTS 重跑零异常,存量表不重建
    expect(db2.extSync.ready).toBe(true);
    db2.close();
  });

  it('未就绪 store:全部方法安全 no-op,不抛(建表失败 = 外部同步停用,主链无感)', () => {
    const s = new ExtSyncStore();
    expect(s.ready).toBe(false);
    s.upsertDriver({ driverId: 'a', typeId: 'mem0', enabled: true });
    s.recordProbe('a', true);
    expect(s.listDrivers()).toEqual([]);
    s.upsertShadow({ shadowId: 's1', driverId: 'a', spaceId: 'sp', recordId: 'r1' });
    expect(s.getShadowByRecord('a', 'sp', 'r1')).toBeUndefined();
    expect(s.getShadowByExternal('a', 'sp', 'x')).toBeUndefined();
    expect(s.findShadowsByExtKey('a', 'k')).toEqual([]);
    expect(s.repointShadowRecord('a', 'sp', 'x', 'y')).toBe(false);
    expect(s.listShadowsByState('clean')).toEqual([]);
    expect(s.enqueueOutbox({ jobId: 'j', driverId: 'a', spaceId: 'sp', recordId: 'r', intent: 'add' })).toBe(false);
    expect(s.pickDueOutbox(Date.now(), 10)).toEqual([]);
    s.setOutboxStatus('j', 'done');
    s.bumpOutboxAttempt('j', 0, 'e');
    expect(s.countOutbox()).toEqual({ pending: 0, dead: 0 });
    expect(s.outboxPendingByDriver('a')).toBe(0);
    const counts = s.countShadows();
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('outbox:同 (driver,space,record,intent) 的在途点火被唯一索引合并;了结后可再入队', async () => {
    const db = await freshDb();
    const s = db.extSync;
    const base = { driverId: 'mem0-a', spaceId: 'u1', recordId: 'r1', intent: 'add' as const };
    expect(s.enqueueOutbox({ jobId: 'j1', ...base, payloadDigest: 'd1' })).toBe(true);
    expect(s.enqueueOutbox({ jobId: 'j2', ...base, payloadDigest: 'd2' })).toBe(false);
    expect(s.outboxPendingByDriver('mem0-a')).toBe(1);
    s.setOutboxStatus('j1', 'done');
    // 了结(done/dead 不在部分唯一索引的 WHERE 里)→ 同一记录的新变更可再次入队
    expect(s.enqueueOutbox({ jobId: 'j3', ...base, payloadDigest: 'd3' })).toBe(true);
    // pickDue 按到票时间;next_attempt_at 未来值不得被拾取
    s.bumpOutboxAttempt('j3', Date.now() + 60_000, 'net down');
    const due = s.pickDueOutbox(Date.now(), 50).filter((r) => r.jobId === 'j3');
    expect(due).toEqual([]);
    db.close();
  });

  it('shadow:同一 external_id 只能有一条在账影子;merge 换 id 用 repoint 移动而非新插', async () => {
    const db = await freshDb();
    const s = db.extSync;
    s.upsertShadow({ shadowId: 'sh1', driverId: 'm', spaceId: 'sp', recordId: 'old-id', extKey: 'EK1', externalId: 'ext-9', syncState: 'clean' });
    expect(s.findShadowsByExtKey('m', 'EK1').map((r) => r.recordId)).toEqual(['old-id']);
    // 同一外部条目再插新行会被 (driver,space,external_id) 唯一索引拒(静默 no-op,
    // 账本不裂变)——重挂必须走 repoint 的**移动**语义。
    s.upsertShadow({ shadowId: 'sh2', driverId: 'm', spaceId: 'sp', recordId: 'new-id', extKey: 'EK1', externalId: 'ext-9', syncState: 'clean' });
    expect(s.findShadowsByExtKey('m', 'EK1').map((r) => r.recordId).sort()).toEqual(['old-id']);
    expect(s.getShadowByRecord('m', 'sp', 'new-id')).toBeUndefined();
    // merge 汇流:retire(old)+appendNew(new) 后影子改指新 id,external 绑定与 ext_key 不变
    expect(s.repointShadowRecord('m', 'sp', 'old-id', 'new-id')).toBe(true);
    const moved = s.getShadowByExternal('m', 'sp', 'ext-9');
    expect(moved?.recordId).toBe('new-id');
    expect(moved?.extKey).toBe('EK1');
    expect(s.getShadowByRecord('m', 'sp', 'old-id')).toBeUndefined();
    db.close();
  });

  it('T0.12 结构守卫:src/ext-memory/** 的 import 只允许 node 内建与仓内相对路径', () => {
    const dir = new URL('../src/ext-memory/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec of specs) {
        expect(spec, `${f} → ${spec}`).toMatch(/^(node:|\.)/);
      }
    }
  });
});
