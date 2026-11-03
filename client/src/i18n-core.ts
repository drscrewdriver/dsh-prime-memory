/**
 * i18n 的**纯逻辑**（不依赖 React，可单测）：字典登记、key 回退、占位符填充。
 *
 * `i18n.ts` 是本模块的公开入口（再导出一切）+ `useLocaleRevision` 这个 React 钩子。
 * 拆开的理由：client 组件层不进 vitest（React 是外部依赖），但「翻译怎么回退、
 * 占位符怎么填」是纯函数，值得被 `tests/i18n-dict.test.ts` 钉住。
 */

/** 本插件在 locale 注册表里的命名空间。 */
export const I18N_NS = 'dsh-prime-memory';

/** locale 服务的最小结构面（官方包未随客户端发布类型，这里只建模用到的方法）。 */
export interface LocaleServiceLike {
  /** 单语言注册（未在 LocaleNamespaceMap 里声明的命名空间走这条）。 */
  register(ns: string, locale: string, dict: Record<string, string>): unknown;
  /** 绑定命名空间，返回 `(key, params?) => string`。 */
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string;
  /** 当前快照（含 revision，变更即 +1）。 */
  getSnapshot(): { active: string; revision: number };
  /** 快照订阅。 */
  subscribe(fn: () => void): () => void;
}

/** key 集 → 恒等映射（中文原文即 key，zh 不需要单独维护字典）。 */
export function identityOf(dict: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(dict)) out[key] = key;
  return out;
}

/** `{p1}` 占位填充。未提供的占位原样保留（可见即可修，不静默吞掉）。 */
export function fill(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * 把字典登记进 locale 服务。
 *
 * zh 由 en 的 key 集派生为恒等映射：中文用户在看英文回退链上永远不会被劫持成英文。
 * @param svc - locale 服务。
 * @param dicts - 各语言字典（key = 中文原文），`en` 是 key 集的事实来源。
 */
export function registerDictionaries(
  svc: LocaleServiceLike,
  dicts: { en: Record<string, string> } & Record<string, Record<string, string>>,
): void {
  svc.register(I18N_NS, 'zh', identityOf(dicts.en));
  for (const [locale, dict] of Object.entries(dicts)) svc.register(I18N_NS, locale, dict);
}

/**
 * 生成翻译函数：查表 + 占位符填充。
 *
 * @param svc - locale 服务。
 * @returns `(key, params?) => string`；查不到 key 时返回 key 本身（中文原文）。
 */
export function makeTr(svc: LocaleServiceLike): (key: string, params?: Record<string, unknown>) => string {
  const bound = svc.bind(I18N_NS);
  return (key, params) => {
    const text = bound(key);
    return params ? fill(text, params) : text;
  };
}