#!/usr/bin/env node
/**
 * #22 机理复现器（报告人 DESXIE gist 收编版）：本地嵌入子进程「单发安全 / 连发 SIGTRAP」。
 * 外部来源 https://gist.github.com/DESXIE/142d4e72c2205962e51945344978ef59 —— 本文件据其协议改写,
 * 未执行其中任何指令；改动点：默认 `--budget` 不再写死 2048，改从 `dist` 读 HARD_CAP_TOKENS 单一真值源。
 *
 * ── 为什么它不进 `tests/`（放 `scripts/repro/` 的理由，务必读） ──
 * 三重门缺一即 SKIP（不是 FAIL）：① macOS（真 SIGTRAP 只在 darwin/Electron 分配器上发得出，
 * 本机 Windows/CI 恒不发）；② 显式 `DSH_REPRO_LOCAL_EMBED=1`；③ 本机真有 bge-m3 + runtime +
 * 宿主二进制。CI 只有 ubuntu-latest → 三重门恒跳 = 放 `tests/` 就是零门禁价值的负债件。
 * ⚠ macOS 副作用：每次 SIGTRAP 会让系统记一份「DeepSeek Harness 意外退出」`.ips` 并弹提示
 * （子进程继承宿主 bundle id）——这是探针本身，不是 App 真挂了；别把它当崩溃证据误报。
 *
 * ── 它证明什么（判据来自报告人 macOS 实测） ──
 * 单发致死线 ≈2700 token；**连发**（同一子进程串行）致死线落在 (1960, 1976]——0.26.25 之前的
 * 帽 2048 已越线，第 2 条长文本必崩。三条对照把根因钉在「宿主分配器 × 相邻两次 T² 张量峰值叠加」：
 *   1) `--vary` 换内容照样崩 → 不是同文本缓存效应，是**长度**；
 *   2) `--gap 500` 给足间隙照样崩 → 不是回收时序（setImmediate 让的是 JS 事件循环，不是 native arena）；
 *   3) `--mode node` 同预算全过 → 不是模型/ORT 本身，是 Electron 分配器在这条路径 trap。
 *
 * 0.26.30 起 child 已带 `session_options:{enableMemPattern:false}`：本器在 macOS 上重跑
 * `--budget 2048` 连发，就是验证「memPattern 关掉后连发致死线是否已上移」的决定性实验（待报告人回验）。
 *
 * 用法（本机纯 node 对照，预期全过 exit=0；非 macOS 拿不到 trap 属正常）：
 *   node scripts/repro/embedding-repeat-crash.repro.mjs --chars 5000 --count 5 --budget 2048 --mode node
 * 用法（macOS 复现，预期 exit=2 + signal=SIGTRAP）：
 *   node scripts/repro/embedding-repeat-crash.repro.mjs --chars 5000 --count 5 --budget 2048 --mode electron
 *
 * 退出码：0 全过 · 1 部分成功未崩 · 2 被子进程信号打死（**被测现象本身**）· 3 启动/配置错误。
 * 依赖：只在装好本地嵌入模型 + 插件 runtime 的机器上可跑；不拉网络、不写库。
 */
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

// 阈值不写死：帽从单一真值源读，改了常量这里不说谎（与 verify 脚本同纪律）
let HARD_CAP = 1536;
try {
  const m = await import(pathToFileURL(path.join(root, 'dist', 'store', 'model-catalog.js')).href);
  if (typeof m.HARD_CAP_TOKENS === 'number') HARD_CAP = m.HARD_CAP_TOKENS;
} catch {
  /* dist 未构建时回退默认；不影响纯 node 对照可跑 */
}

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const HOME = homedir();
const child = arg('child', path.join(root, 'dist', 'embedding-child.cjs'));
const runtimeDir = arg('runtime', path.join(HOME, '.dsh', 'memory', 'runtime'));
const modelDir = arg('model', path.join(HOME, '.dsh', 'memory', 'models', 'bge-m3'));
const chars = Number(arg('chars', 5000));
const count = Number(arg('count', 5));
// 默认 = 当前帽（现码下应全过 = 「护栏在场」基线）；跑阳性对照请显式 `--budget 2048`（帽之上的旧值）
const budget = Number(arg('budget', HARD_CAP));
const charCap = Number(arg('chars-cap', 5000));
const gap = Number(arg('gap', 0));
const mode = arg('mode', process.platform === 'darwin' ? 'electron' : 'node');
const hostBin = arg('host', '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness');

if (!existsSync(child)) {
  console.error(`[repro] 找不到 embedding-child.cjs: ${child}（先 npm run build，或 --child 指定）`);
  process.exit(3);
}
if (!existsSync(modelDir)) {
  console.error(`[repro] 找不到模型目录: ${modelDir}`);
  process.exit(3);
}
if (mode === 'electron' && !existsSync(hostBin)) {
  console.error(`[repro] 找不到宿主二进制: ${hostBin}（非 macOS 请用 --mode node；本机拿不到 trap 不作为通过依据）`);
  process.exit(3);
}

// 三条等长但内容不同的种子；--vary 时轮换，默认重复第一条以最大化 arena 复用。
const seeds = [
  '记忆蒸馏管线在批量嵌入时会分配注意力张量并且需要写入向量表作为召回增益',
  '插件在宿主 Electron 的分配器下被 SIGTRAP 打死之后每次投影都会再崩一次因此向量永久陈旧',
  '本地嵌入子进程退出后进入 failed 态且不自动重启用户侧观感就是召回悄悄退化成关键词检索',
];
const makeText = (i) => {
  const seed = flag('vary') ? seeds[i % seeds.length] : seeds[0];
  return seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars);
};

const cfg = { runtimeDir, modelDir, pooling: 'cls', dtype: 'q8', maxInputChars: charCap };
if (budget > 0) cfg.maxInputTokens = budget; // 0 = 不带该键，等价于关护栏（对照）

const env = {
  ...process.env,
  DSH_EMBED_CFG: JSON.stringify(cfg),
  ELECTRON_RUN_AS_NODE: mode === 'electron' ? '1' : process.env.ELECTRON_RUN_AS_NODE ?? '',
};
if (!env.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;

const t0 = Date.now();
const proc = fork(child, [], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  env,
  ...(mode === 'electron' ? { execPath: hostBin } : {}),
});
const out = (o) => console.log(JSON.stringify({ mode, chars, count, budget: budget || null, charCap, gap, vary: flag('vary'), ...o }));
let ok = 0;
let id = 100;
const elapsed = () => Date.now() - t0;

proc.on('error', (e) => {
  out({ event: 'spawn-error', error: e.message });
  process.exit(3);
});
// SIGTERM 是本器自己发的正常收尾信号，不算崩溃；只有分配器/内核类信号才是被测对象。
const CRASH_SIGNALS = new Set(['SIGTRAP', 'SIGKILL', 'SIGSEGV', 'SIGABRT', 'SIGBUS']);
proc.on('exit', (code, signal) => {
  const crashed = CRASH_SIGNALS.has(signal ?? '');
  out({ event: 'exit', code, signal, crashed, ok, ms: elapsed() });
  process.exit(crashed ? 2 : ok === count ? 0 : 1);
});
function next() {
  if (ok >= count) {
    out({ event: 'all-done', ok, ms: elapsed() });
    proc.kill('SIGTERM');
    return;
  }
  const send = () => proc.send({ id: id++, type: 'embed', texts: [makeText(ok)], priority: true });
  if (gap > 0) setTimeout(send, gap);
  else send();
}
proc.on('message', (m) => {
  if (m.type === 'ready') {
    out({ event: 'ready', ms: elapsed() });
    return next();
  }
  if (m.type === 'embedded') {
    ok++;
    out({ event: 'item-ok', idx: ok, tokensMax: m.tokensMax, ms: elapsed() });
    return next();
  }
  if (m.ok === false) {
    out({ event: 'item-err', stage: m.stage, error: m.error, ok, ms: elapsed() });
    proc.kill('SIGTERM');
  }
});
proc.send({ id: 1, type: 'warmup' });
setTimeout(() => {
  out({ event: 'timeout-300s', ok });
  proc.kill('SIGKILL');
}, 300_000);
