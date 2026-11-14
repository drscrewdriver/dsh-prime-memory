#!/usr/bin/env node
// Phase 4 四臂端到端 bench 编排(计划 T4.3):A=基线 / B=投射开 / C=外部开 / D=双开。
//
// **为什么脚本不自己切 profile**:memExport 与 ext_memory 的开关是宿主 profile
// (desktop-runtime/profile.yaml)里的事实,420 题必须在真机 DSH 宿主上跑;脚本
// 若偷偷改 profile,跑出来的数字就不知道是哪份配置的。所以四臂 = 四次显式执行,
// 每次要求调用方先把 profile 切到对应形态,并把形态写进 manifest 供事后审计。
//
// 用法:
//   一次性准备(用户先切 profile):
//     node bench/harness/quad-arm.mjs --arm baseline --mem-export off --ext-mode off --repeats 3
//     node bench/harness/quad-arm.mjs --arm md-on    --mem-export on  --ext-mode off --repeats 3
//     node bench/harness/quad-arm.mjs --arm ext-on   --mem-export off --ext-mode shadow-read --ext-drivers N --repeats 3
//     node bench/harness/quad-arm.mjs --arm both     --mem-export on  --ext-mode shadow-read --ext-drivers N --repeats 3
//   汇总(Δ ≤ ±5pp 判定由 compare.mjs 的噪声带给出):
//     node bench/harness/quad-arm.mjs --report
//
// 两系统同开时若 profile 里是 two-way,共存门控(T4.2)会在装配期降为 shadow-read
// 并在插件日志里 warn——manifest 的 ext-mode 请填**实际生效**的档位(脚本会对照
// arm=both 时拒绝 two-way,防止把"被降档的运行"标成双向)。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const quadDir = path.join(here, '..', 'results', 'quad');

function argOf(name, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

const arm = argOf('arm');
const report = process.argv.includes('--report');

function fail(msg) {
  console.error(`[quad-arm] ${msg}`);
  process.exit(2);
}

if (report) {
  const arms = ['baseline', 'md-on', 'ext-on', 'both'];
  const man = {};
  for (const a of arms) {
    const f = path.join(quadDir, `${a}.json`);
    if (!fs.existsSync(f)) fail(`缺少 ${a} 臂:先按用法跑完四臂(${f} 不存在)`);
    man[a] = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const baseline = man.baseline.outDir;
  console.log('[quad-arm] 四臂对比(基线 = baseline;Δ ≤ ±5pp 视为可控,由 compare.mjs 噪声带判定):');
  for (const a of arms.slice(1)) {
    console.log(`\n=== baseline vs ${a} (${man[a].memExport} / ${man[a].extMode}) ===`);
    const r = spawnSync(process.execPath, [path.join(here, 'compare.mjs'), baseline, man[a].outDir, '--out', path.join(quadDir, `compare-${a}.md`)], { stdio: 'inherit' });
    if (r.status !== 0) console.error(`[quad-arm] ${a} 对比失败(退出码 ${r.status}),其余臂继续`);
  }
  console.log(`\n[quad-arm] 明细: ${quadDir}/compare-*.md`);
  process.exit(0);
}

if (!['baseline', 'md-on', 'ext-on', 'both'].includes(arm ?? '')) {
  fail('--arm 必须是 baseline|md-on|ext-on|both(或 --report)');
}
const memExport = argOf('mem-export');
const extMode = argOf('ext-mode') ?? 'off';
if (memExport !== 'on' && memExport !== 'off') fail('--mem-export 必须是 on|off(反映 profile 里的实际值)');
if (arm === 'both' && extMode === 'two-way') {
  fail('arm=both 且 ext-mode=two-way:共存门控会把 two-way 降为 shadow-read(T4.2),请填实际生效档位');
}

// 透传除本脚本私有参数外的其它参数给 run.mjs(A 组带记忆、repeats 取均值)
const passthrough = process.argv.slice(2).filter((a, i, all) => {
  if (a === '--arm' || a === '--mem-export') return false;
  const prev = all[i - 1];
  return prev !== '--arm' && prev !== '--mem-export';
});
const runArgs = [path.join(here, 'run.mjs'), '--arm', 'A', ...passthrough];

fs.mkdirSync(quadDir, { recursive: true });
const manifestPath = path.join(quadDir, `${arm}.json`);
const startedAt = new Date().toISOString();
console.log(`[quad-arm] 臂=${arm} memExport=${memExport} extMode=${extMode}`);
console.log(`[quad-arm] 即将执行: node ${runArgs.join(' ')}`);
const r = spawnSync(process.execPath, runArgs, { stdio: 'inherit' });
if (r.status !== 0) fail(`run.mjs 退出码 ${r.status}(本臂不登记)`);

// 输出目录:run.mjs 缺省 bench/results/run-A-<时间戳>;取最新的 run-A-* 作为本臂产物
const resultsDir = path.join(here, '..', 'results');
const candidates = fs.existsSync(resultsDir)
  ? fs.readdirSync(resultsDir).filter((d) => d.startsWith('run-A-')).sort()
  : [];
const outDir = candidates.length === 0 ? undefined : path.join(resultsDir, candidates[candidates.length - 1]);
if (outDir === undefined) fail('run.mjs 完成但找不到产物目录(run-A-*)');
fs.writeFileSync(manifestPath, JSON.stringify({ arm, memExport, extMode, startedAt, outDir, runArgs: runArgs.slice(1) }, null, 2));
console.log(`[quad-arm] 已登记 ${manifestPath} → ${outDir}`);
