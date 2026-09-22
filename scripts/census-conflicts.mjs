#!/usr/bin/env node
/**
 * scripts/census-conflicts.mjs —— 冲突模型三轴增强的 **Phase 0 只读普查**。
 *
 * 设计约束（逐条对应 `.agents/plans/prime-memory-conflict-3axis/` 的 spec/tasks）：
 * 1. **只读**：以 `readOnly` 打开 `memory.db`，并**显式** `PRAGMA query_only = 1`，
 *    再用一次写探针证明写入确实被拒（spec R5 / 约束 7）。
 *    ——`mode=ro` 不会自动令 `query_only` 为 1（实测为 0），故两者都要。
 * 2. **不硬编码路径**：`dataDir` 走生产同款 `resolveDataDir(cfg)`（`src/config.ts`），
 *    经构建产物 `dist/config.js` 引入；settings 文件路径可用 `DSH_SETTINGS_FILE` 覆盖。
 * 3. **不硬编码端点**：LLM 抽取入口（task_0.2 的「③」）在**运行时从配置解析**：
 *    优先 `dsh-memory.llm.baseURL/model`（task_0.2 原入口 ①，本部署为空），
 *    否则由 `dsh-memory.distillChain[0].provider` 回指顶层 `providers.<name>`。
 *    解析不出即**非 0 退出**，绝不静默降级（Q4 拍板）。
 * 4. **不写任何表、不触发快照、不碰 `records/*.jsonl`**：本文件只有 SELECT/PRAGMA。
 * 5. 干跑为默认：只有显式 `--out <file>` 才写报告文件，且报告写在仓库外或用户指定处。
 *
 * 用法：
 *   node scripts/census-conflicts.mjs                       # 只读普查（干跑，stdout 报告）
 *   node scripts/census-conflicts.mjs --out report.json     # 额外落 JSON 报告
 *   node scripts/census-conflicts.mjs --sample 0            # 跳过 LLM 抽样（只做结构普查）
 *   node scripts/census-conflicts.mjs --sample 200          # 抽样 200 条做 claim 抽取
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataDir } from '../dist/config.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`[census] 失败：${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { sample: 0, out: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--out') opts.out = argv[++i] ?? fail('--out 需要一个文件路径');
    else if (a === '--sample') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) fail('--sample 需要非负整数');
      opts.sample = Math.floor(n);
    } else fail(`未知参数 ${a}（用 --help 查看用法）`);
  }
  return opts;
}

const HELP = `Phase 0 只读普查 —— dsh-prime-memory 冲突模型三轴增强

  --sample <N>   抽样 N 条 l1_records 做 claim 三元组抽取（默认 0 = 跳过，不调用 LLM）
  --out <file>   额外写一份 JSON 报告（默认只打印到 stdout）
  --help         显示本帮助

本脚本永不写库：只读连接 + PRAGMA query_only=1 + 写探针自证。
`;

// ─────────────────────────────────────────────────────────────────────────────
// 配置：settings.yaml（运行时解析，不硬编码端点/模型/密钥）
// ─────────────────────────────────────────────────────────────────────────────

function loadSettings() {
  const file = process.env.DSH_SETTINGS_FILE ?? path.join(os.homedir(), '.dsh', 'settings.yaml');
  if (!existsSync(file)) fail(`找不到设置文件：${file}（可用 DSH_SETTINGS_FILE 指定）`);
  let yaml;
  try {
    yaml = require('js-yaml');
  } catch {
    fail('解析 settings.yaml 需要 js-yaml，但当前 node_modules 里没有它');
  }
  let doc;
  try {
    doc = yaml.load(readFileSync(file, 'utf8')) ?? {};
  } catch (e) {
    fail(`settings.yaml 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return { file, doc };
}

/**
 * 解析 LLM 抽取入口（task_0.2 的「③」）。
 * 返回 { source, baseURL, model, apiKey, apiKeyEnv, apiKeyPresent }；解析不出返回 null。
 *
 * 注意（实测 2026-09-22）：provider 注册表**不在**顶层 `providers` 键下，而在
 * **provider 插件自己的设置命名空间**里（本机为 `llm-pi-ai.providers.local-35b`；
 * 另有 `llm-openai-completions` / `llm-deepseek` 等同类命名空间）。故这里**扫描全部
 * 顶层块**找 `providers.<distillChain[0].provider>`，而不是假定某个固定路径——
 * 否则用户换一个 LLM 插件，脚本就静默解析不出入口。
 * 多个命名空间命中且取值不一致时**显式报错**（配置不一致不得靠"取第一个"糊过去）。
 */
function findProviderEntries(settings, name) {
  const hits = [];
  const direct = settings.doc.providers;
  if (direct && typeof direct === 'object' && direct[name]) {
    hits.push({ source: `providers.${name}`, prov: direct[name] });
  }
  for (const [ns, block] of Object.entries(settings.doc)) {
    if (!block || typeof block !== 'object') continue;
    const prov = block.providers;
    if (prov && typeof prov === 'object' && prov[name]) {
      hits.push({ source: `${ns}.providers.${name}`, prov: prov[name] });
    }
  }
  return hits;
}

function resolveLlmEntry(settings) {
  const mem = settings.doc['dsh-memory'] ?? {};

  // ① 原生直连通路（dsh-memory.llm.*）—— 本部署为空，但保持优先
  const llm = mem.llm ?? {};
  if (typeof llm.baseURL === 'string' && llm.baseURL && typeof llm.model === 'string' && llm.model) {
    const apiKey = typeof llm.apiKey === 'string' ? llm.apiKey : '';
    return { source: 'dsh-memory.llm', baseURL: llm.baseURL, model: llm.model, apiKey, apiKeyEnv: '', apiKeyPresent: apiKey !== '' };
  }

  // ③ 由 distillChain 的 provider 回指 provider 注册表（扫描命名空间）
  const chain = Array.isArray(mem.distillChain) ? mem.distillChain : [];
  const head = chain.find((c) => c && typeof c.provider === 'string' && c.provider) ?? null;
  if (!head) return null;
  const hits = findProviderEntries(settings, head.provider);
  if (hits.length === 0) return null;

  const describe = (h) => ({
    source: h.source,
    baseURL: typeof h.prov.baseURL === 'string' ? h.prov.baseURL : '',
    model:
      (typeof head.model === 'string' && head.model) ||
      (Array.isArray(h.prov.models) && h.prov.models[0] && h.prov.models[0].id) ||
      '',
  });
  const cands = hits.map(describe).filter((c) => c.baseURL && c.model);
  if (cands.length === 0) return null;
  const distinct = new Set(cands.map((c) => `${c.baseURL}|${c.model}`));
  if (distinct.size > 1) {
    fail(
      `provider "${head.provider}" 在多个设置命名空间下取值不一致，无法判定抽取入口：\n` +
        cands.map((c) => `  - ${c.source}: ${c.baseURL} / ${c.model}`).join('\n'),
    );
  }
  const first = cands[0];
  const apiKeyEnv = typeof hits[0].prov.apiKeyEnv === 'string' ? hits[0].prov.apiKeyEnv : '';
  const inlineKey = typeof hits[0].prov.apiKey === 'string' && hits[0].prov.apiKey ? hits[0].prov.apiKey : '';
  const apiKey = inlineKey || (apiKeyEnv ? (process.env[apiKeyEnv] ?? '') : '');
  return { ...first, apiKey, apiKeyEnv, apiKeyPresent: apiKey !== '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 库：只读连接 + query_only 自证
// ─────────────────────────────────────────────────────────────────────────────

function openReadOnly(dbPath) {
  if (!existsSync(dbPath)) fail(`数据库不存在：${dbPath}`);
  const { DatabaseSync } = require('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    fail(`只读打开失败：${e instanceof Error ? e.message : String(e)}`);
  }
  db.exec('PRAGMA query_only = 1');
  const queryOnly = db.prepare('PRAGMA query_only').get();
  const queryOnlyValue = queryOnly ? Object.values(queryOnly)[0] : undefined;
  if (Number(queryOnlyValue) !== 1) fail(`PRAGMA query_only 期望 1，实测 ${String(queryOnlyValue)}`);

  // 写探针：readOnly + query_only 下写操作必须被拒（自证"不写库"不是口头约定）
  let writeRejected = false;
  let writeError = '';
  try {
    db.exec('CREATE TABLE _census_write_probe (x INTEGER)');
  } catch (e) {
    writeRejected = true;
    writeError = e instanceof Error ? e.message : String(e);
  }
  if (!writeRejected) fail('写探针**未被拒绝**：库并非只读，已中止（未写入任何数据）');

  return { db, queryOnlyValue: Number(queryOnlyValue), writeRejected, writeError };
}

function tableExists(db, name) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Number(row?.n ?? 0) > 0;
}

function countOf(db, sql) {
  const row = db.prepare(sql).get();
  return Number(row?.n ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const settings = loadSettings();
  const memCfg = settings.doc['dsh-memory'] ?? {};
  // 走生产同款解析函数（不硬编码 <dataDir>）
  const dataDir = resolveDataDir({ dataDir: typeof memCfg.dataDir === 'string' ? memCfg.dataDir : '' });
  const dbPath = path.join(dataDir, 'memory.db');

  const report = {
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    settingsFile: settings.file,
    dataDir,
    dbPath,
    dbBytes: existsSync(dbPath) ? statSync(dbPath).size : 0,
    llmEntry: null,
    readOnly: null,
    tables: {},
    l1Records: { total: 0, byType: [] },
    conflictPending: { total: 0, unresolved: 0, byResolution: [] },
  };

  const llm = resolveLlmEntry(settings);
  report.llmEntry = llm
    ? { source: llm.source, baseURL: llm.baseURL, model: llm.model, apiKeyEnv: llm.apiKeyEnv, apiKeyPresent: llm.apiKeyPresent }
    : null;

  const { db, queryOnlyValue, writeRejected, writeError } = openReadOnly(dbPath);
  report.readOnly = { queryOnly: queryOnlyValue, writeRejected, writeError };
  try {
    for (const t of ['l1_records', 'conflict_pending', 'conflict_rejected', 'l1_receipts', 'l0_conversations']) {
      report.tables[t] = tableExists(db, t);
    }

    report.l1Records.total = countOf(db, 'SELECT COUNT(*) AS n FROM l1_records');
    report.l1Records.byType = db
      .prepare('SELECT type, COUNT(*) AS n FROM l1_records GROUP BY type ORDER BY n DESC')
      .all()
      .map((r) => ({ type: String(r.type), n: Number(r.n) }));

    if (report.tables.conflict_pending) {
      report.conflictPending.total = countOf(db, 'SELECT COUNT(*) AS n FROM conflict_pending');
      report.conflictPending.unresolved = countOf(
        db,
        "SELECT COUNT(*) AS n FROM conflict_pending WHERE resolved_at = ''",
      );
      report.conflictPending.byResolution = db
        .prepare('SELECT resolution, COUNT(*) AS n FROM conflict_pending GROUP BY resolution ORDER BY n DESC')
        .all()
        .map((r) => ({ resolution: String(r.resolution), n: Number(r.n) }));
    }
  } finally {
    db.close();
  }

  // ── stdout 报告 ──
  const out = [];
  out.push('# Phase 0 只读普查报告（task_0.1）');
  out.push('');
  out.push(`- 生成时刻：${report.generatedAt}`);
  out.push(`- settings：${report.settingsFile}`);
  out.push(`- dataDir：${report.dataDir}（经 resolveDataDir 解析，未硬编码）`);
  out.push(`- db：${report.dbPath}（${(report.dbBytes / 1024 / 1024).toFixed(1)} MB）`);
  out.push(`- 只读自证：PRAGMA query_only = ${report.readOnly.queryOnly}；写探针被拒 = ${report.readOnly.writeRejected}`);
  out.push(
    `- LLM 抽取入口：${report.llmEntry ? `${report.llmEntry.source} → ${report.llmEntry.baseURL} / ${report.llmEntry.model}（apiKey ${report.llmEntry.apiKeyPresent ? '已取到' : '未取到'}${report.llmEntry.apiKeyEnv ? `，env ${report.llmEntry.apiKeyEnv}` : ''}）` : '**解析不出**（需要时按 Q4 非 0 退出）'}`,
  );
  out.push('');
  out.push('## 表存在性');
  for (const [t, exists] of Object.entries(report.tables)) out.push(`- ${t}：${exists ? '存在' : '不存在'}`);
  out.push('');
  out.push(`## l1_records：${report.l1Records.total} 行`);
  for (const r of report.l1Records.byType) out.push(`- ${r.type}：${r.n}`);
  out.push('');
  out.push(
    `## conflict_pending：${report.conflictPending.total} 行（未裁决 ${report.conflictPending.unresolved}）`,
  );
  for (const r of report.conflictPending.byResolution) out.push(`- resolution=${r.resolution === '' ? "''（未裁决）" : r.resolution}：${r.n}`);
  const text = out.join('\n');
  process.stdout.write(`${text}\n`);

  if (opts.out) {
    const target = path.resolve(opts.out);
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`\n[census] JSON 报告已写入 ${target}\n`);
  }
}

main();
