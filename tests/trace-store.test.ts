/**
 * §F TraceStore 测试(memorax-absorb Wave 4 / task_28):
 * append→tail 往返、kind 过滤、切日保留期清理、5MB 停写 + marker、未初始化 no-op。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TraceStore } from '../src/store/trace.js';
import type { DistillTraceEvent, RecallTraceEvent } from '../src/contract.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'dsh-trace-'));
  dirs.push(d);
  return d;
}

function recallEvent(ts: number, i = 0): RecallTraceEvent {
  return {
    kind: 'recall_turn', ts, sessionId: 's1', queryChars: 10 + i, querySha: `sha${i}`,
    hitIds: ['a'], hitScores: [0.9], injectedIds: ['a'], suppressedCount: 0,
    durationMs: 5, outcome: 'injected',
  };
}
function distillEvent(ts: number): DistillTraceEvent {
  return {
    kind: 'distill_run', ts, layer: 'l1', sessionId: 's1', runId: 'run_x',
    inputChars: 100, byKind: { store: 2, skip: 1 }, newRecords: 2, durationMs: 800, ok: true,
  };
}

describe('TraceStore', () => {
  it('append → tail 往返;kind 过滤;返回按时间升序', async () => {
    const dir = await tmpDir();
    const store = new TraceStore(dir, { retentionDays: 14 });
    store.append(recallEvent(1000, 1));
    store.append(distillEvent(2000));
    store.append(recallEvent(3000, 2));
    await store.flush();
    const all = await store.tail(100);
    expect(all.map((e) => e.ts)).toEqual([1000, 2000, 3000]);
    const onlyRecall = await store.tail(100, 'recall_turn');
    expect(onlyRecall.every((e) => e.kind === 'recall_turn')).toBe(true);
    expect(onlyRecall).toHaveLength(2);
  });

  it('tail lines 上限取最新(倒序收集后反转)', async () => {
    const dir = await tmpDir();
    const store = new TraceStore(dir, { retentionDays: 14 });
    for (let i = 1; i <= 10; i++) store.append(recallEvent(i * 100, i));
    await store.flush();
    const tail = await store.tail(3);
    expect(tail.map((e) => e.ts)).toEqual([800, 900, 1000]);
  });

  it('切日清理:超过 retentionDays 的旧文件被删;0 = 永久', async () => {
    const dir = await tmpDir();
    const oldDay = new Date(Date.now() - 40 * 86_400_000);
    const oldKey = `${oldDay.getFullYear()}-${String(oldDay.getMonth() + 1).padStart(2, '0')}-${String(oldDay.getDate()).padStart(2, '0')}`;
    await writeFile(join(dir, 'trace', `trace-${oldKey}.jsonl`), JSON.stringify(recallEvent(1)) + '\n', 'utf-8').catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, 'trace'), { recursive: true });
      await writeFile(join(dir, 'trace', `trace-${oldKey}.jsonl`), JSON.stringify(recallEvent(1)) + '\n', 'utf-8');
    });
    // 40 天前 > 14 天保留 → 今日首写时被清理
    const store = new TraceStore(dir, { retentionDays: 14 });
    store.append(recallEvent(Date.now()));
    await store.flush();
    const files = await readdir(join(dir, 'trace'));
    expect(files.some((f) => f.includes(oldKey))).toBe(false);
    expect(files.length).toBe(1);
    // 0 = 永久保留
    const dir2 = await tmpDir();
    await (async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(dir2, 'trace'), { recursive: true });
      await writeFile(join(dir2, 'trace', `trace-${oldKey}.jsonl`), JSON.stringify(recallEvent(1)) + '\n', 'utf-8');
    })();
    const forever = new TraceStore(dir2, { retentionDays: 0 });
    forever.append(recallEvent(Date.now()));
    await forever.flush();
    expect((await readdir(join(dir2, 'trace'))).length).toBe(2);
  });

  it('单文件超上限停写 + trace_truncated marker;当日不再写入', async () => {
    const dir = await tmpDir();
    // 上限压到很小:首条写完即超限
    const store = new TraceStore(dir, { retentionDays: 14, maxFileBytes: 10 });
    store.append(recallEvent(Date.now(), 1));
    await store.flush();
    store.append(recallEvent(Date.now(), 2)); // 当日已停写 → 丢弃
    await store.flush();
    const files = await readdir(join(dir, 'trace'));
    expect(files.length).toBe(1);
    const raw = await readFile(join(dir, 'trace', files[0]), 'utf-8');
    expect(raw).toContain('trace_truncated');
    expect((raw.match(/recall_turn/g) ?? []).length).toBe(1); // 第二条未写入
  });

  it('metadata-only 语义由埋点方决定:store 原样序列化(不补字段不裁字段)', async () => {
    const dir = await tmpDir();
    const store = new TraceStore(dir, { retentionDays: 14 });
    const ev = recallEvent(Date.now(), 9);
    delete (ev as Partial<RecallTraceEvent>).queryText; // metadata-only:无原文
    store.append(ev);
    await store.flush();
    const [row] = await store.tail(1);
    expect(row).toHaveProperty('querySha');
    expect(row).not.toHaveProperty('queryText');
  });
});
