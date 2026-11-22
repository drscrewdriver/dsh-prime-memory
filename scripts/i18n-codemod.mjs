/**
 * i18n codemod（开发工具，不参与运行时）—— **机械改写，不改行为**。
 *
 * 把 `client/src` 里用户可见的中文文案包进 `tr(...)`（`client/src/i18n.ts`），
 * 并给改动过的文件补上 import。改写规则与跳过规则见 `scripts/i18n-extract.mjs`：
 * 结构位置（对象键、case 标签、比较、字符串匹配方法、import/export、console/throw
 * 诊断）**一律不动**——那些翻错会改行为。
 *
 * 幂等：已包在 `tr(...)` 里的字面量会被跳过，可重复运行。
 *
 * 用法：`node scripts/i18n-codemod.mjs [--check]`
 *   --check  只报告将要改的文件数，不落盘。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from './i18n-extract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'client/src');
const SKIP_DIRS = new Set(['locales']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(p, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 从该文件到 i18n.js 的相对 import 路径。 */
function importPath(file) {
  const rel = path.relative(path.dirname(file), path.join(SRC, 'i18n.js')).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

const IMPORT_RE = /^import .*from '.*i18n\.js';$/m;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const files = walk(SRC);
  let changedFiles = 0;
  let changedSites = 0;
  for (const file of files) {
    if (file.endsWith('i18n.ts')) continue;
    const source = readFileSync(file, 'utf8');
    const { edits } = extractFile(file, source);
    if (!edits.length) continue;

    // 从后往前替换，避免位移；JSX 文本保留原有的首尾空格（否则 "12 条" 会粘成 "12条"）。
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    let out = source;
    for (const e of sorted) {
      if (e.kind === 'jsx-text') {
        const raw = source.slice(e.start, e.end);
        const lead = /^\s/.test(raw) ? ' ' : '';
        const tail = /\s$/.test(raw) ? ' ' : '';
        out = out.slice(0, e.start) + lead + e.text + tail + out.slice(e.end);
      } else {
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
      }
    }

    if (!IMPORT_RE.test(out)) {
      // 插在**第一条 import 之前**：多行 import（`import {\n … \n} from '…'`）的尾部
      // 不是合法的插入点，文本匹配很容易插进括号里（实测），前置插入无此问题。
      const lines = out.split('\n');
      const at = lines.findIndex((line) => /^import\s/.test(line));
      lines.splice(at >= 0 ? at : 0, 0, `import { tr } from '${importPath(file)}';`);
      out = lines.join('\n');
    }

    changedFiles++;
    changedSites += edits.length;
    if (!check) writeFileSync(file, out);
  }
  console.log(`${check ? '[check] ' : ''}files: ${changedFiles}, sites: ${changedSites}`);
}