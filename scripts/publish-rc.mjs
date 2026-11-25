#!/usr/bin/env node
/**
 * publish-rc.mjs — rc 验证版本地兜底发布器（prerelease 双路径流水线的备用通道）。
 *
 * 正常节奏不需要它：push `prerelease` 分支后由 release.yml 的 rc 通道自动
 * `npm publish --tag rc`。本脚本用于两种场景：
 *   ① CI 的 NPM_TOKEN 不可用 / 网络受限，需要本地手发；
 *   ② 想一次跑完「bump → 门禁 → 推送 → 等 CI → 缺席则手发 → registry 验证」的闭环。
 *
 * 用法：
 *   node scripts/publish-rc.mjs 0.27.9-rc.0            # 全流程
 *   node scripts/publish-rc.mjs 0.27.9-rc.0 --dry      # 只打印计划
 *   node scripts/publish-rc.mjs 0.27.9-rc.0 --skip-gates --yes  # 赶时间：跳门禁、不等 CI 直接发
 *
 * 红线：
 * - 版本号必须含 `-rc.`（正式号一律走 PR 合并 main → GHA，不经本脚本）；
 * - package.json 与 dsh.plugin.json 双清单必须同值（版本对齐门禁同口径）；
 * - 只 `--tag rc`，绝不触碰 latest / dsh-* 线标签。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REG = 'https://registry.npmjs.org';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const skipGates = argv.includes('--skip-gates');
const noWait = argv.includes('--yes');
const version = argv.find((a) => !a.startsWith('--'));

const die = (msg) => { console.error(`[publish-rc] ${msg}`); process.exit(1); };
const log = (msg) => console.log(`[publish-rc] ${msg}`);
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true, ...opts });
const capture = (cmd, args) => {
  try { return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};

// ── 0. 参数与清单校验 ──────────────────────────────────────────────
if (!version) die('用法: node scripts/publish-rc.mjs <x.y.z-rc.N> [--dry] [--skip-gates] [--yes]');
if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(version)) die(`版本 ${version} 不是 -rc.N 预发号；正式号请走 PR 合并 main`);

const pkgPath = path.join(ROOT, 'package.json');
const pluginPath = path.join(ROOT, 'dsh.plugin.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const plugin = fs.existsSync(pluginPath) ? JSON.parse(fs.readFileSync(pluginPath, 'utf8')) : null;
if (pkg.version === version && (!plugin || plugin.version === version)) {
  log(`版本清单已是 ${version}，跳过 bump`);
} else if (plugin && plugin.version !== pkg.version) {
  die(`双清单现值已漂移（package.json=${pkg.version} / dsh.plugin.json=${plugin.version}），先手工对齐`);
} else if (dry) {
  log(`bump: ${pkg.version} -> ${version}（package.json + dsh.plugin.json）`);
} else {
  const bumped = JSON.stringify(JSON.parse(fs.readFileSync(pkgPath, 'utf8')), null, 2);
  fs.writeFileSync(pkgPath, bumped + '\n');
  if (plugin) {
    const bumpedPlugin = JSON.stringify(JSON.parse(fs.readFileSync(pluginPath, 'utf8')), null, 2);
    fs.writeFileSync(pluginPath, bumpedPlugin + '\n');
  }
  log(`bump: ${pkg.version} -> ${version}（双清单同源）`);
}
const name = pkg.name;

// ── 1. 门禁（复刻 release.yml ③ 的本地等价序列） ──────────────────
if (skipGates || dry) {
  log(skipGates ? '跳过门禁（--skip-gates）' : 'dry 模式不跑门禁');
} else {
  for (const step of ['typecheck', 'test', 'lint', 'build', 'build:smoke', 'smoke']) {
    log(`门禁: npm run ${step}${step === 'test' ? ' -- --no-file-parallelism' : ''}`);
    const extra = step === 'test' ? ['--', '--no-file-parallelism'] : [];
    sh('npm', ['run', step, ...extra]);
  }
  log('门禁: verify-catalog');
  sh('node', ['scripts/verify-catalog.mjs']);
}

// ── 2. 提交并推送 prerelease（CI 见到 -rc. 号即走 rc 通道） ────────
const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'prerelease') log(`⚠ 当前分支是 ${branch}，预期 prerelease（rc 不应来自 main）`);
if (dry) {
  log(`dry: git add 双清单 + commit "chore(release): ${version}" + push origin ${branch || 'prerelease'}`);
} else if (process.env.PUBLISH_RC_NO_PUSH === '1') {
  log('PUBLISH_RC_NO_PUSH=1，跳过提交推送（调用方自理）');
} else {
  sh('git', ['add', 'package.json', 'dsh.plugin.json']);
  const dirty = capture('git', ['status', '--porcelain']);
  if (dirty) {
    log('工作区还有其它改动，一并纳入本次 rc 提交：');
    console.log(dirty);
    sh('git', ['add', '-A']);
  }
  sh('git', ['commit', '-m', `chore(release): ${name}@${version} (rc)`]);
  sh('git', ['push', 'origin', branch || 'prerelease']);
}

// ── 3. 等 CI 发版；缺席则本地兜底 publish ─────────────────────────
const publishedVer = () => capture('npm', ['view', `${name}@${version}`, 'version', '--registry', REG]);
if (dry) {
  log('dry: 跳过发布与验证');
  process.exit(0);
}
if (!noWait) {
  log('等待 CI rc 通道发布（最多 10 分钟，每 60s 探测一次 registry）…');
  for (let i = 0; i < 10; i++) {
    if (publishedVer()) break;
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
if (publishedVer()) {
  log(`CI 已发布 ${version}，本地不重发`);
} else {
  log('CI 未见发布痕迹 → 本地兜底 npm publish --tag rc');
  sh('npm', ['publish', '--tag', 'rc', '--registry', REG]);
}

// ── 4. registry 内容级验证（直连官方源，不信镜像） ────────────────
const inRegistry = publishedVer();
if (!inRegistry) die('发布后 registry 仍查不到该版本（可能有读侧滞后，≥9 分钟后复核）');
const tags = capture('npm', ['view', name, 'dist-tags', '--json', '--registry', REG]);
const dist = tags ? JSON.parse(tags) : {};
const sha = capture('npm', ['view', `${name}@${version}`, 'dist.shasum', '--registry', REG]);
const okRc = dist.rc === version;
const latestKept = dist.latest !== version;
log(`versions ✓ ${inRegistry} | rc=${dist.rc || '-'} ${okRc ? '✓' : '✗'} | latest=${dist.latest || '-'} ${latestKept ? '✓(未动)' : '✗(被顶!)'} | shasum=${sha || '-'}`);
if (!okRc || !latestKept) die('dist-tag 校验未通过，立即人工介入');
log(`完成：${name}@${version} 已挂在 rc 通道。装机验证: pnpm add ${name}@${version}`);
