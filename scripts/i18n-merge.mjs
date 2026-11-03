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
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = path.join(root, 'client/src/locales');

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/i18n-merge.mjs <translations-dir>');
  process.exit(2);
}

const keys = JSON.parse(readFileSync(path.join(LOCALES, 'keys.json'), 'utf8'));
const keySet = new Set(keys);
const en = new Map();
const ru = new Map();
const problems = [];

for (const file of readdirSync(dir).filter((f) => /^out-\d+\.json$/.test(f))) {
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