#!/usr/bin/env node
/**
 * 真机冒烟核验点（issue #20 / #23 / #24 / #27 修复的装机后验证）
 *
 * 用法：
 *   node scripts/verify-desktop-smoke.mjs            # 自动发现宿主监听口并探测
 *   node scripts/verify-desktop-smoke.mjs --port 6910
 *
 * 它验的是**宿主侧可达性**（不需要模型参与）：
 *   A. 装机版本与关键修复是否在产物里（interpolate:false / mergeRoomCatalog / origin 探针）
 *   B. 宿主 webServer 的实际监听口（桌面端是随机口；旧代码写死 8080 必然 ECONNREFUSED）
 *   C. collector 路由的响应码归属 —— 这一步直接定论 issue #20 是否只差端口
 *
 * C 的判读（脚本会打印结论）：
 *   200            → 路由对无凭据请求放行：#20 的端口修复即充分
 *   401            → 宿主 pre-dispatch 鉴权闸在拦：光修端口不够，需追加读路改法
 *                     （注意：外部请求无 cookie，故 401 不能等价推出插件内部也 401，
 *                      但插件侧同样不带 cookie，形状一致，是强指示）
 *   403 forbidden  → collector 自身 trustedHosts 门在拦（本机未配则不应出现）
 *   ECONNREFUSED   → 端口没找对，或宿主没在跑
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const INSTALLED = path.join(PROFILE, 'node_modules', 'dsh-prime-memory');
const COLLECTOR_PATH = '/api/dsh-reference-session-collector';
const EXPECTED_VERSION = '0.26.21';

const argv = process.argv.slice(2);
const portFlag = (() => {
  const i = argv.indexOf('--port');
  return i >= 0 ? Number(argv[i + 1]) : undefined;
})();

let failures = 0;
const pass = (label, detail = '') => console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`);
const fail = (label, detail = '') => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`);
};
const info = (label, detail = '') => console.log(`  ----  ${label}${detail ? '  ' + detail : ''}`);

// ── A. 装机产物核验 ─────────────────────────────────────────────
console.log('\n[A] 装机产物');
if (!fs.existsSync(INSTALLED)) {
  fail('未找到已安装的 dsh-prime-memory', INSTALLED);
} else {
  const pkg = JSON.parse(fs.readFileSync(path.join(INSTALLED, 'package.json'), 'utf8'));
  const profilePkg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'));
  (pkg.version === EXPECTED_VERSION ? pass : fail)(
    `已装版本 = ${pkg.version}`,
    `profile pin = ${profilePkg.dependencies['dsh-prime-memory']}`,
  );
  const read = (rel) => {
    const p = path.join(INSTALLED, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  const recall = read('dist/hooks/recall.js');
  (/\binterpolate\s*:\s*false/.test(recall) ? pass : fail)(
    '#24 修复在产物里',
    'dist/hooks/recall.js interpolate:false',
  );
  const roomReview = read('dist/room-review.js');
  (/mergeRoomCatalog/.test(roomReview) ? pass : fail)('#27 取数单点（mergeRoomCatalog）在产物里');
  (/getOrigin/.test(roomReview) || /getOrigin/.test(read('dist/clients/web-server-origin.js')) ? pass : fail)(
    '#20 origin 探针（getOrigin 优先）在产物里',
  );
  const drsc = read('dist/clients/drsc.js');
  (/withScheme/.test(drsc) ? pass : fail)('#20 基址规范化 withScheme 在产物里');
  const tools = read('dist/tools/index.js');
  (/winner_maturity/.test(tools) && /loser_maturity/.test(tools) ? pass : fail)(
    '#23 schema 已声明 winner_maturity / loser_maturity',
  );
  // #20 追加修复：读面已从 HTTP 改为进程内直调 collector 只读面。
  const inproc = read('dist/clients/drsc-inproc.js');
  (/callCollectorRead/.test(inproc) && /dsh-reference-session-collector/.test(inproc) ? pass : fail)(
    '#20 追加修复：进程内读适配器在产物里',
  );
  const client = read('dist/clients/drsc.js');
  (/drsc-inproc/.test(client) ? pass : fail)('#20 客户端已接线到进程内面（不再缺省走 HTTP）');
  const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
  info('dist/room-review.js sha256', sha(roomReview));
}

// ── B. 宿主监听口发现 ───────────────────────────────────────────
console.log('\n[B] 宿主监听口');
let ports = [];
if (portFlag) {
  ports = [portFlag];
} else {
  try {
    // 固定命令 + argv 数组，不经 shell，无元字符注入面
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    const tasklist = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8' },
    );
    const pids = new Set(
      tasklist
        .split('\n')
        .map((l) => l.split('","'))
        .filter((c) => c.length >= 3)
        .map((c) => c[1].replace(/"/g, '')),
    );
    ports = [
      ...new Set(
        out
          .split('\n')
          .map((l) => l.trim().split(/\s+/))
          .filter((c) => c[0] === 'TCP' && c[3] === 'LISTENING' && c[1].startsWith('127.0.0.1:') && pids.has(c[4]))
          .map((c) => Number(c[1].split(':')[1])),
      ),
    ].sort((a, b) => a - b);
  } catch {
    info('netstat/tasklist 探测失败，改用 --port 指定');
  }
}
if (ports.length === 0) {
  fail('未发现宿主监听口（宿主可能没在跑）', '启动桌面端后重试，或 --port <n>');
} else {
  pass(`宿主监听口 = ${ports.join(',')}`, '桌面端为随机口；非 8080 即说明旧写死基址必败');
  (ports.includes(8080) ? fail : pass)('8080 未被本宿主占用');
}

// ── C. collector 路由归属判定 ───────────────────────────────────
console.log('\n[C] collector 路由（定论 #20 是否只差端口）');
const probe = async (port) => {
  const url = `http://127.0.0.1:${port}${COLLECTOR_PATH}?op=sessions&limit=1`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const body = (await res.text()).slice(0, 120);
    return { status: res.status, body };
  } catch (e) {
    return { status: null, body: String(e && e.cause?.code || e.message).slice(0, 80) };
  }
};
for (const port of ports) {
  const { status, body } = await probe(port);
  const line = `port ${port} -> ${status ?? 'ERR'} ${body}`;
  if (status === 200) pass('路由对无凭据请求放行', line);
  else if (status === 401)
    fail('宿主 pre-dispatch 鉴权闸在拦（无 cookie → 401）', line + ' ⇒ 需追加读路改法（进程内直调 collector）');
  else if (status === 403) fail('collector 自身 trustedHosts 门在拦', line);
  else info('探测结果', line);
}

console.log(`\n${failures === 0 ? 'RESULT: 全部通过' : `RESULT: ${failures} 项未通过`}`);
process.exit(failures === 0 ? 0 : 1);
