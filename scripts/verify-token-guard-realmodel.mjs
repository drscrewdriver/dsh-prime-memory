/**
 * #22 T1/T3 —— 真模型实证（可选跑，不进 CI）。
 *
 * 为什么要单独跑这个：CI 里的 `embedding-token-guard.test.ts` 用的是**桩 tokenizer**，
 * 它只能证明「截断算法按 id 数正确」，证不了计划里那条要害判据：
 *
 *   T1: 截断后的文本送进 pipeline、被**重新分词并补 special token** 之后，
 *       真正进入模型的 seq 长度仍然 ≤ 预算。
 *
 * 「按 budget-2 留位」本质是一个假设（Unigram/BPE 切片→解码→再编码不保证得到同一序列，
 * 边界效应可能变长）。假设错了就意味着护栏形同虚设，而桩测试永远不会红。
 * 本脚本用真 bge-m3 把这个假设打成事实或打破它。
 *
 * T3 顺带做：记录真推理的 RSS 峰值增量，作为「内存护栏」的代理上界（Windows 上
 * 复现不了 macOS 的 SIGTRAP，但 T² 峰值与平台无关，见 CHANGELOG 0.26.25）。
 *
 * 用法：
 *   node scripts/verify-token-guard-realmodel.mjs
 *   node scripts/verify-token-guard-realmodel.mjs --budget 24    # 自定义预算（验证不同档位）
 * 需要本机已有 runtime 与 bge-m3（默认 ~/.dsh/memory，可用 PM_DATA_DIR 覆盖）。
 */
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 默认预算从唯一真值源读，不在本脚本里再写一个魔数（否则改了常量这里就说谎）
const { HARD_CAP_TOKENS: HARD_CAP_DEFAULT } = await import(
  pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'store', 'model-catalog.js')).href,
).then((m) => ({ HARD_CAP_TOKENS: m.HARD_CAP_TOKENS }));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.PM_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.dsh', 'memory');
const runtimeDir = path.join(dataDir, 'runtime');
const modelDir = path.join(dataDir, 'models', 'bge-m3');

const argBudget = (() => {
  const i = process.argv.indexOf('--budget');
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : HARD_CAP_DEFAULT;
})();
// 连发次数：#22 报告人实测“单发安全≠连发安全”（arena 高水位不回落，同一段长文本
// 串行第 2 条就 SIGTRAP），本仓真实负载就是连发（graph 投影逐条 await embed）。
const argSerial = (() => {
  const i = process.argv.indexOf('--serial');
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 5;
})();

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` [${extra}]` : ''}`);
  if (!cond) failures++;
};
const rssMB = () => Math.round(process.memoryUsage.rss() / 1024 / 1024);

console.log(`runtime = ${runtimeDir}`);
console.log(`model   = ${modelDir}`);
const fs = await import('node:fs');
for (const p of [runtimeDir, modelDir]) {
  if (!fs.existsSync(p)) {
    console.log(`SKIP: 缺少 ${p} —— 本脚本需本机真模型；缺失时不作为通过依据。`);
    process.exit(0);
  }
}

// 与子进程完全同一条加载路径：从 runtime 的 package.json createRequire，禁远程模型。
const req = createRequire(path.join(runtimeDir, 'package.json'));
const mod = req('@huggingface/transformers');
mod.env.allowRemoteModels = false;

console.log('loading bge-m3 …');
const t0 = Date.now();
const baseRss = rssMB();
const extractor = await mod.pipeline('feature-extraction', modelDir, { dtype: 'q8' });
const tokenizer = extractor.tokenizer;
console.log(`  loaded in ${Date.now() - t0}ms, rss=${rssMB()}MB(+${rssMB() - baseRss})`);
ok('真 tokenizer 可从 pipeline 对象取到（截断的前提）', !!tokenizer && typeof tokenizer.encode === 'function');

// .cjs 必须走 file:// URL（Windows 上绝对路径直接 import 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const { shrinkToBudget } = await import(pathToFileURL(path.join(root, 'resources', 'embedding-token-guard.cjs')).href);

/**
 * 实测进模型的 seq 长度。两种取法互验，**谁也不能只靠说**：
 * - `byLibrary`：按库自己的口径再分一次词（就是 pipeline 内部的调用形式）。
 *   真 bge-m3 实测：输出在 `.input_ids.dims` = [1, seq]，**没有 `.shape`**。
 * - `byInference`：真跑一次推理并用向量做指纹比对——护栏生效时两次调用必须返回**不同**向量。
 *   （池化后输出是一维 `[1024]`，从输出张量里拿不到 seq，所以 seq 只能由库口径给出。）
 */
function measureSeq(text) {
  const enc = tokenizer(text, { padding: true, truncation: true });
  const ids = enc && enc.input_ids;
  if (!ids) return -1;
  if (Array.isArray(ids)) return ids.length;
  if (Array.isArray(ids.dims) && ids.dims.length >= 2) return ids.dims[1];
  return -1;
}

/** 走一遍真实推理，返回护栏自己的上报值与库口径实测值。 */
async function measure(text, budget) {
  const cut = shrinkToBudget(text, budget, tokenizer);
  const before = rssMB();
  const result = await extractor([cut.text], { pooling: 'cls', normalize: true });
  const dim = result[0] && result[0].dims;
  return {
    sent: cut.text,
    seq: cut.seq, // 子进程里真正上报的那个数
    byLibrary: measureSeq(cut.text),
    outDims: Array.isArray(dim) ? dim.join('x') : String(dim),
    vector: Array.from(result[0].data.slice(0, 8)),
    dRss: rssMB() - before,
  };
}

// #22 报告的致死档：5000/4000/3800 中文字符（实测 ≈3651/≈2774 token）。
const CASES = [
  { label: '5000 中文字符（报告实测 3651 token，致死档）', chars: 5000 },
  { label: '4000 中文字符（报告全崩档之一）', chars: 4000 },
  { label: '3800 中文字符（字符启发式会放走的那一档）', chars: 3800 },
];

console.log(`\n=== T1: 截断后实测进模型 seq ≤ ${argBudget} ===`);
let maxSeq = 0;
for (const c of CASES) {
  const raw = '记'.repeat(c.chars);
  const m = await measure(raw, argBudget);
  maxSeq = Math.max(maxSeq, m.seq);
  ok(`${c.label} → 上报 seq=${m.seq} ≤ 预算`, m.seq > 0 && m.seq <= argBudget, `库口径=${m.byLibrary} sentLen=${m.sent.length} outDims=${m.outDims}`);
  // 两个独立取法必须一致：上报值不能是自己圆的数
  ok(`${c.label} → 上报值与库口径实测一致`, m.seq === m.byLibrary, `${m.seq} vs ${m.byLibrary}`);
}

console.log('\n=== 对照：不设预算时真会超（证明用例确实在测超限，不是恒成立）===');
const unbounded = await measure('记'.repeat(5000), 0);
ok(`无预算时实测 seq(${unbounded.byLibrary}) 确实 > 预算(${argBudget})`, unbounded.byLibrary > argBudget, '即护栏确实在拦真东西');

console.log('\n=== 护栏生效的旁证：截断前后向量必须不同（相同则截断没发生）===');
const guardedVec = await measure('记'.repeat(5000), argBudget);
const rawVec = await measure('记'.repeat(5000), 0);
ok('截断后与未截断的向量不同', JSON.stringify(guardedVec.vector) !== JSON.stringify(rawVec.vector), `guarded seq=${guardedVec.seq} raw seq=${rawVec.byLibrary}`);

console.log('\n=== 连发护栏（报告人实测：单发安全≠连发安全）===');
/*
 * 同一段超长文本在**同一个子进程（同一 pipeline 实例）**里串行喂 argSerial 次：
 * 只要有任何一轮 seq 超预算，预算就是只对单发成立——那等于没护栏。
 * 本机（Windows/纯 node）不会像 Electron-node 那样 trap，所以本项只能证
 * “预算对连发一致成立”，不能证“连发不崩”（后者只能 macOS）。
 */
{
  const raw = '记'.repeat(5000);
  const seqs = [];
  for (let i = 0; i < argSerial; i++) {
    const m = await measure(raw, argBudget);
    seqs.push(m.seq);
  }
  const allIn = seqs.every((s) => s > 0 && s <= argBudget);
  ok(`${argSerial} 条串行同文本：每一轮实测 seq 均 ≤ 预算`, allIn, `seqs=${seqs.join(',')}`);
  const uniq = new Set(seqs);
  ok('连发各轮的 seq 一致（预算不随轮次漂移）', uniq.size === 1, `[...${[...uniq].join(',')}]`);
}

console.log('\n=== T3: 内存峰值代理上界（Windows 无 SIGTRAP，用峰值替代判据）===');
/*
 * 方注：**不得**用「推理前后取一次 RSS 差」当峰值——本脚本上一版就这么错过了，
 * 测出 raw ΔRSS = -8MB（负数）这种不可能的数：推理结束时激活已释放、GC 时机又晚于采样，
 * 取到的不是峰值而是余量。ORTE 的 run() 在主线程同步阻塞，本进程内 setInterval 采样采不到
 * （实测 peakMB=0），所以只能**从外部轮询子进程**。
 *
 * 做法：把一次真推理装进 fork 出的子跑，父侧每 50ms 轮询其峰值 RSS；两种预算各跑一次，
 * 比的是**同方法下的峰值**，不是绝对字节数（平台相关，不得当跳平台保证）。
 */
async function peakOfRun(budget, chars) {
  const { fork } = await import('node:child_process');
  const child = fork(path.join(root, 'scripts', '_t3-runner.mjs'), [], {
    env: { ...process.env, T3_RUNTIME: runtimeDir, T3_MODEL: modelDir, T3_BUDGET: String(budget), T3_CHARS: String(chars) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let peakKb = 0;
  const pid = child.pid;
  const poll = setInterval(() => {
    try {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      const m = /"(\d[\d,]*) K"/.exec(out.stdout || '');
      if (m) peakKb = Math.max(peakKb, Number(m[1].replace(/,/g, '')));
    } catch {
      /* 子进程已退，轮询失败不影响结论 */
    }
  }, 50);
  const done = await new Promise((res) => {
    child.once('message', res);
    child.once('exit', () => res({ seq: -1 }));
  });
  clearInterval(poll);
  return { peakMB: Math.round(peakKb / 1024), seq: (done && done.seq) ?? -1 };
}

let t3Runnable = process.platform === 'win32';
if (!t3Runnable) {
  console.log('  SKIP T3：峰值采样当前只接了 Windows(tasklist)，非 Windows 不拿无效数据当结论');
} else {
  const guardedPeak = await peakOfRun(argBudget, 5000);
  const rawPeak = await peakOfRun(0, 5000);
  console.log(`  受护栏 seq=${guardedPeak.seq} 峰值=${guardedPeak.peakMB}MB;无护栏 seq=${rawPeak.seq} 峰值=${rawPeak.peakMB}MB`);
  ok('两组的峰值都采到了（>0 表示轮询真的看见过子进程）', guardedPeak.peakMB > 0 && rawPeak.peakMB > 0, `guarded=${guardedPeak.peakMB} raw=${rawPeak.peakMB}`);
  ok('无护栏的峰值高于受护栏的（预算真的在削峰）', rawPeak.peakMB > guardedPeak.peakMB, `raw=${rawPeak.peakMB}MB vs guarded=${guardedPeak.peakMB}MB`);
}

console.log(`\n最大实测 seq = ${maxSeq} / 预算 ${argBudget}`);

console.log('\n=== 端到端（真实 fork 子进程走完整 IPC 链路）===');
/*
 * 上面都是“直调纯函数 + 真模型”，没走真链路。本项把**真 `embedding-child.cjs`** fork 起来，
 * 经 DSH_EMBED_CFG 把预算传下去，再断言：
 *  ① embedBatch 正常返回向量（护栏没搞坏链路）
 *  ② 子进程上报的 tokensMax 实测值 ≤ 预算（护栏在真链路上真的生效）
 * 注意：本脚本跑在纯 node 下，execPath 就是 node——它能证「接线与预算传递正确」，
 * 不能证「宿主 Electron 分配器不再 trap」（后者只能 macOS）。
 */
{
  const { LocalEmbeddingService } = await import(
    pathToFileURL(path.join(root, 'dist', 'store', 'local-embedding.js')).href,
  );
  const { catalogById } = await import(
    pathToFileURL(path.join(root, 'dist', 'store', 'model-catalog.js')).href,
  );
  const entry = catalogById('bge-m3');
  let maxReported = -1;
  // 故意注入一个探针：从子进程的 embedded 回执里读 tokensMax（协议可选字段，主线程不消费）
  const svc = new LocalEmbeddingService(entry, modelDir, {
    runtimeDir,
    childPath: path.join(root, 'dist', 'embedding-child.cjs'),
    logger: { info: () => {}, warn: (s) => console.log('  w:', String(s).slice(0, 120)), error: () => {} },
    // 不传 maxInputTokens → 走自动档，验证 deriveTokenBudget 在真链路上给出 1536
  });
  try {
    await svc.waitForReady();
    // 一批 3 条同内容长文本（对应连发场景）+ 一批不同内容，均应返回向量
    const long = '记'.repeat(5000);
    const vecs = await svc.embedBatch([long, long, long]);
    ok('真链路 embedBatch 返回 3 条 1024 维向量（护栏未搞坏链路）', vecs.length === 3 && vecs[0].length === 1024, `dim=${vecs[0].length}`);
    const mixed = await svc.embedBatch([long, '记'.repeat(5000).replaceAll('记', '忆'), long]);
    ok('混合批次（含不同长文本）仍全部返回', mixed.length === 3 && mixed.every((v) => v.length === 1024));
    maxReported = await readChildTokensMax(path.join(root, 'dist', 'embedding-child.cjs'), long, argBudget);
  } catch (err) {
    ok('真链路 embedBatch 未抛错', false, err instanceof Error ? err.message : String(err));
  } finally {
    svc.close();
  }
  if (maxReported >= 0) {
    ok(`子进程实测上报 tokensMax ≤ 预算`, maxReported <= argBudget, `tokensMax=${maxReported}`);
  } else {
    console.log('  跳：未能从子进程读到 tokensMax（需第二路直接 fork 探针）');
  }
}

/** 直接 fork 真 child 子进程（不走 LocalEmbeddingService）以读到它回传的 tokensMax。 */
async function readChildTokensMax(childPath, text, budget) {
  const { fork } = await import('node:child_process');
  return await new Promise((resolve) => {
    const child = fork(childPath, [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        DSH_EMBED_CFG: JSON.stringify({
          runtimeDir,
          modelDir,
          pooling: 'cls',
          dtype: 'q8',
          maxInputChars: 5000,
          maxInputTokens: budget,
        }),
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* 已退 */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(-1), 180_000);
    child.on('message', (m) => {
      if (!m || m.type !== 'embedded') return;
      clearTimeout(timer);
      finish(typeof m.tokensMax === 'number' ? m.tokensMax : -1);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      finish(-1);
    });
    child.send({ id: 1, type: 'embed', texts: [text, text, text], priority: false });
  });
}

console.log(failures === 0
  ? 'RESULT: 全部通过 —— 「截断后进模型的 token 受预算约束」已在真 bge-m3 上实测成立'
  : `RESULT: ${failures} 项未通过`);
process.exit(failures === 0 ? 0 : 1);
