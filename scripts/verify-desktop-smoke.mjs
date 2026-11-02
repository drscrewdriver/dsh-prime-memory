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
import { pathToFileURL } from 'node:url';

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const INSTALLED = path.join(PROFILE, 'node_modules', 'dsh-prime-memory');
// 只校主minor 与预期同族，不钉死补丁号：否则每发一版都要改本脚本（上一版就踩了）。
const EXPECTED_FAMILY = '0.26.';

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
  (pkg.version.startsWith(EXPECTED_FAMILY) ? pass : fail)(
    `已装版本 = ${pkg.version}`,
    `profile pin = ${profilePkg.dependencies['dsh-prime-memory']}（预期同 ${EXPECTED_FAMILY}x）`,
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

// ── C. 进程内读路端到端（#20 追加修复的真判据）─────────────────
// 注意：这里**不再探 HTTP**。桌面宿主的 pre-dispatch 鉴权对无 cookie 请求永远回
// 401，而我们已故意改走进程内直调——拿 401 当失败是旧判据残留（它只证明闸还在，
// 不说明功能坏）。真判据是：用装机件 + 真 collector 模块读一次，拿到非空结果。
console.log('\n[C] 进程内读路端到端（装机件驱动真索引库）');
const COLLECTOR_ENTRY = path.join(
  PROFILE, 'node_modules', 'dsh-reference-session-collector', 'lib', 'index.js',
);
if (!fs.existsSync(COLLECTOR_ENTRY)) {
  fail('未装 collector，进程内读路无从验证', COLLECTOR_ENTRY);
} else {
  try {
    const adapter = await import(pathToFileURL(path.join(INSTALLED, 'dist/clients/drsc-inproc.js')).href);
    const { DrscClient } = await import(pathToFileURL(path.join(INSTALLED, 'dist/clients/drsc.js')).href);
    const real = await import(pathToFileURL(COLLECTOR_ENTRY).href);
    adapter.resetCollectorReadState();
    const client = new DrscClient({ read: (q) => adapter.callCollectorRead(q, async () => real) });

    // 重试封装：0.26.24 起，对端已升版但拿不到门面时会先做**有界重试**（前 3 次抛错），
    // 预算耗尽才回退自开只读库。本脚本跑在**宿主外**，没人 apply() collector，因此一定
    // 走回退路；只做一次读会撞在重试窗口里得到假失败。重试至多 6 次（>3 即可穿过去）。
    const readWithRetry = async (label, run) => {
      let lastErr;
      for (let i = 0; i < 6; i++) {
        try {
          return await run();
        } catch (err) {
          lastErr = err;
          const m = /第 (\d+)\/(\d+) 次重试/u.exec(String(err && err.message));
          if (!m) break; // 非重试类错误，直接报
        }
      }
      fail(`${label} 异常`, String(lastErr && lastErr.message));
      return undefined;
    };

    const hits = await readWithRetry('search', () => client.search('\u7aef\u53e3', 3));
    if (hits) {
      (hits.length > 0 ? pass : fail)(`search \u2192 ${hits.length} \u547d\u4e2d`,
        hits[0] ? `snippet ${JSON.stringify(String(hits[0].snippet).slice(0, 40))}` : '\uff08\u7a7a\uff09');
    }

    const listed = await readWithRetry('listSessions', () => client.listSessions(0, 5));
    if (listed) {
      (listed.total > 0 && listed.rows.length > 0 ? pass : fail)(
        `listSessions \u2192 total=${listed.total} rows=${listed.rows.length}`,
      );
    }

    // 挑「真挂到记录」的会话而不是列表首项：最新会话常无 user/assistant 段，
    // 用它会得到 0 行——那是弱断言（空也算 PASS）。
    const richest = [...listed.rows].sort((a, b) => (b.event_count ?? 0) - (a.event_count ?? 0))[0];
    if (richest?.session_id) {
      const tail = await client.sessionTail(richest.session_id, 4);
      (tail.length > 0 ? pass : fail)(
        `sessionTail \u2192 ${tail.length} \u884c`,
        tail[0] ? `role=${tail[0].role || '(empty)'} kind=${tail[0].kind}` : '\uff08\u7a7a\uff09',
      );
    }
    pass('\u5168\u7a0b\u672a\u53d1\u4e00\u4e2a HTTP \u8bf7\u6c42\uff08\u4e0d\u518d\u4f9d\u8d56\u5bbf\u4e3b\u76d1\u542c\u53e3\u4e0e\u9274\u6743\uff09');
  } catch (e) {
    fail('\u8fdb\u7a0b\u5185\u8bfb\u8def\u5f02\u5e38', String(e && e.message).slice(0, 160));
  }
}

console.log(`\n${failures === 0 ? 'RESULT: \u5168\u90e8\u901a\u8fc7' : `RESULT: ${failures} \u9879\u672a\u901a\u8fc7`}`);
process.exit(failures === 0 ? 0 : 1);
