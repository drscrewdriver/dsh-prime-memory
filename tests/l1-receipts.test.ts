/**
 * §B L1 决策凭证链（Wave 2a）—— task_15 建表 + task_16 input_digest。
 *
 * §B 的价值具有**不可追溯性**：凭证必须在整合事件**之前**存在。
 * 判「某次 store/update/merge 是否正确」需要当时的输入快照，而快照无法事后补录——
 * 故本波不设症状触发条件（论证见 findings.md §9）。
 *
 * 本文件钉住两件事：
 * ① `l1_receipts` 的**磁盘契约**（列名/主键/索引）——表结构是契约，改它要迁移，不能随手动；
 * ② `input_digest` 是**纯函数且对顺序敏感**：同输入可复现，顺序不同即不同摘要。
 *    顺序必须敏感，因为 `searchCandidates` 返回的是**有序候选池**，
 *    「当时看到哪些候选、按什么序」正是回溯时要复原的输入。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { inputDigest } from '../src/store/receipts.js';
import { MemoryDb } from '../src/store/sqlite.js';

let dir: string;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function freshFile(tag: string): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-receipts-'));
  return join(dir, `${tag}-${Date.now()}.db`);
}

describe('task_15 l1_receipts 表结构（磁盘契约）', () => {
  it('表存在,列齐全,receipt_id 为主键', async () => {
    const file = await freshFile('schema');
    const db = new MemoryDb(file, 0);
    db.init();
    db.close();

    const raw = new DatabaseSync(file, { allowExtension: false });
    try {
      const cols = raw.prepare('PRAGMA table_info(l1_receipts)').all() as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>;
      expect(cols.map((c) => c.name).sort()).toEqual(
        ['decided_at', 'input_digest', 'kind', 'receipt_id', 'record_id', 'run_id'].sort(),
      );
      const pk = cols.filter((c) => c.pk > 0).map((c) => c.name);
      expect(pk).toEqual(['receipt_id']);
    } finally {
      raw.close();
    }
  });

  it('索引齐全:按 run_id 与 record_id 双维回溯(task_19 的两条查询路径)', async () => {
    const file = await freshFile('index');
    const db = new MemoryDb(file, 0);
    db.init();
    db.close();

    const raw = new DatabaseSync(file, { allowExtension: false });
    try {
      const rows = raw
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'l1_receipts'")
        .all() as Array<{ name: string; sql: string | null }>;
      const sql = rows.map((r) => r.sql ?? '').join('\n');
      expect(sql).toMatch(/run_id/);
      expect(sql).toMatch(/record_id/);
    } finally {
      raw.close();
    }
  });

  it('重复 init 幂等(IF NOT EXISTS):迁移不因二次打开而炸', async () => {
    const file = await freshFile('idem');
    const db1 = new MemoryDb(file, 0);
    db1.init();
    db1.close();
    const db2 = new MemoryDb(file, 0);
    expect(() => db2.init()).not.toThrow();
    db2.close();
  });
});

describe('task_16 input_digest —— 候选池有序序列的稳定摘要', () => {
  it('同输入两次生成完全一致(可复现)', () => {
    expect(inputDigest(['r1', 'r2', 'r3'])).toBe(inputDigest(['r1', 'r2', 'r3']));
  });

  it('**顺序敏感**:同一集合换个序 → 不同摘要(有序候选池的"序"是输入的一部分)', () => {
    expect(inputDigest(['r1', 'r2'])).not.toBe(inputDigest(['r2', 'r1']));
  });

  it('重复项不被折叠(r1,r1 ≠ r1 —— 候选池里的重复本身也是事实)', () => {
    expect(inputDigest(['r1', 'r1'])).not.toBe(inputDigest(['r1']));
  });

  it('空池有稳定的、非抛错的摘要(去重路径可能零候选)', () => {
    expect(() => inputDigest([])).not.toThrow();
    expect(inputDigest([])).toBe(inputDigest([]));
    expect(inputDigest([])).not.toBe(inputDigest(['']));
  });

  it('输出为 64 位十六进制 sha256', () => {
    expect(inputDigest(['r1'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('边界:分隔歧义不得导致碰撞 —— ["a|b"] 与 ["a","b"] 必须不同', () => {
    expect(inputDigest(['a|b'])).not.toBe(inputDigest(['a', 'b']));
    expect(inputDigest(['a\nb'])).not.toBe(inputDigest(['a', 'b']));
  });
});
