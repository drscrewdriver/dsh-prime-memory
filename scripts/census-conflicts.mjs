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
  const opts = { sample: 0, out: '', reuse: '', concurrency: 4, timeoutMs: 60000, selftest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--selftest') opts.selftest = true;
    else if (a === '--out') opts.out = argv[++i] ?? fail('--out 需要一个文件路径');
    else if (a === '--reuse') opts.reuse = argv[++i] ?? fail('--reuse 需要一个文件路径');
    else if (a === '--sample') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) fail('--sample 需要非负整数');
      opts.sample = Math.floor(n);
    } else if (a === '--concurrency') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) fail('--concurrency 需要正整数');
      opts.concurrency = Math.floor(n);
    } else if (a === '--timeout-ms') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) fail('--timeout-ms 需要正整数');
      opts.timeoutMs = Math.floor(n);
    } else fail(`未知参数 ${a}（用 --help 查看用法）`);
  }
  return opts;
}

const HELP = `Phase 0 只读普查 —— dsh-prime-memory 冲突模型三轴增强

  --sample <N>       抽样 N 条 l1_records 做 claim 四元组抽取（默认 0 = 跳过，不调用 LLM）
  --reuse <file>     复用既有报告的 claims.perSample（不调用 LLM，便于复现与二次分析）
  --concurrency <N>  抽取并发（默认 4）
  --timeout-ms <N>   单条抽取超时（默认 60000）
  --out <file>       额外写一份 JSON 报告（默认只打印到 stdout）
  --selftest         只跑分类自检（含 α 案例判据）后退出
  --help             显示本帮助

本脚本永不写库：只读连接 + PRAGMA query_only=1 + 写探针自证。
抽取入口与 dataDir 均在运行时从配置解析，不硬编码；解析不出即非 0 退出（不静默降级）。
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
// 抽样：按 type 分层 + 类内等距（确定性，同库同参两次结果一致）
// ─────────────────────────────────────────────────────────────────────────────

function evenlySpaced(items, k) {
  if (k >= items.length) return [...items];
  if (k <= 0) return [];
  const out = [];
  const stride = items.length / k;
  for (let i = 0; i < k; i++) out.push(items[Math.floor(i * stride)]);
  return out;
}

/** 最大余数法分配配额；每类至少 1 条（若该类型非空）。 */
function allocateQuota(counts, target) {
  const types = [...counts.keys()].sort();
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const quota = new Map();
  const remainders = [];
  for (const t of types) {
    const n = counts.get(t);
    const exact = total === 0 ? 0 : (n / total) * target;
    const base = Math.min(n, Math.max(1, Math.floor(exact)));
    quota.set(t, base);
    remainders.push([t, exact - Math.floor(exact)]);
  }
  let assigned = [...quota.values()].reduce((a, b) => a + b, 0);
  remainders.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  // 不足：按小数部分补，再按剩余容量补
  for (const [t] of remainders) {
    if (assigned >= target) break;
    if (quota.get(t) < counts.get(t)) {
      quota.set(t, quota.get(t) + 1);
      assigned++;
    }
  }
  for (const t of types) {
    if (assigned >= target) break;
    const room = counts.get(t) - quota.get(t);
    if (room > 0) {
      const add = Math.min(room, target - assigned);
      quota.set(t, quota.get(t) + add);
      assigned += add;
    }
  }
  // 超出（min-1 抬升所致）：从小数部分最小且 >1 的类往下削
  for (let i = remainders.length - 1; i >= 0 && assigned > target; i--) {
    const t = remainders[i][0];
    while (assigned > target && quota.get(t) > 1) {
      quota.set(t, quota.get(t) - 1);
      assigned--;
    }
  }
  return quota;
}

function sampleRecords(db, sampleSize) {
  if (sampleSize <= 0) return [];
  const rows = db
    .prepare('SELECT record_id, type FROM l1_records ORDER BY type, record_id')
    .all()
    .map((r) => ({ id: String(r.record_id), type: String(r.type) }));
  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push(r.id);
  }
  const counts = new Map([...byType.entries()].map(([t, ids]) => [t, ids.length]));
  const quota = allocateQuota(counts, Math.min(sampleSize, rows.length));
  const picked = [];
  for (const t of [...byType.keys()].sort()) {
    for (const id of evenlySpaced(byType.get(t), quota.get(t) ?? 0)) picked.push({ id, type: t });
  }
  return picked;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM 抽取（task_0.2）：入口显式、逐条留痕、无静默跳过
// ─────────────────────────────────────────────────────────────────────────────

const CLAIM_SYSTEM_PROMPT = `你是记忆库的「claim 抽取器」。给你一条原子记忆的正文，请抽出它主张的**可比较声明**四元组：

- entity：被主张的主体（人名 / 项目名 / 组件名 / 概念名，尽量用正文里的原词）
- attribute：被主张的属性（如 版本 / 状态 / 负责人 / 端口 / 路径 / 偏好 / 关系）
- scope：该主张成立的限定范围（环境 / 工作区 / 模块 / 时间限定）；**正文没有限定就留空串**
- value：该属性的取值（原词，不解释）

只输出**一个 JSON 对象**，不要任何解释、不要 markdown 代码块：
{"entity":"...","attribute":"...","scope":"...","value":"..."}

规则：
1. 抽不出可比较的 (entity, attribute)（例如纯叙事、无主体属性结构）时，四个字段全部输出空串。
2. 不要臆造正文里没有的实体或属性；不要改写原词的语言。
3. 一条记忆只抽**最主要的那一个** claim（若有多个，取最具体、最可能与他人冲突的那个）。`;

function stripFence(text) {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (m ? m[1] : t).trim();
}

async function callOne(entry, userContent, timeoutMs) {
  const base = entry.baseURL.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(entry.apiKey ? { authorization: `Bearer ${entry.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: entry.model,
        messages: [
          { role: 'system', content: CLAIM_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        max_tokens: 256,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `http-${res.status}`, raw: text.slice(0, 300) };
    let content = '';
    try {
      const json = JSON.parse(text);
      content = json?.choices?.[0]?.message?.content ?? '';
    } catch {
      return { ok: false, reason: 'bad-envelope', raw: text.slice(0, 300) };
    }
    if (!content.trim()) return { ok: false, reason: 'empty-completion', raw: text.slice(0, 300) };
    let parsed;
    try {
      parsed = JSON.parse(stripFence(content));
    } catch {
      return { ok: false, reason: 'not-json', raw: content.slice(0, 300) };
    }
    const s = (v) => (typeof v === 'string' ? v.trim() : '');
    const claim = { entity: s(parsed.entity), attribute: s(parsed.attribute), scope: s(parsed.scope), value: s(parsed.value) };
    if (!claim.entity || !claim.attribute) {
      return { ok: false, reason: !claim.entity ? 'empty-entity' : 'empty-attribute', raw: content.slice(0, 300), claim };
    }
    return { ok: true, claim, raw: content.slice(0, 300) };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { ok: false, reason: aborted ? 'timeout' : 'network', raw: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function extractClaims(db, entry, sample, opts) {
  const rows = new Map();
  const stmt = db.prepare('SELECT record_id, content, type, scope FROM l1_records WHERE record_id = ?');
  for (const s of sample) {
    const r = stmt.get(s.id);
    if (!r) {
      // 抽样与读取之间记录消失（库在活写）：**显式留痕**，不当"跳过"
      rows.set(s.id, { ...s, content: null, recordScope: '' });
    } else {
      rows.set(s.id, { ...s, content: String(r.content ?? ''), recordScope: String(r.scope ?? '') });
    }
  }

  const results = new Array(sample.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= sample.length) return;
      const s = rows.get(sample[i].id);
      if (s.content === null) {
        results[i] = { id: s.id, type: s.type, ok: false, reason: 'record-vanished' };
        continue;
      }
      const user = `记忆正文：\n${s.content}\n\n（该记录 type=${s.type}${s.recordScope ? `，存储 scope=${s.recordScope}` : ''}）`;
      const out = await callOne(entry, user, opts.timeoutMs);
      results[i] = { id: s.id, type: s.type, ...out };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 分类（task_0.3）：同 (entity, attribute) 聚组 → hard / conditional / supersession
//
// 判据（与 spec 的「类型路由」同口径，fail-closed）：
//   - 组内取值只有 1 种（忽略大小写/标点/空白差异）→ 不构成冲突（agreement，不计入三类）
//   - 取值 ≥2 种且**声明的作用域不同**（空串算一种作用域）→ conditional（作用域张力：各自成立）
//   - 取值 ≥2 种、作用域相同、且相关记录时间**互不相同且可排序** → supersession（换价/取代）
//   - 其余（含时间缺失/相同、字段缺失）→ **hard**（fail-closed：宁可多占人的注意力）
// 不做实体消解：只按字面归一聚合，不做 alias merge（spec 非目标）。
// ─────────────────────────────────────────────────────────────────────────────

function normKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s"'`“”‘’()（）[\]【】]+/g, '')
    .trim();
}

function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function loadClaimTimes(db, ids) {
  const out = new Map();
  const stmt = db.prepare('SELECT record_id, created_time, valid_from, valid_to FROM l1_records WHERE record_id = ?');
  for (const id of ids) {
    const r = stmt.get(id);
    if (!r) continue;
    const validFrom = toMs(r.valid_from);
    const created = toMs(r.created_time);
    out.set(id, { time: validFrom ?? created, validFrom, created });
  }
  return out;
}

function classifyClaims(claims, timesById) {
  const groups = new Map();
  for (const c of claims) {
    const key = `${normKey(c.entity)}\u0000${normKey(c.attribute)}`;
    if (!key.startsWith('\u0000') && key !== '\u0000') {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
  }

  const counts = { hard: 0, conditional: 0, supersession: 0, agreement: 0 };
  const details = [];
  for (const [key, list] of groups) {
    const [entityKey, attributeKey] = key.split('\u0000');
    const valueKeys = new Set(list.map((c) => normKey(c.value)));
    if (valueKeys.size < 2) {
      counts.agreement++;
      continue;
    }
    const scopes = new Set(list.map((c) => normKey(c.scope)));
    let label;
    let reason;
    if (scopes.size > 1) {
      label = 'conditional';
      reason = `取值不同且作用域不同（${[...scopes].map((s) => (s === '' ? '∅' : s)).join(' / ')}）`;
    } else {
      const times = list.map((c) => timesById.get(c.id)?.time ?? null);
      const distinctTimes = new Set(times.filter((t) => t !== null));
      if (times.every((t) => t !== null) && distinctTimes.size === times.length && times.length >= 2) {
        label = 'supersession';
        reason = '取值不同、作用域相同、时间互不相同且可排序（换价/取代）';
      } else {
        label = 'hard';
        reason = '取值不同且作用域相同、时间无法排序（缺失或相同）⇒ fail-closed 按硬矛盾计';
      }
    }
    counts[label]++;
    details.push({
      entity: list[0].entity,
      attribute: list[0].attribute,
      label,
      reason,
      scopes: [...scopes].map((s) => (s === '' ? '∅' : s)),
      values: [...new Set(list.map((c) => c.value))],
      claimIds: list.map((c) => c.id),
      entityKey,
      attributeKey,
    });
  }
  details.sort((a, b) => b.claimIds.length - a.claimIds.length || (a.entity < b.entity ? -1 : 1));
  return { counts, groups: details };
}

/** 重复实体测量（**只测量、不合并**）：归一后同名多写法 + 互为子串的可能变体。 */
function duplicateEntities(claims, topN) {
  const spellings = new Map();
  for (const c of claims) {
    const k = normKey(c.entity);
    if (!k) continue;
    if (!spellings.has(k)) spellings.set(k, new Set());
    spellings.get(k).add(String(c.entity));
  }
  const exactDupes = [...spellings.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([k, set]) => ({ key: k, spellings: [...set] }));

  const keys = [...spellings.keys()];
  const substringPairs = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = 0; j < keys.length; j++) {
      if (i === j) continue;
      const a = keys[i];
      const b = keys[j];
      // 只认「前缀/后缀」包含、短侧 ≥4 字符、且长侧不超过短侧 2 倍（近似同名异写）。
      // 实测教训：纯子串匹配噪声极大（TOP-N 全是「插件 ⊂ …」）；放宽到 3 字符则
      // 「dsh ⊂ dsh-anything」泛滥。本测量**只测量、不合并**，宁可少报也不虚报。
      if (a && b && a !== b && a.length >= 4 && b.length <= a.length * 2 && (b.startsWith(a) || b.endsWith(a))) {
        substringPairs.push({ shorter: a, longer: b });
      }
    }
  }
  substringPairs.sort((a, b) => a.shorter.length - b.shorter.length);
  return { exactDupes: exactDupes.slice(0, topN), substringPairs: substringPairs.slice(0, topN) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 分类自检（task_0.3 的 α 判据：不依赖抽样运气，直接对判据本身做机械断言）
// ─────────────────────────────────────────────────────────────────────────────

const SELFTEST_CASES = [
  {
    name: 'α 案例（作用域张力：官方页仅 flash vs catalog flash+pro）',
    claims: [
      { id: 'a1', entity: 'DeepSeek 缓存折扣 α', attribute: '折扣率', scope: 'flash', value: '0.02' },
      { id: 'a2', entity: 'deepseek缓存折扣α', attribute: '折扣率', scope: '', value: '≈1/30' },
    ],
    times: { a1: 1000, a2: 2000 },
    expect: 'conditional',
  },
  {
    name: '同作用域换价（时间有序）⇒ supersession',
    claims: [
      { id: 'b1', entity: 'dsh 插件端口', attribute: '端口', scope: 'web', value: '3080' },
      { id: 'b2', entity: 'dsh 插件端口', attribute: '端口', scope: 'web', value: '3081' },
    ],
    times: { b1: 1000, b2: 2000 },
    expect: 'supersession',
  },
  {
    name: '同作用域同时间矛盾 ⇒ hard（fail-closed）',
    claims: [
      { id: 'c1', entity: 'dsh-prime-memory', attribute: '包名', scope: '', value: 'dsh-memory-plugin' },
      { id: 'c2', entity: 'dsh-prime-memory', attribute: '包名', scope: '', value: 'dsh-prime-memory' },
    ],
    times: { c1: 5000, c2: 5000 },
    expect: 'hard',
  },
  {
    name: '同作用域时间缺失 ⇒ hard（fail-closed）',
    claims: [
      { id: 'e1', entity: '检索后端', attribute: '实现', scope: '', value: 'fts' },
      { id: 'e2', entity: '检索后端', attribute: '实现', scope: '', value: 'vec' },
    ],
    times: {},
    expect: 'hard',
  },
  {
    name: '归一后同值（大小写/空格差异）⇒ 不构成冲突',
    claims: [
      { id: 'd1', entity: 'dsh 插件端口', attribute: '端口', scope: '', value: '3080' },
      { id: 'd2', entity: 'DSH  插件端口', attribute: '端口', scope: '', value: ' 3080 ' },
    ],
    times: { d1: 1, d2: 2 },
    expect: 'agreement',
  },
];

function runSelfTest() {
  let failed = 0;
  for (const c of SELFTEST_CASES) {
    // 夹具里的 times 是 { id: 毫秒 }，分类器吃的是 { id: { time } }，此处显式包一层
    const times = new Map(Object.entries(c.times).map(([k, v]) => [k, { time: v }]));
    const { counts, groups } = classifyClaims(c.claims, times);
    const label = c.expect === 'agreement' ? (counts.agreement === 1 ? 'agreement' : `(agreement=${counts.agreement})`) : groups[0]?.label;
    const ok = label === c.expect;
    if (!ok) failed++;
    process.stdout.write(`${ok ? '✓' : '✗'} ${c.name} ⇒ ${label}（期望 ${c.expect}）\n`);
  }
  if (failed > 0) fail(`分类自检 ${failed} 项未通过`);
  process.stdout.write('\n[census] 分类自检全部通过\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  return mainAsync();
}

async function mainAsync() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.selftest) {
    runSelfTest();
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

    // 复现指纹：同库同参两次运行应一致（库在活写时以本指纹判定"是否同一份数据"）
    report.dbFingerprint = {
      l1Records: report.l1Records.total,
      l1MaxUpdated: db.prepare('SELECT MAX(updated_time) AS m FROM l1_records').get()?.m ?? null,
      conflictPending: report.conflictPending.total,
      dbBytes: report.dbBytes,
    };

    let claimRows = null;

    // ── 复用既有抽取结果（--reuse）：不重复调用 LLM，便于复现与二次分析 ──
    if (opts.reuse) {
      const src = path.resolve(opts.reuse);
      const prev = JSON.parse(readFileSync(src, 'utf8'));
      const rows = prev?.claims?.perSample;
      if (!Array.isArray(rows) || rows.length === 0) fail(`--reuse 文件里没有 claims.perSample：${src}`);
      report.claims = { ...prev.claims, reusedFrom: src };
      claimRows = rows.map((r) => ({
        id: String(r.id),
        type: String(r.type),
        ok: !!r.ok,
        reason: r.reason ?? '',
        claim: r.claim ?? undefined,
      }));
      process.stderr.write(`[census] 复用既有抽取结果（不调用 LLM）：${src}（${claimRows.length} 条）\n`);
    }

    // ── claim 抽取（task_0.2）──
    if (opts.sample > 0) {
      if (!llm) {
        fail(
          '需要 LLM 抽取（--sample > 0），但抽取入口解析不出。请检查 settings.yaml 的 ' +
            'dsh-memory.distillChain 与其 provider 块（本机为 llm-pi-ai.providers.<name>），' +
            '或用 DSH_SETTINGS_FILE 指定另一份设置文件。',
        );
      }
      const sample = sampleRecords(db, opts.sample);
      process.stderr.write(
        `[census] 抽样 ${sample.length} 条（按 type 分层），开始 claim 抽取：${llm.source} / ${llm.model}，并发 ${opts.concurrency}\n`,
      );
      const results = await extractClaims(db, llm, sample, opts);
      if (results.length !== sample.length) fail('抽取结果数与样本数不一致：存在静默跳过');
      const okList = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);
      const reasons = {};
      for (const f of failures) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
      report.claims = {
        requested: opts.sample,
        sampled: sample.length,
        ok: okList.length,
        failed: failures.length,
        extractionRate: sample.length ? okList.length / sample.length : 0,
        reasons,
        failureSamples: failures.slice(0, 20).map((f) => ({ id: f.id, type: f.type, reason: f.reason, raw: f.raw })),
        claims: okList.map((r) => ({ id: r.id, type: r.type, ...r.claim })),
        perSample: results.map((r) => ({ id: r.id, type: r.type, ok: r.ok, reason: r.reason ?? '', claim: r.claim ?? null })),
      };
      claimRows = results;
    }

    // ── 分类（task_0.3）+ 重复实体测量（task_0.4）──
    if (claimRows) {
      const okClaims = claimRows
        .filter((r) => r.ok && r.claim)
        .map((r) => ({ id: r.id, type: r.type, ...r.claim }));
      const times = loadClaimTimes(db, okClaims.map((c) => c.id));
      const classified = classifyClaims(okClaims, times);
      report.classification = {
        counts: classified.counts,
        conflictGroupCount: classified.counts.hard + classified.counts.conditional + classified.counts.supersession,
        groups: classified.groups,
        duplicateEntities: duplicateEntities(okClaims, 20),
      };
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

  if (report.claims) {
    const c = report.claims;
    out.push('');
    out.push(`## claim 抽取（task_0.2）：抽样 ${c.sampled} 条（请求 ${c.requested}）`);
    out.push(`- 成功 ${c.ok} / 失败 ${c.failed} ⇒ **抽取率 ${(c.extractionRate * 100).toFixed(1)}%**（轴 3 闸门：≥ 70%）`);
    const reasonText = Object.entries(c.reasons)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ');
    out.push(`- 失败原因：${reasonText || '（无）'}`);
    const byType = new Map();
    for (const p of c.perSample) {
      const cur = byType.get(p.type) ?? { ok: 0, n: 0 };
      cur.n++;
      if (p.ok) cur.ok++;
      byType.set(p.type, cur);
    }
    for (const [t, v] of [...byType.entries()].sort()) out.push(`  - ${t}：${v.ok}/${v.n}`);
    if (c.failureSamples.length) {
      out.push(`- 失败样例（前 ${c.failureSamples.length} 条，含原始响应片段）：`);
      for (const f of c.failureSamples) out.push(`  - [${f.reason}] ${f.id}（${f.type}）raw=${JSON.stringify(String(f.raw).slice(0, 120))}`);
    }
  } else if (opts.sample === 0) {
    out.push('');
    out.push('## claim 抽取：已跳过（--sample 0）');
  }

  if (report.classification) {
    const cl = report.classification;
    const c = cl.counts;
    out.push('');
    out.push('## 类型分类（task_0.3：同 (entity, attribute) 聚组）');
    out.push(
      `- **hard：${c.hard}**（进队列、占额度）｜ conditional：${c.conditional}（并存+标注）｜ supersession：${c.supersession}（并存+标注）｜ 同值不构成冲突：${c.agreement}`,
    );
    out.push(`- 冲突组总数：${cl.conflictGroupCount}（每组 = 一个 (entity, attribute) 键）`);
    if (cl.groups.length) {
      out.push('- 分组明细（前 10 组，按涉及 claim 数降序）：');
      for (const g of cl.groups.slice(0, 10)) {
        out.push(
          `  - [${g.label}] ${g.entity} / ${g.attribute}：取值 ${g.values.join(' vs ')}｜作用域 ${g.scopes.join(' / ')}｜${g.reason}`,
        );
      }
    }
    const de = cl.duplicateEntities;
    out.push('');
    out.push('## 重复实体测量（task_0.4：**只测量、不合并**）');
    out.push(`- 归一后同名多写法：${de.exactDupes.length} 组`);
    for (const d of de.exactDupes.slice(0, 10)) out.push(`  - ${d.spellings.join(' | ')}`);
    out.push(`- 互为子串的可能变体：${de.substringPairs.length} 对（TOP）`);
    for (const p of de.substringPairs.slice(0, 10)) out.push(`  - ${p.shorter} ⊂ ${p.longer}`);
  }

  const text = out.join('\n');
  process.stdout.write(`${text}\n`);

  if (opts.out) {
    const target = path.resolve(opts.out);
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`\n[census] JSON 报告已写入 ${target}\n`);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
