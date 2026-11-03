/**
 * i18n 字典合成（开发工具）——把 `scripts/i18n-extract.mjs` 抽出的 key 与翻译产物
 * 合成 `client/src/locales/{en,ru}.ts`。
 *
 * 输入：
 *   - `client/src/locales/keys.json`（抽取器产出的 key 全集，中文原文）
 *   - 翻译产物：`{"zh": <原文>, "en": "...", "ru": "..."}` 的 JSON 数组（可多份）
 *
 * 输出：
 *   - `client/src/locales/en.ts` / `ru.ts`（按 key 排序，稳定 diff）
 *   - 覆盖率报告：缺失 key 数量（缺失的 key 在运行期回退到中文/英文，不会露裸 key）
 *
 * 用法：`node scripts/i18n-merge.mjs <translations-dir>`
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = path.join(root, 'client/src/locales');

const dir = process.argv[2]; // 可选：译稿目录（out-*.json）

const keys = JSON.parse(readFileSync(path.join(LOCALES, 'keys.json'), 'utf8'));
const keySet = new Set(keys);
const en = new Map();
const ru = new Map();
const problems = [];

/**
 * 基座：读现有字典。
 *
 * 这一步让 merge 变成**更新器**：只补新增 key、丢已经不在抽取集里的 key，
 * 而不是每次重跑都把整本字典清成「本次译稿覆盖到的部分」。没有基座时，
 * 一次忘了带全译稿的 merge 会把 1100 条译文洗成几十条。
 */
function seed(file, map) {
  const full = path.join(LOCALES, file);
  if (!existsSync(full)) return;
  const src = readFileSync(full, 'utf8');
  const body = src.slice(src.indexOf('{') + 1, src.lastIndexOf('}')).replace(/,\s*$/, '');
  for (const [k, v] of Object.entries(JSON.parse(`{${body}}`))) {
    if (keySet.has(k) && typeof v === 'string' && v.trim()) map.set(k, v);
  }
}
seed('en.ts', en);
seed('ru.ts', ru);

const outFiles = dir && existsSync(dir) ? readdirSync(dir).filter((f) => /^out-\d+\.json$/.test(f)) : [];
for (const file of outFiles) {
  const rows = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  for (const row of rows) {
    if (!row || typeof row.zh !== 'string') {
      problems.push(`${file}: row without zh`);
      continue;
    }
    if (!keySet.has(row.zh)) {
      problems.push(`${file}: key not in extraction: ${JSON.stringify(row.zh).slice(0, 60)}`);
      continue;
    }
    if (typeof row.en === 'string' && row.en.trim()) en.set(row.zh, row.en.trim());
    if (typeof row.ru === 'string' && row.ru.trim()) ru.set(row.zh, row.ru.trim());
    if (/[\u4e00-\u9fff]/.test(row.en || '')) problems.push(`${file}: Chinese left in en: ${row.zh}`);
    if (/[\u4e00-\u9fff]/.test(row.ru || '')) problems.push(`${file}: Chinese left in ru: ${row.zh}`);
  }
}

// 人工覆盖：生成物之上的一层，专治「同形异义」「术语定稿」。重跑 merge 不会丢。
const overridesPath = path.join(root, 'scripts/i18n-overrides.json');
if (existsSync(overridesPath)) {
  const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
  for (const [k, pair] of Object.entries(overrides)) {
    if (!keySet.has(k)) {
      problems.push(`override key not in extraction: ${JSON.stringify(k).slice(0, 60)}`);
      continue;
    }
    if (pair.en) en.set(k, pair.en);
    if (pair.ru) ru.set(k, pair.ru);
  }
}

const sorted = [...keys].sort((a, b) => a.localeCompare(b, 'zh'));
const render = (name, map, note) => {
  const lines = sorted
    .filter((k) => map.has(k))
    .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(map.get(k))},`);
  return `/** ${note} 由 \`scripts/i18n-merge.mjs\` 生成，勿手改。 */\nexport const ${name}: Record<string, string> = {\n${lines.join('\n')}\n};\n`;
};

writeFileSync(path.join(LOCALES, 'en.ts'), render('en', en, '英文文案（key = 中文原文）。'));
writeFileSync(path.join(LOCALES, 'ru.ts'), render('ru', ru, '俄文文案（key = 中文原文）。'));

const missingEn = sorted.filter((k) => !en.has(k));
const missingRu = sorted.filter((k) => !ru.has(k));
console.log(`keys: ${sorted.length} | en: ${en.size} (missing ${missingEn.length}) | ru: ${ru.size} (missing ${missingRu.length})`);
if (problems.length) {
  console.log(`problems: ${problems.length}`);
  for (const p of problems.slice(0, 20)) console.log('  -', p);
}
if (missingEn.length) console.log('missing en sample:', missingEn.slice(0, 10));
if (missingRu.length) console.log('missing ru sample:', missingRu.slice(0, 10));