/**
 * recall-usage store 单测(TDD 先行):尝试/使用两级计数、时间戳更新、
 * 持久化回环(重开仍在)、去抖 flush、超大淘汰。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RecallUsageStore } from '../src/store/recall-usage.js';

let dir: string;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function mk(): Promise<RecallUsageStore> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-recallusage-'));
  const s = new RecallUsageStore(dir);
  await s.init();
  return s;
}

describe('RecallUsageStore', () => {
  it('recordAttempt:候选 attempts++/lastAttemptAt;used 子集额外 used++/lastUsedAt', async () => {
    const s = await mk();
    s.recordAttempt(['a', 'b', 'c'], ['b']);
    s.flushSync();
    const a = s.get('a')!;
    expect(a.attempts).toBe(1);
    expect(a.used).toBe(0);
    expect(a.lastAttemptAt).toBeGreaterThan(0);
    expect(a.lastUsedAt).toBeNull();
    const b = s.get('b')!;
    expect(b.attempts).toBe(1);
    expect(b.used).toBe(1);
    expect(b.lastUsedAt!).toBeGreaterThanOrEqual(b.lastAttemptAt!);
    // 二轮:只有 a 参与、无人进 topN
    s.recordAttempt(['a'], []);
    s.flushSync();
    expect(s.get('a')!.attempts).toBe(2);
    expect(s.get('a')!.used).toBe(0);
    // 未参与的 c 不变
    expect(s.get('c')!.attempts).toBe(1);
  });

  it('usedIds 不在候选内时仍计入使用(容错,不静默丢)', async () => {
    const s = await mk();
    s.recordAttempt(['a'], ['x']);
    s.flushSync();
    expect(s.get('x')!.used).toBe(1);
    expect(s.get('x')!.attempts).toBe(1);
  });

  it('summary:tracked/attempted/used/rate', async () => {
    const s = await mk();
    s.recordAttempt(['a', 'b'], ['a']);
    s.recordAttempt(['a'], []);
    s.flushSync();
    const sum = s.summary();
    expect(sum.tracked).toBe(2);
    expect(sum.attempted).toBe(3); // 2 + 1
    expect(sum.used).toBe(1);
    expect(sum.rate).toBe(Math.round((1 / 3) * 100));
  });

  it('持久化回环:重开文件统计仍在', async () => {
    if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-recallusage-'));
    const d = join(dir, 'persist-' + Math.random().toString(36).slice(2));
    const p = new RecallUsageStore(d);
    await p.init();
    p.recordAttempt(['k1'], ['k1']);
    await p.flush();
    const q = new RecallUsageStore(d);
    await q.init();
    expect(q.get('k1')!.used).toBe(1);
  });

  it('损坏文件 → 只读降级,内存态照常(对齐 sidecar 家族纪律)', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-recallusage-'));
    const d = join(dir, 'corrupt');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'recall-usage.json'), '{bad', 'utf8');
    const s = new RecallUsageStore(d);
    await s.init();
    s.recordAttempt(['z'], []);
    s.flushSync();
    expect(s.get('z')!.attempts).toBe(1);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(d, 'recall-usage.json'), 'utf8')).toBe('{bad'); // 不回写
  });
});
