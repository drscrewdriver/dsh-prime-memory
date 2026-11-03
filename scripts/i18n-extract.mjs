/**
 * i18n 抽取器（开发工具，不参与运行时）。
 *
 * 扫描 `client/src/**\/*.ts{,x}`，把**用户可见的中文文案**归一化成字典 key，并
 * 输出两份产物：
 *
 * 1. `client/src/locales/keys.json` —— 全部 key（去重、稳定排序）。翻译源文件。
 * 2. `i18n-report.json`（仓库根，临时）—— 每个文件抽到的位置与 key，供 codemod 复核。
 *
 * 规则（**key = 中文原文**，gettext 式）：
 *   - 空白折叠成一个空格并 trim —— JSX 文本跨行缩进不进 key；
 *   - 模板字符串里的 `${expr}` 变成 `{p1}`、`{p2}`…，运行期由 `t()` 的第二参数填充。
 *
 * 跳过（翻错会改行为，故一律保持中文）：
 *   - 对象字面量的属性名、`case` 标签、比较运算两侧、`includes/startsWith/endsWith/
 *     indexOf/lastIndexOf/split/match/replace` 的参数字面量、成员访问下标、import/export；
 *   - `console.*` 与 `throw new Error()` 的开发期诊断（不是界面文案，不进翻译范围）。
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'client/src');

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const MATCH_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'split',
  'match',
  'matchAll',
  'replace',
  'replaceAll',
  'search',
  'test',
]);

/** 归一化文案 → key。 */
export function normKey(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(p);
  }
  return out;
}

function inConsoleOrThrow(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p)) {
      const callee = p.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.expression.getText() === 'console') return true;
      if (callee.getText() === 'Error' || callee.getText() === 'TypeError') return true;
    }
    if (ts.isStatement(p)) return false;
  }
  return false;
}

/** 该字面量是否处在「翻错会改行为」的位置。 */
function isStructural(node) {
  const p = node.parent;
  if (!p) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isCaseClause(p) && p.expression === node) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      return true;
    }
  }
  if (ts.isCallExpression(p)) {
    const callee = p.expression;
    if (ts.isPropertyAccessExpression(callee) && MATCH_METHODS.has(callee.name.text)) return true;
  }
  if (ts.isJsxAttribute(p) && p.name.getText() === 'key') return true;
  return inConsoleOrThrow(node);
}

/** 已包在 t(...) 里的字面量：跳过（幂等）。 */
function alreadyWrapped(node) {
  const p = node.parent;
  return !!(p && ts.isCallExpression(p) && p.expression.getText() === 'tr');
}

/** 抽出单个文件的编辑 + key。 */
export function extractFile(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2020, true);
  const edits = [];
  const keys = [];

  const addLiteral = (node, kind) => {
    if (!HAN.test(node.text)) return;
    if (isStructural(node) || alreadyWrapped(node)) return;
    const key = normKey(node.text);
    if (!key) return;
    edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `tr(${JSON.stringify(key)})`, kind });
    keys.push(key);
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const key = normKey(node.text);
      if (key && HAN.test(key)) {
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `{tr(${JSON.stringify(key)})}`, kind: 'jsx-text' });
        keys.push(key);
      }
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const lit = node.initializer;
      if (HAN.test(lit.text) && node.name.getText() !== 'key') {
        const key = normKey(lit.text);
        if (key) {
          edits.push({ start: lit.getStart(sf), end: lit.getEnd(), text: `{tr(${JSON.stringify(key)})}`, kind: 'jsx-attr' });
          keys.push(key);
        }
        return; // 整个属性已替换，别再下钻到字面量（否则重叠编辑）
      }
    } else if (ts.isTemplateExpression(node)) {
      const params = [];
      const texts = [node.head.text];
      for (const span of node.templateSpans) {
        texts.push(span.literal.text);
      }
      const joined = texts.join('\u0000');
      if (HAN.test(joined) && !/[{}]/.test(joined) && !isStructural(node) && !alreadyWrapped(node)) {
        node.templateSpans.forEach((span, i) => {
          params.push({ name: `p${i + 1}`, expr: span.expression.getText(sf) });
        });
        // key 用 {pN} 占位，文本逐段拼接后再归一化空白。
        let raw = node.head.text;
        node.templateSpans.forEach((span, i) => {
          raw += `{p${i + 1}}` + span.literal.text;
        });
        const key = normKey(raw);
        const paramText = params.map((p) => `${p.name}: ${p.expr}`).join(', ');
        edits.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          text: paramText ? `tr(${JSON.stringify(key)}, { ${paramText} })` : `tr(${JSON.stringify(key)})`,
          kind: 'template',
        });
        keys.push(key);
        return; // 整条模板已替换，别再下钻到 ${} 里的字面量（否则重叠编辑）
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      addLiteral(node, 'literal');
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return { edits, keys };
}

/** 把编辑应用到源码（从后往前，避免位移）。 */
export function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = walk(SRC);
  const allKeys = new Set();
  const report = {};
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const { edits, keys } = extractFile(file, source);
    if (!edits.length) continue;
    report[path.relative(root, file)] = { edits: edits.length, keys: [...new Set(keys)] };
    for (const k of keys) allKeys.add(k);
  }
  const sorted = [...allKeys].sort((a, b) => a.localeCompare(b, 'zh'));
  const outDir = path.join(root, 'client/src/locales');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'keys.json'), JSON.stringify(sorted, null, 2) + '\n');
  writeFileSync(path.join(root, 'i18n-report.json'), JSON.stringify(report, null, 2) + '\n');
  const sites = Object.values(report).reduce((n, r) => n + r.edits, 0);
  console.log(`files with copy: ${Object.keys(report).length}, edits: ${sites}, unique keys: ${sorted.length}`);
}