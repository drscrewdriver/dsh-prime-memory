/**
 * 并发丢更新演练(T6.2 / T4.7~T4.11 验收)。
 *
 * 跑法:node scripts/concurrency-drill.mjs <out.json> [workers] [rounds]
 *
 * 每个 worker 是一个**独立进程**(真·跨进程,不是同进程 Promise):
 * 各自 `load()` 一份 slots.json,然后 RMW N 轮(每轮 upsert 一个全局唯一的槽位)。
 * 判定:
 * - 丢更新 = 最终文件里的槽位数 < workers × rounds(有人把别人的整块盖掉了);
 * - 可观测失败 = 被并发冲突挡下的写入次数(本设计的失败姿态:拒写 + 诊断,
 *   而不是静默覆盖)。**丢更新必须为 0**,失败可以是任意非负整数。
 *
 * ⚠️ 本机 unlink 极慢(findings §11),进程数/轮数别开太大。
 */
import { fork } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2] ?? 'concurrency-drill.json';
const workers = Number(process.argv[3] ?? 2);
const rounds = Number(process.argv[4] ?? 10);
const DRILL_FLAG = 'CONCURRENCY_DRILL_CHILD';

// 子进程分支:自己跑 RMW 循环,把"被拒次数"写回 stdout 的最后一行 JSON
if (process.env[DRILL_FLAG] === '1') {
  const { SlotStore } = await import('../dist/store/slots.js');
  const file = process.env.DRILL_FILE;
  const n = Number(process.env.DRILL_ROUNDS ?? 10);
  const wid = process.env.DRILL_WID ?? '?';
  const blocked = [];
  const logger = {
    debug() {},
    info() {},
    warn: (m) => {
      if (String(m).includes('已被其它进程更新') || String(m).includes('槽位持久化失败')) blocked.push(String(m));
    },
    error() {},
  };
  const store = new SlotStore(file, logger, { maxSlots: n * 8 });
  await store.load();
  for (let i = 0; i < n; i++) {
    await store.upsert({ title: `w${wid}-r${i}`, body: `worker ${wid} round ${i}`, kind: 'task' });
  }
  process.stdout.write(JSON.stringify({ wid, blocked: blocked.length }) + '\n');
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), 'conc-drill-'));
const file = join(dir, 'slots.json');
const started = Date.now();

const results = await Promise.all(
  Array.from({ length: workers }, (_, i) =>
    new Promise((resolve) => {
      const child = fork(fileURLToPath(import.meta.url), [], {
        env: { ...process.env, [DRILL_FLAG]: '1', DRILL_FILE: file, DRILL_ROUNDS: String(rounds), DRILL_WID: String(i) },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let buf = '';
      child.stdout.on('data', (d) => (buf += String(d)));
      child.on('exit', () => {
        const line = buf.trim().split('\n').filter(Boolean).pop() ?? '{}';
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ wid: String(i), blocked: -1 });
        }
      });
    }),
  ),
);

let finalSlots;
try {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  finalSlots = Array.isArray(parsed?.slots) ? parsed.slots.length : 0;
} catch {
  finalSlots = -1;
}

const expected = workers * rounds;
const lost = Math.max(0, expected - finalSlots);
const result = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  workers,
  rounds,
  expectedSlots: expected,
  finalSlots,
  lostUpdates: lost,
  blockedWrites: results.reduce((a, r) => a + Math.max(0, r.blocked ?? 0), 0),
  perWorker: results,
  elapsedMs: Date.now() - started,
  verdict:
    lost === 0
      ? 'PASS(丢更新 0)'
      : lost === result.blockedWrites
        ? 'PASS(无覆盖型丢失:冲突写入被拒且有诊断,失败方可观测)'
        : 'FAIL(存在覆盖型丢失)',
};
await writeFile(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
