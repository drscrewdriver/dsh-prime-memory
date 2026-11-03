/**
 * 界面文案的本地化接入点 —— **可选服务，缺席即中文**。
 *
 * 为什么这样接：本插件的 client 半边只声明 `inject = ['slots']`（见 entry.tsx 的说明：
 * 声明式注入可选服务会让 apply 在缺席宿主上永久挂起，UI 静默消失）。locale 服务同理，
 * 因此这里用 `ctx.get('locale')` 懒解析 + 有界重试，拿不到就保持中文，绝不阻塞挂载。
 *
 * 文案的组织方式：**key = 中文原文**（gettext 式）。好处是抽取是机械的、与代码一一对应，
 * 新增文案只需写中文，翻译缺失时**优雅降级为中文原文**而不是露出裸 key。
 *
 * 目录：`client/src/locales/{en,ru}.ts`（zh 由 en 的 key 集运行期派生为恒等映射，
 * 这样中文用户在 locale 链上永远不会被英文回退劫持）。
 *
 * 支持多语言的前置条件是宿主装了语言包（例如 `@goodandready/dsh-russian-lang` 通过
 * `ctx.locale.addLanguage({ id: 'ru', … })` 把 ru 加进可选语言）。**本插件不自作主张
 * 注册语言**：语言选择器的所有权属于 locale 插件与语言包，插件只贡献自己的字典。
 */
import { useSyncExternalStore } from 'react';
import { en } from './locales/en.js';
import { ru } from './locales/ru.js';

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

let service: LocaleServiceLike | null = null;
let bound: ((key: string) => string) | null = null;
let attempted = false;

/**
 * 把本插件的字典登记进 locale 服务。
 *
 * @param ctx - client 上下文（只用 `get`，不声明式注入）。
 */
export function installLocale(ctx: { get(name: string): unknown }): void {
  if (attempted) return;
  attempted = true;
  const found = readService(ctx);
  if (found) {
    adopt(found);
    return;
  }
  // locale 可能晚于本插件 apply（宿主装载顺序不保证）：有界重试，拿不到就保持中文。
  for (const delay of [200, 1000, 3000]) {
    setTimeout(() => {
      if (service) return;
      const late = readService(ctx);
      if (late) adopt(late);
    }, delay);
  }
}

function readService(ctx: { get(name: string): unknown }): LocaleServiceLike | null {
  try {
    const svc = ctx.get('locale') as LocaleServiceLike | undefined;
    if (svc && typeof svc.register === 'function' && typeof svc.bind === 'function') return svc;
  } catch {
    /* 服务缺席/抛错：保持中文 */
  }
  return null;
}

function adopt(svc: LocaleServiceLike): void {
  try {
    // zh 恒等映射：中文用户走中文原文，不被 en 回退劫持；en 是 key 集的事实来源。
    svc.register(I18N_NS, 'zh', identityOf(en));
    svc.register(I18N_NS, 'en', en);
    svc.register(I18N_NS, 'ru', ru);
    const tr = svc.bind(I18N_NS);
    bound = (key: string) => tr(key);
    service = svc;
    console.info(`[dsh-prime-memory] locale 就绪：当前 ${svc.getSnapshot().active}`);
  } catch (err) {
    // 重复注册（HMR 重载）或服务实现不符：保持中文，不抛。
    console.warn('[dsh-prime-memory] locale 注册失败，界面保持中文:', err);
  }
}

function identityOf(dict: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(dict)) out[key] = key;
  return out;
}

/** `{p1}` 占位填充。未提供的占位原样保留（可见即可修，不静默吞掉）。 */
function fill(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * 翻译一条界面文案。
 *
 * @param key - 中文原文（`client/src/locales/keys.json` 的成员）。
 * @param params - `{p1}` 形式的具名参数。
 * @returns 当前语言下的文案；locale 缺席或该语言未覆盖时回中文原文。
 */
export function tr(key: string, params?: Record<string, unknown>): string {
  const text = bound ? bound(key) : key;
  return params ? fill(text, params) : text;
}

/** 稳定引用的订阅器：避免每次渲染换函数导致 useSyncExternalStore 反复重订阅。 */
function subscribe(onChange: () => void): () => void {
  return service ? service.subscribe(onChange) : () => {};
}

function snapshot(): number {
  return service ? service.getSnapshot().revision : 0;
}

/**
 * 订阅 locale 变更以触发重渲染。
 *
 * 只在**根组件**调用一次即可：根重渲染会带走整棵子树（本插件的组件都没有 React.memo）。
 * @returns 当前 locale revision（仅用于建立订阅，值本身不参与渲染）。
 */
export function useLocaleRevision(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}