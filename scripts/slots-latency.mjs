/**
 * slots 写路径延迟微基准(T0.2 / T4.12 用)。
 *
 * 测的是 `SlotStore.upsert()` 端到端:内存改 + 序列化 + 原子写(tmp/fsync/rename)。
 * 锁接入后（T4）同一脚本再跑一次，比 P50/P95 增量是否 ≤ 10%。
 *
 * 每轮 upsert 后立刻 close，槽位数组与文件体积保持恒定（1 条），
 * 否则文件越写越大，测出来的是体积增长而不是写路径开销。
 *
 * 用法：node scripts/slots-latency.mjs <out.json> [rounds]
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SlotStore } from '../dist/store/slots.js';

const out = process.argv[2] ?? 'slots-latency.json';
const rounds = Number(process.argv[3] ?? 300);
const warmup = 20;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const dir = await mkdtemp(join(tmpdir(), 'slots-latency-'));
try {
  const file = join(dir, 'slots.json');

  // 每轮一个新实例：槽位数组恒为 1 条、文件体积恒定，测到的就是写路径本身
  // （内存改 + 序列化 + 原子写），不带体积增长与读侧开销。
  const run = async (n) => {
    const times = [];
    for (let i = 0; i < n; i++) {
      const store = new SlotStore(file, logger);
      const t0 = performance.now();
      await store.upsert({ title: `t${i}`, body: 'x'.repeat(200), kind: 'task' });
      times.push(performance.now() - t0);
    }
    return times;
  };

  await run(warmup); // 预热：JIT + 文件系统缓存
  const times = (await run(rounds)).sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);

  const result = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    rounds,
    warmup,
    unit: 'ms',
    p50: +pct(times, 0.5).toFixed(3),
    p95: +pct(times, 0.95).toFixed(3),
    p99: +pct(times, 0.99).toFixed(3),
    mean: +(sum / times.length).toFixed(3),
    min: +times[0].toFixed(3),
    max: +times[times.length - 1].toFixed(3),
  };
  await writeFile(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  await rm(dir, { recursive: true, force: true });
}
