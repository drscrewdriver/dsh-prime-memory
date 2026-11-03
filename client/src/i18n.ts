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
 *
 * 纯逻辑（字典登记 / 回退 / 占位符）在 `i18n-core.ts`，由 `tests/i18n-dict.test.ts` 覆盖。
 */
import { type LocaleServiceLike, fill, makeTr, registerDictionaries } from './i18n-core.js';
import { en } from './locales/en.js';
import { ru } from './locales/ru.js';

export * from './i18n-core.js';

let service: LocaleServiceLike | null = null;
let translate: ((key: string, params?: Record<string, unknown>) => string) | null = null;
let attempted = false;
/** 语言服务尚未就绪时的订阅者：就绪后补订阅，并立刻回调一次（标签需要立刻改成当前语言）。 */
const pendingListeners = new Set<() => void>();

/**
 * 订阅语言变更（含「服务晚到」这一次）。
 *
 * 用途：求值时机在注册时的地方（例如槽位 `label`）无法在渲染期重取，只能重注册。
 * @param cb - 语言就绪或切换时回调。
 */
export function onLocaleChange(cb: () => void): void {
  if (service) {
    service.subscribe(cb);
    return;
  }
  pendingListeners.add(cb);
}

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

/** 当前 locale 服务（未就绪时 null）。供 `i18n-react.ts` 的订阅钩子使用。 */
export function getLocaleService(): LocaleServiceLike | null {
  return service;
}

function adopt(svc: LocaleServiceLike): void {
  try {
    registerDictionaries(svc, { en, ru });
    translate = makeTr(svc);
    service = svc;
    for (const cb of pendingListeners) svc.subscribe(cb);
    for (const cb of pendingListeners) cb();
    pendingListeners.clear();
    console.info(`[dsh-prime-memory] locale 就绪：当前 ${svc.getSnapshot().active}`);
  } catch (err) {
    // 重复注册（HMR 重载）或服务实现不符：保持中文，不抛。
    console.warn('[dsh-prime-memory] locale 注册失败，界面保持中文:', err);
  }
}

/**
 * 翻译一条界面文案。
 *
 * @param key - 中文原文（`client/src/locales/keys.json` 的成员）。
 * @param params - `{p1}` 形式的具名参数。
 * @returns 当前语言下的文案；locale 缺席或该语言未覆盖时回中文原文。
 */
export function tr(key: string, params?: Record<string, unknown>): string {
  if (translate) return translate(key, params);
  return params ? fill(key, params) : key;
}
