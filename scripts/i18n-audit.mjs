/**
 * i18n 审计（开发工具）——不跑宿主，只对**源码 + 字典 + 构建产物**做可复核的检查。
 *
 * 回答三个问题：
 *   1. 还有没有**没走 tr() 的中文**（会被渲染出来的那些）；
 *   2. 字典本身有没有硬伤（占位符/标点/长度/原样复制/空值）；
 *   3. 构建产物里是否真的带着全部 key（源码改了但没重编，是最常见的假绿）。
 *
 * 用法：`node scripts/i18n-audit.mjs`
 * 退出码：有 ERROR 时非 0（可挂 CI）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { extractFile } from './i18n-extract.mjs';

/** 读生成物 `locales/<loc>.ts`（对象字面量，键值都是 JSON 串）——不依赖 TS 运行时。 */
const readDict = (loc) => {
  const src = readFileSync(path.join(root, 'client/src/locales', `${loc}.ts`), 'utf8');
  const body = src.slice(src.indexOf('{') + 1, src.lastIndexOf('}')).replace(/,\s*$/, '');
  return JSON.parse(`{${body}}`);
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'client/src');
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'locales') walk(p, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(p);
  }
  return out;
};

const en = readDict('en');
const ru = readDict('ru');
const keys = JSON.parse(readFileSync(path.join(SRC, 'locales/keys.json'), 'utf8'));
const keySet = new Set(keys);
const errors = [];
const warnings = [];
const rel = (p) => path.relative(root, p);

// ── 1. 源码：未包装的中文 ───────────────────────────────────────────
let unwrapped = 0;
const unwrappedByFile = new Map();
for (const file of walk(SRC)) {
  if (file.endsWith('i18n.ts') || file.endsWith('i18n-core.ts')) continue;
  const { edits } = extractFile(file, readFileSync(file, 'utf8'));
  if (!edits.length) continue;
  unwrapped += edits.length;
  unwrappedByFile.set(rel(file), edits.length);
}
if (unwrapped) {
  const detail = [...unwrappedByFile.entries()].map(([f, n]) => `${n}× ${f}`).join(', ');
  warnings.push(`未走 tr() 的中文 ${unwrapped} 处（结构性字符串属预期，其余会显示中文）: ${detail}`);
}

// ── 2. 源码：局部变量遮蔽 tr ─────────────────────────────────────────
for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2020, true);
  const visit = (node) => {
    const name =
      ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)
        ? node.name?.getText(sf)
        : null;
    if (name === 'tr' && !ts.isImportSpecifier(node.parent) && !file.endsWith('i18n.ts')) {
      errors.push(`${rel(file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} 局部变量名 tr 遮蔽了翻译函数`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (/tr\(\s*tr\(/.test(src)) errors.push(`${rel(file)}: 出现 tr(tr(...)) 嵌套`);
}

// ── 3. 字典：覆盖 / 硬伤 ────────────────────────────────────────────
const dicts = { en, ru };
for (const [loc, dict] of Object.entries(dicts)) {
  for (const k of keys) {
    const v = dict[k];
    if (v === undefined) {
      errors.push(`${loc}: 缺 key ${JSON.stringify(k).slice(0, 60)}`);
      continue;
    }
    if (!v.trim()) errors.push(`${loc}: 空译文 ${JSON.stringify(k).slice(0, 60)}`);
    if (HAN.test(v)) errors.push(`${loc}: 残留汉字 ${JSON.stringify(v).slice(0, 60)}`);
    // 首尾单个空格是**排版**（中文「共124条」→ 英文「Total 124 items」），不算问题；
    // 只报连续空白与「空格 + 标点」这种一眼可见的脏空格。
    if (/\s{2,}/.test(v) || /\s+[，。；：、,.;:]/.test(v)) warnings.push(`${loc}: 空白异常 ${JSON.stringify(v).slice(0, 50)}`);
    // 只在中英「结尾标点类别」不一致时报警：中文「：」结尾在 ru 里保留冒号是正确行为。
    const tail = (text) => (/[：:]$/.test(text.trim()) ? ':' : /[。.]$/.test(text.trim()) ? '.' : '');
    if (tail(v) !== tail(k)) warnings.push(`${loc}: 结尾标点与原文不一致 ${JSON.stringify(v).slice(0, 50)}`);
  }
}

// 长度比（俄语比英语长 20~30% 正常；>1.8 有溢出风险）
const ratio = keys
  .map((k) => ({ k, r: (ru[k] || '').length / Math.max(1, (en[k] || '').length) }))
  .filter((x) => x.r > 1.8 && (en[x.k] || '').length >= 12)
  .sort((a, b) => b.r - a.r);
if (ratio.length) {
  warnings.push(`俄语长度 >1.8× 英语：${ratio.length} 条（前 3：${ratio.slice(0, 3).map((x) => `${JSON.stringify(x.k).slice(0, 30)} ${x.r.toFixed(2)}×`).join('; ')}）`);
}

// 完全相同的 en/ru（可能整条没翻）
const same = keys.filter((k) => en[k] === ru[k] && /[A-Za-zА-Яа-я]/.test(en[k] || '') && (en[k] || '').length > 3);
if (same.length) warnings.push(`en/ru 完全相同：${same.length} 条（可能是通用缩写或漏翻，前 5：${same.slice(0, 5).map((k) => JSON.stringify(en[k])).join(', ')}）`);

// 译文只剩标点（空壳翻译）
for (const [loc, dict] of Object.entries(dicts)) {
  for (const k of keys) {
    const v = (dict[k] || '').trim();
    if (v && /^[.,;:·—–\-!?()\s]+$/.test(v) && HAN.test(k)) errors.push(`${loc}: 译文只剩标点 ${JSON.stringify(k).slice(0, 40)}`);
  }
}

// 字典里有、抽取集里没有（死 key，会让包变大）
for (const [loc, dict] of Object.entries(dicts)) {
  const stale = Object.keys(dict).filter((k) => !keySet.has(k));
  if (stale.length) errors.push(`${loc}: 字典含抽取集之外的 key ${stale.length} 个（如 ${JSON.stringify(stale[0]).slice(0, 50)}）`);
}

// spacing 策略必须真的落进字典（否则「6scene blocks」这类粘连只会被实机发现）
const overridesFile = path.join(root, 'scripts/i18n-overrides.json');
if (existsSync(overridesFile)) {
  const spacing = JSON.parse(readFileSync(overridesFile, 'utf8')).spacing || {};
  for (const [mode, list] of Object.entries(spacing)) {
    for (const k of list) {
      for (const [loc, dict] of Object.entries(dicts)) {
        const v = dict[k];
        if (typeof v !== 'string') continue;
        const okLead = mode === 'leading' || mode === 'both' ? v.startsWith(' ') : true;
        const okTrail = mode === 'trailing' || mode === 'both' ? v.endsWith(' ') : true;
        if (!okLead || !okTrail) errors.push(`${loc}: spacing(${mode}) 未生效 ${JSON.stringify(k)}`);
      }
    }
  }
}

// ── 4. 构建产物：是否带齐字典 ───────────────────────────────────────
const bundlePath = path.join(root, 'dist/client.js');
if (!existsSync(bundlePath)) {
  errors.push('dist/client.js 不存在（先跑 node scripts/build-client.mjs）');
} else {
  const bundle = readFileSync(bundlePath, 'utf8');
  // 归一化（去掉引号与转义差异）后再比：字典里的键含 `"` 时，esbuild 的转义写法与
  // JSON.stringify 可能不同，直接 includes 会假报缺失。
  const norm = (text) => text.replace(/[\\"]/g, '');
  const flatBundle = norm(bundle);
  const missing = keys.filter((k) => !flatBundle.includes(norm(k)));
  if (missing.length) {
    errors.push(`构建产物缺 ${missing.length} 个 key（源码改了但没重编？首个：${JSON.stringify(missing[0]).slice(0, 50)}）`);
  }
}

// ── 报告 ────────────────────────────────────────────────────────────
console.log(`keys: ${keys.length} | en: ${Object.keys(en).length} | ru: ${Object.keys(ru).length}`);
console.log(`未包装中文: ${unwrapped} 处`);
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(errors.length ? `\nFAILED: ${errors.length} error(s), ${warnings.length} warning(s)` : `\nOK: 0 error, ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);