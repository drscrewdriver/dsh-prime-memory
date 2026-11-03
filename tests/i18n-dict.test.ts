/**
 * i18n 字典守卫：key 集、占位符、语言纯净度。
 *
 * 为什么需要：字典是**生成物**（`scripts/i18n-merge.mjs`），而文案是**手写的**——
 * 新写一句中文就是新 key，没人会自动发现它没被翻译。这个用例把三条不变量钉死：
 *
 * 1. `keys.json` 无重复，且 en/ru 覆盖**全集**（缺 key 会静默回退中文，最难发现）；
 * 2. 占位符集合在三种语言里一致（漏掉 `{p1}` 会让数字/名称凭空消失）；
 * 3. en/ru 里不残留汉字（说明漏翻或复制粘贴）。
 *
 * 生成物过期时这里会红——重跑 `node scripts/i18n-extract.mjs && node scripts/i18n-merge.mjs <dir>`。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeTr, registerDictionaries, type LocaleServiceLike } from '../client/src/i18n-core.js';
import { en } from '../client/src/locales/en.js';
import { ru } from '../client/src/locales/ru.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keys: string[] = JSON.parse(readFileSync(path.join(root, 'client/src/locales/keys.json'), 'utf8'));

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('i18n 字典', () => {
  it('key 集无重复', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('en/ru 覆盖全部 key', () => {
    const missingEn = keys.filter((k) => !(k in en));
    const missingRu = keys.filter((k) => !(k in ru));
    expect(missingEn).toEqual([]);
    expect(missingRu).toEqual([]);
  });

  it('en/ru 不含 key 集之外的条目（抽取器与字典不能各说各话）', () => {
    const known = new Set(keys);
    expect(Object.keys(en).filter((k) => !known.has(k))).toEqual([]);
    expect(Object.keys(ru).filter((k) => !known.has(k))).toEqual([]);
  });

  it('占位符集合三语一致', () => {
    const drift: string[] = [];
    for (const key of keys) {
      const base = placeholders(key).join(',');
      if (placeholders(en[key] ?? '').join(',') !== base) drift.push(`en: ${key}`);
      if (placeholders(ru[key] ?? '').join(',') !== base) drift.push(`ru: ${key}`);
    }
    expect(drift).toEqual([]);
  });

  it('en/ru 不残留汉字', () => {
    const dirty: string[] = [];
    for (const key of keys) {
      if (HAN.test(en[key] ?? '')) dirty.push(`en: ${key}`);
      if (HAN.test(ru[key] ?? '')) dirty.push(`ru: ${key}`);
    }
    expect(dirty).toEqual([]);
  });

  it('译文非空', () => {
    const empty: string[] = [];
    for (const key of keys) {
      if (!(en[key] ?? '').trim()) empty.push(`en: ${key}`);
      if (!(ru[key] ?? '').trim()) empty.push(`ru: ${key}`);
    }
    expect(empty).toEqual([]);
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
