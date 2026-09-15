/**
 * §E 存储作用域 / task_29:向后兼容是**硬要求**（ADR-0008 条 3）。
 *
 * 原文：「既有单根数据默认归 `global`，迁移不丢失、不删除。存量用户的全部记忆都已存在，
 * 任何"迁移"都必须是**标注归属**而非"搬运/重建"——把用户数据搬来搬去是拿事实源
 * 冒险去换一个配置项的美观。」
 *
 * 本文件用**真旧库**（按 0.11.0 的 DDL 手工建、手工插行、不含 scope 列）验证四件事：
 * ① 补列后**条数不变**（不丢不删）；
 * ② 每行 `scope='global'`、`workspace_id=''`（默认归属正确）；
 * ③ **不是重建**：`record_id` / `content` / `created_time` 逐字未变——若实现成
 *    "导出再导入"，这四条会变，而用户看到的只是"记忆好像还在"；
 * ④ 迁移后检索**照常命中**（FTS 索引没被迁移打坏）。
 *
 * 反面判据：④ 若被写成恒真（比如压根没查库），① 的条数断言会独立失败；
 * 而 ② 若实现成"给全部行标 workspace"，则新增库的隔离测试（`scope-isolation.test.ts`）
 * 会失败——两个文件互为约束。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';

let dir: string;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** 0.11.0 的 l1_records DDL——**逐字**取自加 scope 之前的版本（无 scope / workspace_id）。 */
const LEGACY_DDL = `
  CREATE TABLE l1_records (
    record_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    type TEXT DEFAULT '',
    priority INTEGER DEFAULT 50,
    scene_name TEXT DEFAULT '',
    session_id TEXT DEFAULT 'default',
    version INTEGER NOT NULL DEFAULT 0,
    timestamp_str TEXT DEFAULT '',
    timestamp_start TEXT DEFAULT '',
    timestamp_end TEXT DEFAULT '',
    created_time TEXT DEFAULT '',
    updated_time TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '{}',
    family TEXT NOT NULL DEFAULT 'chat'
  )
`;

/** 0.11.0 的 l1_fts——同样**无 scope / workspace_id** 两列。真实旧库两张表都在。 */
const LEGACY_FTS_DDL = `
  CREATE VIRTUAL TABLE l1_fts USING fts5(
    content, content_original UNINDEXED, record_id UNINDEXED, type UNINDEXED,
    priority UNINDEXED, scene_name UNINDEXED, session_id UNINDEXED, version UNINDEXED,
    timestamp_str UNINDEXED, timestamp_start UNINDEXED, timestamp_end UNINDEXED,
    metadata_json UNINDEXED, family UNINDEXED
  )
`;

interface LegacyRow {
  id: string;
  content: string;
  type: string;
  family: string;
  created: string;
}

const LEGACY_ROWS: LegacyRow[] = [
  { id: 'old-a', content: 'legacy alpha work fact', type: 'work_fact', family: 'work', created: '2026-01-02T03:04:05.000Z' },
  { id: 'old-b', content: 'legacy alpha work task', type: 'work_task', family: 'work', created: '2026-02-03T04:05:06.000Z' },
  { id: 'old-c', content: 'legacy alpha personal note', type: 'episodic', family: 'chat', created: '2026-03-04T05:06:07.000Z' },
];

async function makeLegacyDb(tag: string): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-scope-migrate-'));
  const file = join(dir, `${tag}.db`);
  const raw = new DatabaseSync(file, { allowExtension: false });
  try {
    raw.exec(LEGACY_DDL);
    raw.exec(LEGACY_FTS_DDL);
    const stmt = raw.prepare(
      `INSERT INTO l1_records (record_id, content, type, priority, scene_name, session_id, version,
         timestamp_str, timestamp_start, timestamp_end, created_time, updated_time, metadata_json, family)
       VALUES (?, ?, ?, 60, 'legacy', 'sess-legacy', 0, ?, '', '', ?, ?, '{}', ?)`,
    );
    const fts = raw.prepare(
      `INSERT INTO l1_fts (content, content_original, record_id, type, priority, scene_name,
         session_id, version, timestamp_str, timestamp_start, timestamp_end, metadata_json, family)
       VALUES (?, ?, ?, ?, 60, 'legacy', 'sess-legacy', 0, ?, '', '', '{}', ?)`,
    );
    for (const r of LEGACY_ROWS) {
      stmt.run(r.id, r.content, r.type, String(Date.now()), r.created, r.created, r.family);
      fts.run(r.content, r.content, r.id, r.type, String(Date.now()), r.family);
    }
  } finally {
    raw.close();
  }
  return file;
}

describe('task_29 §E 旧库迁移：标注归属，不搬运', () => {
  it('① 补列后条数不变（既有数据不丢失、不删除）', async () => {
    const file = await makeLegacyDb('count');
    const db = new MemoryDb(file, 0);
    db.init();
    try {
      expect(db.countL1()).toBe(LEGACY_ROWS.length);
    } finally {
      db.close();
    }
  });

  it('② 存量行默认归 global，且不写工作区归属', async () => {
    const file = await makeLegacyDb('default');
    const db = new MemoryDb(file, 0);
    db.init();
    db.close();

    const raw = new DatabaseSync(file, { allowExtension: false });
    try {
      const rows = raw.prepare('SELECT record_id, scope, workspace_id FROM l1_records').all() as Array<{
        record_id: string;
        scope: string;
        workspace_id: string;
      }>;
      expect(rows).toHaveLength(LEGACY_ROWS.length);
      for (const r of rows) {
        expect(r.scope).toBe('global');
        expect(r.workspace_id).toBe('');
      }
    } finally {
      raw.close();
    }
  });

  it('③ 不是重建：id / content / created_time 逐字未变（实现成导出导入就会在这里露馅）', async () => {
    const file = await makeLegacyDb('identity');
    const db = new MemoryDb(file, 0);
    db.init();
    db.close();

    const raw = new DatabaseSync(file, { allowExtension: false });
    try {
      const rows = raw
        .prepare('SELECT record_id, content, created_time FROM l1_records ORDER BY record_id')
        .all() as Array<{ record_id: string; content: string; created_time: string }>;
      const want = [...LEGACY_ROWS].sort((a, b) => a.id.localeCompare(b.id));
      expect(rows.map((r) => [r.record_id, r.content, r.created_time])).toEqual(
        want.map((r) => [r.id, r.content, r.created]),
      );
    } finally {
      raw.close();
    }
  });

  it('④ 迁移后检索照常命中（迁移没有打坏 FTS 索引）', async () => {
    const file = await makeLegacyDb('fts');
    const db = new MemoryDb(file, 0);
    db.init();
    const store = new L1Store(dir, db, undefined, 'keyword');
    await store.init();
    try {
      const ids = (await store.search('alpha', 10, {})).map((h) => h.id);
      expect(ids.sort()).toEqual(['old-a', 'old-b', 'old-c']);
    } finally {
      db.close();
    }
  });

  it('④ 迁移后存量记录对**任意**工作区可见（默认 global 的实际效果，而不是只在库里躺着）', async () => {
    const file = await makeLegacyDb('visible');
    const db = new MemoryDb(file, 0);
    db.init();
    const store = new L1Store(dir, db, undefined, 'keyword');
    await store.init();
    try {
      const a = (await store.search('alpha', 10, { workspaceId: 'e:\\proj\\a' })).map((h) => h.id);
      const b = (await store.search('alpha', 10, { workspaceId: 'e:\\proj\\b' })).map((h) => h.id);
      expect(a.sort()).toEqual(['old-a', 'old-b', 'old-c']);
      expect(b.sort()).toEqual(['old-a', 'old-b', 'old-c']);
    } finally {
      db.close();
    }
  });

  it('二次 init 幂等：迁移不会因重复打开而重复执行或报错', async () => {
    const file = await makeLegacyDb('idem');
    const db1 = new MemoryDb(file, 0);
    db1.init();
    db1.close();
    const db2 = new MemoryDb(file, 0);
    expect(() => db2.init()).not.toThrow();
    expect(db2.countL1()).toBe(LEGACY_ROWS.length);
    db2.close();
  });
});

describe('task_28 §E FTS 重建回灌必须带上可见范围（一次索引重建就能把隔离抹平）', () => {
  it('缺 scope 列的 FTS 被重建后，workspace 归属仍然生效', async () => {
    if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-scope-migrate-'));
    const file = join(dir, 'fts-rebuild.db');
    const WS = 'e:\\proj\\iso';
    const OTHER = 'e:\\proj\\other';

    // 1) 正常建库（新 schema），写入一条 workspace 归属的 work 记录
    const db1 = new MemoryDb(file, 0);
    db1.init();
    const now = Date.now();
    db1.upsertL1Batch([
      {
        id: 'iso-1',
        content: 'isolation probe alpha',
        type: 'work_fact',
        priority: 60,
        scene_name: 'iso',
        timestamps: [now],
        createdAt: now,
        updatedAt: now,
        version: 0,
        family: 'work',
        scope: 'workspace',
        workspaceId: WS,
      },
    ]);
    db1.close();

    // 2) 把 FTS 换成**没有 scope 列**的旧结构——正是 init 的重建判据
    const raw = new DatabaseSync(file, { allowExtension: false });
    try {
      raw.exec('DROP TABLE l1_fts');
      raw.exec(LEGACY_FTS_DDL);
    } finally {
      raw.close();
    }

    // 3) 重开 → DROP + 重建 + backfillL1Fts（本用例真正要咬住的那条路径）
    const db2 = new MemoryDb(file, 0);
    db2.init();
    const store = new L1Store(dir, db2, undefined, 'keyword');
    await store.init();
    try {
      const mine = (await store.search('alpha', 10, { workspaceId: WS })).map((h) => h.id);
      const other = (await store.search('alpha', 10, { workspaceId: OTHER })).map((h) => h.id);
      expect(mine).toContain('iso-1');
      // ← 区分力就在这里：回灌若漏掉 scope / workspace_id，行会回落 'global'，
      //    于是别的"工作区"也能看到它——一次索引重建就把隔离抹平，且没有任何报错。
      expect(other).not.toContain('iso-1');
    } finally {
      db2.close();
    }
  });
});
