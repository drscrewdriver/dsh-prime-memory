/**
 * §C 矛盾冻结 / task_21:conflict_pending 建表（磁盘契约）。
 *
 * 冻结**不是"拦住写入"**——新记忆照常入 L1，与冲突的旧记忆作为**一对**停放在本表，
 * 双方内容都不被改写，直到人工裁决（承自 mneme 的 dream layer 语义，见 findings.md §3）。
 *
 * 钉住三件事：
 * ① 列名/主键——表结构是磁盘契约，改它要迁移；
 * ② `resolved_at` 缺省为**空串**（'' = 未裁决），与 l1_receipts 的 '' 约定一致，
 *    不用 NULL 以免 `= ''` 与 `IS NULL` 两套判据并存；
 * ③ **未裁决索引**存在——队列上限（task_24）与裁决工具（task_25）都只关心未裁决行，
 *    "查未裁决"必须是索引路径而非全表扫描。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';

let dir: string;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function freshFile(tag: string): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-conflict-'));
  return join(dir, `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

describe('task_21 conflict_pending 表结构（磁盘契约）', () => {
  it('表存在，列齐全，pair_id 为主键', async () => {
    const file = await freshFile('schema');
    const db = new MemoryDb(file, 0);
    db.init();
    db.close();

    const raw = new DatabaseSync(file, { allowExtension: false });
    try {
      const cols = raw.prepare('PRAGMA table_info(conflict_pending)').all() as Array<{
        name: string;
        pk: number;
      }>;
      // 磁盘契约:Phase 2(task_2.1)加了三列承载 R1 未决态。
      // 本断言是**精确列集合**(审计 S8 点名的"加列必破"处),故新增列必须同批补全——
      // 保留精确性是有意的:这是磁盘契约测试,子集断言会放过"列被悄悄改名"。
      // 注意:新增列**不进快照哈希**(哈希走 l1-snapshot 的 7 字段列投影,见 task_2.8)。
      expect(cols.map((c) => c.name).sort()).toEqual(
        [
          'created_at',
          'defer_count',
          'deferred_at',
          'loser_id',
          'pair_id',
          'resolution',
          'resolved_at',
          'reviewed_at',
          'run_id',
          'winner_id',
        ].sort(),
      );
      // 升级前的 7 列必须仍然齐全(结构性回归:加列不得挤掉旧列)
      for (const legacy of ['pair_id', 'run_id', 'winner_id', 'loser_id', 'created_at', 'resolved_at', 'resolution']) {
        expect(cols.map((c) => c.name)).toContain(legacy);
      }
      expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['pair_id']);
    } finally {
      raw.close();
    }
  });

  it('resolved_at 缺省为「空」= 未裁决（插入时不写该列也能读回）', async () => {
    const file = await freshFile('default');
    const db = new MemoryDb(file, 0);
    db.init();
    db.close();

    const raw = new DatabaseSync(file, { allowExtension: false });
    try {
      raw
        .prepare(
          `INSERT INTO conflict_pending (pair_id, run_id, winner_id, loser_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('pair_1', 'run_1', 'mem_a', 'mem_b', '2026-09-16T00:00:00.000Z');
      const row = raw
        .prepare('SELECT resolved_at, resolution FROM conflict_pending WHERE pair_id = ?')
        .get('pair_1') as { resolved_at: string; resolution: string };
      expect(row.resolved_at).toBe('');
      expect(row.resolution).toBe('');
    } finally {
      raw.close();
    }
  });

  it('未裁决索引存在，且按 resolved_at 建立（不是全表扫描）', async () => {
    const file = await freshFile('index');
    const db = new MemoryDb(file, 0);
    db.init();
    db.close();

    const raw = new DatabaseSync(file, { allowExtension: false });
    try {
      const rows = raw
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conflict_pending'",
        )
        .all() as Array<{ name: string; sql: string | null }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => (r.sql ?? '').includes('resolved_at'))).toBe(true);
    } finally {
      raw.close();
    }
  });

  it('重复 init 幂等（IF NOT EXISTS）：迁移不因二次打开而炸', async () => {
    const file = await freshFile('idem');
    const db1 = new MemoryDb(file, 0);
    db1.init();
    db1.close();
    const db2 = new MemoryDb(file, 0);
    expect(() => db2.init()).not.toThrow();
    db2.close();
  });
});
