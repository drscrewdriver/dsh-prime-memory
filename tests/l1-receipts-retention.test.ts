/**
 * §B L1 决策凭证链（Wave 2a）—— task_18 保留策略。
 *
 * 为什么必须有保留策略：凭证表**只增不减**。写入点(task_17)每轮蒸馏都会落一批行，
 * `memory.db` 是**单文件长期驻留**的事实源——没有裁剪就是无界增长，而
 * 「记录决策」这个旁路设施的代价不该随时间线性膨胀到威胁主设施。
 *
 * 本文件钉住三件事：
 * ① **裁剪粒度是 run 而不是行**。task_19 要按 run_id 回溯「一轮蒸馏的全部决策」，
 *    若按行裁剪，会出现半截 run——回溯到一个缺了尾巴的批次，比回溯不到更危险
 *    （看起来有数据，实际结论是错的）。
 * ② **裁剪只碰凭证表**。`l1_receipts` 是观测设施，`l1_records` 是事实源；
 *    一个为了省空间的旁路操作若波及记忆本体，那是在删用户的数据。
 * ③ **裁剪失败不得扰动主链路**。与 task_17 同一原则：凭证设施永不是单点。
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { RECEIPTS_MAX_RUNS, buildReceipts } from '../src/store/receipts.js';
import type { MemoryRecord } from '../src/types.js';
import type { L1Receipt } from '../src/store/receipts.js';

let dir: string;
/**
 * 已开启的库句柄:用例在断言失败时不会走到 `db.close()`,会让 teardown 的 rm 撞
 * EBUSY 并把 RED 信号淹没成 "Failed Suite"。故集中登记、在 afterAll 兜底关闭。
 */
const openedDbs: Array<{ close: () => void }> = [];
afterAll(async () => {
  for (const db of openedDbs) {
    try {
      db.close();
    } catch {
      /* 已关闭或已释放 */
    }
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

let seq = 0;
const files = new Map<MemoryDb, string>();
function freshDb(): MemoryDb {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'dsh-receipts-retention-'));
  const file = join(dir, `m-${++seq}-${Date.now()}.db`);
  const db = new MemoryDb(file, 0);
  db.init();
  files.set(db, file);
  openedDbs.push(db);
  return db;
}

/** 一轮蒸馏的凭证:`runId` 标识批次,`n` 条记录,`at` 为决策时刻(决定新旧序)。 */
function run(runId: string, at: string, n: number): L1Receipt[] {
  return buildReceipts(
    runId,
    at,
    Array.from({ length: n }, (_, i) => ({ recordId: `${runId}-r${i}`, candidateIds: [], action: 'store' })),
  );
}

/**
 * 直接按 run_id 数行——**刻意绕开被测代码**(另开只读连接直查),否则就是
 * 用被测实现验证被测实现:裁剪写错了,计数也会跟着一起错,断言恒真。
 */
function countByRun(db: MemoryDb, runId: string): number {
  const raw = new DatabaseSync(files.get(db)!, { readOnly: true });
  try {
    const row = raw.prepare('SELECT COUNT(*) AS n FROM l1_receipts WHERE run_id = ?').get(runId) as {
      n: number | bigint;
    };
    return Number(row.n);
  } finally {
    raw.close();
  }
}

function rec(id: string): MemoryRecord {
  return {
    id,
    content: `记忆 ${id}`,
    type: 'work_fact',
    priority: 60,
    scene_name: '默认',
    timestamps: [Date.parse('2026-09-16T07:00:00.000Z')],
    createdAt: Date.parse('2026-09-16T07:00:00.000Z'),
    updatedAt: Date.parse('2026-09-16T07:00:00.000Z'),
  } as MemoryRecord;
}

describe('task_18 凭证保留策略:按 run 裁剪', () => {
  it('① 超出上限时,只保留最新的 N 个 run', () => {
    const db = freshDb();
    for (let i = 1; i <= 5; i++) {
      db.recordReceipts(run(`run_${i}`, `2026-09-16T00:0${i}:00.000Z`, 2), { maxRuns: 2 });
    }
    // 最新的两个 run 是 4、5
    expect(countByRun(db, 'run_5')).toBe(2);
    expect(countByRun(db, 'run_4')).toBe(2);
    expect(countByRun(db, 'run_3')).toBe(0);
    expect(countByRun(db, 'run_2')).toBe(0);
    expect(countByRun(db, 'run_1')).toBe(0);
  });

  it('② 裁剪粒度是 run:存活批次不留半截(否则 task_19 的批次回溯会给出错误结论)', () => {
    const db = freshDb();
    for (let i = 1; i <= 4; i++) {
      db.recordReceipts(run(`run_${i}`, `2026-09-16T00:0${i}:00.000Z`, 3), { maxRuns: 2 });
    }
    for (const id of ['run_4', 'run_3']) expect(countByRun(db, id)).toBe(3);
    for (const id of ['run_2', 'run_1']) expect(countByRun(db, id)).toBe(0);
  });

  it('③ 未超上限时一行不删', () => {
    const db = freshDb();
    const deleted = db.recordReceipts(run('run_a', '2026-09-16T00:01:00.000Z', 4), { maxRuns: 5 });
    expect(deleted).toBe(4); // 返回值仍是"新增条数",裁剪删 0 不冲抵
    expect(countByRun(db, 'run_a')).toBe(4);
  });

  it('④ 边界:恰好等于上限不裁(上限是"最多留 N",不是"超过 N-1 就裁")', () => {
    const db = freshDb();
    for (let i = 1; i <= 3; i++) {
      db.recordReceipts(run(`run_${i}`, `2026-09-16T00:0${i}:00.000Z`, 2), { maxRuns: 3 });
    }
    expect(countByRun(db, 'run_1')).toBe(2);
    expect(countByRun(db, 'run_2')).toBe(2);
    expect(countByRun(db, 'run_3')).toBe(2);
  });

  it('⑤ 红线:裁剪凭证**绝不**波及 l1_records(观测设施不许删事实源)', () => {
    const db = freshDb();
    for (const id of ['mem_keep_1', 'mem_keep_2']) expect(db.upsertL1(rec(id))).toBe(true);
    const before = db.countL1();

    for (let i = 1; i <= 4; i++) {
      db.recordReceipts(run(`run_${i}`, `2026-09-16T00:0${i}:00.000Z`, 1), { maxRuns: 1 });
    }

    expect(countByRun(db, 'run_1')).toBe(0); // 凭证确实被裁了
    expect(db.countL1()).toBe(before); // 记忆一条没少
    expect(db.countL1()).toBe(2);
  });

  it('⑥ 防呆:maxRuns <= 0 或非有限值 → 不裁剪(传 0 不能变成"清空")', () => {
    const db = freshDb();
    db.recordReceipts(run('run_x', '2026-09-16T00:01:00.000Z', 2));
    expect(db.trimReceipts(0)).toBe(0);
    expect(db.trimReceipts(-1)).toBe(0);
    expect(db.trimReceipts(Number.NaN)).toBe(0);
    expect(countByRun(db, 'run_x')).toBe(2);
  });

  it('⑦ 同一时刻的多个 run:仍按 run_id 定序,裁剪结果确定可复现', () => {
    const at = '2026-09-16T00:01:00.000Z'; // decided_at 完全相同
    const a = freshDb();
    for (const id of ['run_aaa', 'run_bbb', 'run_ccc']) a.recordReceipts(run(id, at, 1), { maxRuns: 2 });
    // run_id 降序 → 保留 ccc / bbb
    expect(countByRun(a, 'run_ccc')).toBe(1);
    expect(countByRun(a, 'run_bbb')).toBe(1);
    expect(countByRun(a, 'run_aaa')).toBe(0);

    // 换个插入顺序,结论必须一致(顺序无关性是"确定"的前提)
    const b = freshDb();
    for (const id of ['run_ccc', 'run_aaa', 'run_bbb']) b.recordReceipts(run(id, at, 1), { maxRuns: 2 });
    expect(countByRun(b, 'run_ccc')).toBe(1);
    expect(countByRun(b, 'run_bbb')).toBe(1);
    expect(countByRun(b, 'run_aaa')).toBe(0);
  });

  it('⑧ 默认阈值:调用方不传 maxRuns 时走 RECEIPTS_MAX_RUNS,且该值有界可续', () => {
    // 阈值本身是设计参数,钉住它防止被悄悄改成 0 / Infinity
    expect(Number.isFinite(RECEIPTS_MAX_RUNS)).toBe(true);
    expect(RECEIPTS_MAX_RUNS).toBeGreaterThanOrEqual(100);

    const db = freshDb();
    const rows = run('run_default', '2026-09-16T00:01:00.000Z', 3);
    expect(db.recordReceipts(rows)).toBe(3); // 默认路径正常写入
    expect(countByRun(db, 'run_default')).toBe(3);
  });

  it('⑨ 失败隔离:裁剪抛错时,recordReceipts 仍返回新增条数且不向上抛', () => {
    const db = freshDb();
    vi.spyOn(db, 'trimReceipts').mockImplementation(() => {
      throw new Error('磁盘只读');
    });
    const rows = run('run_y', '2026-09-16T00:01:00.000Z', 2);
    expect(() => db.recordReceipts(rows)).not.toThrow();
    expect(db.recordReceipts(rows)).toBe(0); // 第二次是重复 id,新增 0
    expect(countByRun(db, 'run_y')).toBe(2); // 凭证本身照常落盘
    vi.restoreAllMocks();
  });
});
