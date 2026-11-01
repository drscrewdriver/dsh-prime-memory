// 独立取证：复核本批三条结论的数字来源。只读，不写任何库。
//   node scripts/verify-claims.mjs
// 退出码 0 = 三条判据与预期一致；非 0 = 有偏差（会打印实际值）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const INST = path.join(PROFILE, 'node_modules', 'dsh-prime-memory');
const COLLECTOR = path.join(PROFILE, 'node_modules', 'dsh-reference-session-collector', 'lib', 'index.js');

let bad = 0;
const say = (ok, label, detail) => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'OK  ' : 'DIFF'}  ${label}${detail ? '  ' + detail : ''}`);
};

// ── [A] 蒸馏背景窗：sessionTail 必须非空且 kind 分布含 user/assistant ──
console.log('\n[A] 蒸馏背景窗（装机件驱动真索引库）');
const adapter = await import(pathToFileURL(path.join(INST, 'dist/clients/drsc-inproc.js')).href);
const { DrscClient, drscRoleOf } = await import(pathToFileURL(path.join(INST, 'dist/clients/drsc.js')).href);
const real = await import(pathToFileURL(COLLECTOR).href);
adapter.resetCollectorReadState();
const client = new DrscClient({ read: (q) => adapter.callCollectorRead(q, async () => real) });

const { rows, total } = await client.listSessions(0, 200);
console.log(`  listSessions: total=${total} rows=${rows.length}`);
const ranked = [...rows].sort((a, b) => (b.event_count ?? 0) - (a.event_count ?? 0));
const kinds = new Map();
let nonEmpty = 0;
const probeN = Math.min(6, ranked.length);
for (const r of ranked.slice(0, probeN)) {
  const tail = await client.sessionTail(r.session_id, 40);
  if (tail.length > 0) nonEmpty += 1;
  for (const row of tail) kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
}
const dist = [...kinds].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ');
console.log(`  top-${probeN} 大会话 sessionTail(40) kind 分布: ${dist}`);
say(nonEmpty === probeN && probeN > 0, `背景窗非空 ${nonEmpty}/${probeN}`, '（0 说明读路又断了）');
say((kinds.get('user/message') ?? 0) > 0 && (kinds.get('assistant/message') ?? 0) > 0,
  'kind 分布含 user 与 assistant 段');

const bigTail = await client.sessionTail(ranked[0].session_id, 400);
const mapped = bigTail.filter((r) => drscRoleOf(r.kind) !== undefined).length;
console.log(`  最大会话 ${bigTail.length} 行中可映射 user/assistant = ${mapped}`);
say(mapped > 0, '角色映射产出 > 0', '（为 0 则蒸馏拿不到任何背景消息）');

// ── [B] 字面 {{X}} 的全库分布（注意：这不等于 #24 的正验前提）──
console.log('\n[B] 字面 {{X}} 扫描（全库计数，口径见下方告警）');
const TOK = /\{\{[A-Za-z_][A-Za-z0-9_]{0,24}\}\}/g;
let files = 0;
let all = 0;
let upper = 0;
for (const dir of [path.join(os.homedir(), '.dsh', 'memory')]) {
  if (!fs.existsSync(dir)) { console.log('  数据目录不存在', dir); break; }
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, String(f));
    if (!fs.statSync(p).isFile() || !/\.(db|jsonl|json|md)$/.test(p)) continue;
    let txt;
    try { txt = fs.readFileSync(p).toString('utf8'); } catch { continue; }
    const m = txt.match(TOK);
    if (!m) continue;
    files += 1;
    all += m.length;
    const u = m.filter((x) => /[A-Z]/.test(x.slice(2, -2)));
    upper += u.length;
    console.log(`  ${p.replace(os.homedir(), '~')}  共 ${m.length}，大写形 ${u.length}`);
    console.log(`    样例 ${[...new Set(m)].slice(0, 5).join(' ')}`);
  }
}
console.log(`  合计：${files} 个文件、${all} 个 token、其中大写形 ${upper}（大写会先抛 malformed，而非 unknown variable）`);
say(all > 0, '库内确实存在字面 {{X}} 形态文本');
console.log('  ⚠ 口径告警：以上是**全库**计数。#24 的正验前提是「**memory:profile 注入文本**含字面 token」，');
console.log('    需读 persona/L3 存储单独判定，不能由本段数字推出。');

// ── [C] #24 真前提：用桩 ctx 载装机副本，现算 memory:profile 的注入文本 ──
// 方法：不启动宿主，直接 import 装机 lib/index.js 取 apply；只放行 tools/systemPrompt
// 两个注入面，其余给深层宽容代理（否则 apply 会在到达注册前就抛）。
console.log('\n[C] memory:profile 注入文本（#24 正验的真前提）');
function lenient() {
  const p = new Proxy(function () {}, {
    get(_t, k) {
      if (k === 'then' || k === 'catch' || k === 'finally') return undefined; // 防被当 thenable
      if (typeof k === 'symbol') return Reflect.get({}, k);
      return p;
    },
    has() { return true; },
    apply() { return p; },
  });
  return p;
}
const captured = [];
try {
  const mod = await import(pathToFileURL(path.join(INST, 'dist/index.js')).href);
  const sctx = {
    effect: (fn) => (typeof fn === 'function' ? undefined : undefined),
    tools: { register: () => () => {}, restrict: () => lenient() },
    systemPrompt: {
      context: (c) => { captured.push(c); return () => {}; },
      section: (s) => { captured.push(s); return () => {}; },
      variable: () => () => {},
      getSectionOrder: () => 0,
    },
    slots: { inject: () => () => {} },
    settings: lenient(),
    get: () => lenient(),
  };
  const ctx = {
    inject: (deps, fn) => {
      const want = Array.isArray(deps) ? deps : [deps];
      const ok = want.every((d) => d === 'tools' || d === 'systemPrompt' || d === 'logger');
      if (ok && typeof fn === 'function') { try { fn(sctx); } catch { /* 局部注册失败不影响已捕获项 */ } }
      return () => {};
    },
    plugin: () => () => {},
    on: () => () => {},
    effect: (fn) => (typeof fn === 'function' ? undefined : undefined),
    systemPrompt: sctx.systemPrompt,
    tools: sctx.tools,
    get: sctx.get,
  };
  // agent 身份就是 sessionId（插件内 agent.id === sessionId），但桩 ctx 未走到会话分支，
  // 此处不需传会话上下文。
  try { await mod.apply?.(ctx); } catch { /* 装配尾部依赖真实服务，抛出可忽略 */ }
  try { mod.default?.apply?.(ctx); } catch { /* 同上：两种导出形态都试 */ }

  const prof = captured.find((c) => c?.name === 'memory:profile');
  if (!prof) {
    console.log('  未捕获到 memory:profile（已捕获：' + (captured.map((c) => c?.name).join(',') || '无') + '）');
    console.log('  → 桩 ctx 未走到记忆装配分支，改走人工判据（见下）');
  } else {
    let text = typeof prof.text === 'function' ? prof.text({}) : prof.text;
    if (text && typeof text.then === 'function') text = '(provider 返回非同步文本)';
    text = String(text ?? '');
    const hits = text.match(TOK) ?? [];
    const up = hits.filter((x) => /[A-Z]/.test(x.slice(2, -2)));
    console.log(`  interpolate 声明 = ${JSON.stringify(prof.interpolate)}（应为 false）`);
    console.log(`  现算文本长度 = ${text.length} 字；内含字面 {{X}} = ${hits.length} 个（大写形 ${up.length}）`);
    if (hits.length) console.log(`    样例 ${[...new Set(hits)].slice(0, 6).join(' ')}`);
    say(prof.interpolate === false, 'memory:profile 已带 interpolate:false');
    if (hits.length > 0) {
      say(true, '#24 正验条件成立：注入文本真含字面 token', '→ 无 interpolate:false 时宿主必抛');
    } else {
      console.log('  ⚠ 本会话画像无字面 token：#24 属「条件未触发」，不能声称已正验');
    }
  }
} catch (e) {
  console.log('  桩 ctx 装载失败:', String(e && e.message).slice(0, 140));
  // 已知成因：本插件 dist 会 import 宿主一方包（@deepseek-ai/dsh-home-paths 等），
  // 这类包由 Electron 运行时提供、**不在 profile 的 node_modules 里**，所以
  // 「桩 ctx 载装机副本」对本插件不成立（不同于只依赖 cordis 面的插件）。
  console.log('  已知限制：本插件 dist 依赖宿主一方包（如 @deepseek-ai/dsh-home-paths），');
  console.log('  该类包由 Electron 运行时提供、不在 profile node_modules 内 → 桩 ctx 法不适用于本插件。');
  console.log('  人工判据：面板看 L3 画像正文是否含 {{...}}，或调 POST /dsh-memory/rpc/persona 取文本后 grep。');
}

console.log(`\nRESULT: ${bad === 0 ? '与预期一致' : `${bad} 项偏差`}`);
process.exit(bad === 0 ? 0 : 1);
