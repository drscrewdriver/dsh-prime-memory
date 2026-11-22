/**
 * i18n 字典守卫：key 集、占位符、语言纯净度。
 *
 * 为什么需要：字典是**生成物**（`scripts/i18n-merge.mjs`），而文案是**手写的**——
 * 新写一句中文就是新 key，没人会自动发现它没被翻译。这个用例把三条不变量钉死：
 *
 * 1. `keys.json` 无重复，且 en/ru/pt 覆盖**全集**（缺 key 会静默回退英文/中文，最难发现）；
 * 2. 占位符集合在四种语言里一致（漏掉 `{p1}` 会让数字/名称凭空消失）；
 * 3. en/ru/pt 里不残留汉字（说明漏翻或复制粘贴）。
 *
 * 生成物过期时这里会红——重跑 `node scripts/i18n-extract.mjs && node scripts/i18n-merge.mjs <dir>`。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { makeTr, registerDictionaries, type LocaleServiceLike } from '../client/src/i18n-core.js';
import { en } from '../client/src/locales/en.js';
import { ru } from '../client/src/locales/ru.js';
import { pt } from '../client/src/locales/pt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keys: string[] = JSON.parse(readFileSync(path.join(root, 'client/src/locales/keys.json'), 'utf8'));

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('i18n 字典', () => {
  it('key 集无重复', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('en/ru/pt 覆盖全部 key', () => {
    const missingEn = keys.filter((k) => !(k in en));
    const missingRu = keys.filter((k) => !(k in ru));
    const missingPt = keys.filter((k) => !(k in pt));
    expect(missingEn).toEqual([]);
    expect(missingRu).toEqual([]);
    expect(missingPt).toEqual([]);
  });

  it('en/ru/pt 不含 key 集之外的条目（抽取器与字典不能各说各话）', () => {
    const known = new Set(keys);
    expect(Object.keys(en).filter((k) => !known.has(k))).toEqual([]);
    expect(Object.keys(ru).filter((k) => !known.has(k))).toEqual([]);
    expect(Object.keys(pt).filter((k) => !known.has(k))).toEqual([]);
  });

  it('占位符集合四语一致', () => {
    const drift: string[] = [];
    for (const key of keys) {
      const base = placeholders(key).join(',');
      if (placeholders(en[key] ?? '').join(',') !== base) drift.push(`en: ${key}`);
      if (placeholders(ru[key] ?? '').join(',') !== base) drift.push(`ru: ${key}`);
      if (placeholders(pt[key] ?? '').join(',') !== base) drift.push(`pt: ${key}`);
    }
    expect(drift).toEqual([]);
  });

  it('en/ru/pt 不残留汉字', () => {
    const dirty: string[] = [];
    for (const key of keys) {
      if (HAN.test(en[key] ?? '')) dirty.push(`en: ${key}`);
      if (HAN.test(ru[key] ?? '')) dirty.push(`ru: ${key}`);
      if (HAN.test(pt[key] ?? '')) dirty.push(`pt: ${key}`);
    }
    expect(dirty).toEqual([]);
  });

  it('译文非空', () => {
    const empty: string[] = [];
    for (const key of keys) {
      if (!(en[key] ?? '').trim()) empty.push(`en: ${key}`);
      if (!(ru[key] ?? '').trim()) empty.push(`ru: ${key}`);
      if (!(pt[key] ?? '').trim()) empty.push(`pt: ${key}`);
    }
    expect(empty).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tr() 调用点可达性（BUG-1 回归闸）
//
// 为什么需要：抽取器把 key 一律空白折叠成单行（归一化契约），而 makeTr 运行时
// 查表**不做归一化**——多行模板串实参与单行 key 永远查不中，字典里译文再全也是
// 死信（DrscHealthBanner 的 GUIDE 事故）。这条盲区不在「字典质量」侧，在
// 「运行时实参 → 归一化 key 可达」侧，故单列一节钉住。
//
// 可达集与抽取器**同源**（esbuild metafile 从 entry.tsx 打包的 inputs）：
// 死文件（如 pill/SessionRecalledArea.tsx）的文案刻意不进字典，守卫同样不扫。
// ─────────────────────────────────────────────────────────────────────────────
const srcRoot = path.join(root, 'client/src');

function walkSrc(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkSrc(p));
    else if (/\.(tsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 与抽取器同口径的归一化：解常见转义 → 空白折叠 → trim。 */
function normalizeLiteral(raw: string): string {
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n|\\t/g, ' ')
    .replace(/\\(['"`\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** tr( 实参分类扫描：literal（引号串）/ template-expr（含 ${…} 的模板串，禁）/ identifier（标识符，另行裁决）。 */
interface TrSite {
  file: string;
  kind: 'literal' | 'template-expr' | 'identifier';
  text: string;
}

function scanTrSites(files: string[]): TrSite[] {
  const sites: TrSite[] = [];
  const re = /(?<![A-Za-z_$])tr\(\s*(?:(['"`])((?:\\.|(?!\1)[\s\S])*?)\1|([A-Za-z_$][\w$]*))/g;
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
      // 启发式剥注释（块注释整段、行注释整行；:// 保护 URL 字面量）
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const m of source.matchAll(re)) {
      if (m[2] !== undefined) {
        const isExpr = m[1] === '`' && m[2].includes('${');
        sites.push({ file, kind: isExpr ? 'template-expr' : 'literal', text: m[2] });
      } else if (m[3] !== undefined) {
        sites.push({ file, kind: 'identifier', text: m[3] });
      }
    }
  }
  return sites;
}

/** 收集「内容跨行的反引号模板串常量」名 → 声明文件（GUIDE 失败模式的绑定面）。 */
function multilineBacktickConsts(files: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const decl = /(?<![A-Za-z_$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*`/g;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(decl)) {
      const open = (m.index ?? 0) + m[0].length;
      const close = source.slice(open).search(/(?<!\\)`/);
      if (close < 0) continue;
      if (source.slice(open, open + close).includes('\n')) found.set(m[1]!, file);
    }
  }
  return found;
}

describe('tr() 调用点可达性', () => {
  let reachable: Set<string>;

  beforeAll(async () => {
    const g6Min = path.join(root, 'node_modules', '@antv', 'g6', 'dist', 'g6.min.js');
    const result = await build({
      entryPoints: [path.join(root, 'client/src/entry.tsx')],
      bundle: true,
      write: false,
      metafile: true,
      format: 'cjs',
      platform: 'browser',
      jsx: 'automatic',
      external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
      ...(existsSync(g6Min) ? { alias: { '@antv/g6': g6Min } } : {}),
      logLevel: 'silent',
    });
    reachable = new Set(Object.keys(result.metafile!.inputs).map((p) => path.resolve(root, p)));
  });

  function reachableFiles(): string[] {
    return walkSrc(srcRoot).filter((f) => reachable.has(path.resolve(f)));
  }

  it('tr(<字面量>) 归一化后全部 ∈ keys.json', () => {
    const known = new Set(keys);
    const missing: string[] = [];
    let literals = 0;
    for (const site of scanTrSites(reachableFiles())) {
      if (site.kind !== 'literal') continue;
      literals += 1;
      const key = normalizeLiteral(site.text);
      if (!known.has(key)) missing.push(`${path.relative(root, site.file)} :: ${key.slice(0, 60)}`);
    }
    expect(literals).toBeGreaterThan(1000);
    expect(missing).toEqual([]);
  });

  it('tr() 实参不得是多行反引号模板串（内联或常量绑定皆禁——GUIDE 事故形态）', () => {
    const files = reachableFiles();
    const multiline = multilineBacktickConsts(files);
    const offenders: string[] = [];
    for (const site of scanTrSites(files)) {
      if (site.kind === 'template-expr') offenders.push(`${path.relative(root, site.file)} :: 含 ${'{…}'} 的模板串`);
      if (site.kind === 'identifier' && multiline.has(site.text)) {
        offenders.push(`${path.relative(root, site.file)} :: tr(${site.text}) 绑定跨行模板串常量`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('installLocale 注册面（BUG-2 回归闸：字典在场 ≠ 已注册）', () => {
  it('zh/en/ru/pt 四语全部注册，pt 带自己的译文（修复前 pt.ts 从未被 import，pt 用户静默回退英文）', async () => {
    vi.resetModules();
    const registered: Array<{ ns: string; locale: string; dict: Record<string, string> }> = [];
    const svc: LocaleServiceLike = {
      register(ns, locale, dict) {
        registered.push({ ns, locale, dict });
        return {};
      },
      bind() {
        return (key: string) => key;
      },
      getSnapshot() {
        return { active: 'en', revision: 1 };
      },
      subscribe() {
        return () => {};
      },
    };
    const mod = await import('../client/src/i18n.js');
    mod.installLocale({ get: () => svc });
    const locales = registered.filter((r) => r.ns === 'dsh-prime-memory').map((r) => r.locale).sort();
    expect(locales).toEqual(['en', 'pt', 'ru', 'zh']);
    const ptDict = registered.find((r) => r.locale === 'pt')?.dict ?? {};
    expect(ptDict['重启 DSH Desktop']).toContain('Reinicie');
  });
});
/** 最小可用的 locale 服务替身：按 active → en → key 回退，与官方查找链同序。 */
function fakeLocale(active: string) {
  const dicts = new Map<string, Record<string, string>>();
  const listeners = new Set<() => void>();
  let current = active;
  let revision = 0;
  const svc: LocaleServiceLike & { setActive(locale: string): void } = {
    register(ns, locale, dict) {
      dicts.set(`${ns}:${locale}`, dict);
    },
    bind(ns) {
      return (key: string) => {
        for (const locale of [current, 'en']) {
          const dict = dicts.get(`${ns}:${locale}`);
          if (dict && key in dict) return dict[key]!;
        }
        return key;
      };
    },
    getSnapshot: () => ({ active: current, revision }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setActive(locale) {
      current = locale;
      revision += 1;
      for (const fn of listeners) fn();
    },
  };
  return svc;
}

describe('i18n 运行时', () => {
  const someKey = '记忆库';

  it('俄语生效时返回俄文，中文生效时返回中文原文', () => {
    const svc = fakeLocale('ru');
    registerDictionaries(svc, { en, ru });
    const tr = makeTr(svc);
    expect(tr(someKey)).toBe(ru[someKey]);
    svc.setActive('zh');
    expect(tr(someKey)).toBe(someKey);
  });

  it('查不到的 key 原样返回（不露裸占位、不抛）', () => {
    const svc = fakeLocale('ru');
    registerDictionaries(svc, { en, ru });
    expect(makeTr(svc)('这条文案不存在')).toBe('这条文案不存在');
  });

  it('占位符按参数填充，缺参时保留原样', () => {
    const svc = fakeLocale('zh');
    registerDictionaries(svc, { en, ru });
    const tr = makeTr(svc);
    expect(tr('已扫描 {p1} 行，筛出 {p2} 条', { p1: 12, p2: 3 })).toBe('已扫描 12 行，筛出 3 条');
    expect(tr('已扫描 {p1} 行')).toBe('已扫描 {p1} 行');
  });
});
