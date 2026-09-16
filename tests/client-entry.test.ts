/**
 * 客户端 bundle 的座位契约（0.1.1 / 0.1.2 / 0.1.5 三条宿主线）。
 *
 * ## 为什么有这个文件
 *
 * `client/src/entry.tsx` 曾长期只注册 `settings.section`（**0.1.1 契约**），
 * 而文件头注释却声称注册了 `settings.plugin.item`（0.1.2 契约）。注释与代码不符，
 * 加上本仓此前**没有任何客户端测试**，于是「设置面板在 0.1.2/0.1.5 上不可达」
 * 这件事既没被断言也没被人发现。
 *
 * 这个文件补上那套骨架：把 `dist/client.js` 按 handoff 协议在 VM 里跑起来，
 * 用**只在座位被声明时才触发**的假 slots（真实宿主语义）驱动三条宿主线。
 *
 * ## 它证明什么 / 不证明什么
 *
 * 证明：bundle 在每条宿主线上都把卡片注册到了该线声明的那个座位，且三条线互斥；
 * `inject` 只声明注册表（不含可选服务，避免 apply 永久挂起）。
 * 不证明：React 真的渲染出面板 —— 那仍然是真机 GUI 检查。
 *
 * ⚠️ 读的是**构建产物** `dist/client.js`，不是源码：改了 `client/src` 必须先
 * `npm run build` 再跑本测试，否则测的是旧产物。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'dist', 'client.js');
const PLUGIN_ID = 'dsh-prime-memory';

/** 三条宿主线各自声明的座位（除设置面板外，输入栏 pill 三条线都有）。 */
const INPUT_SEAT = 'conversation.input.left';
const TAB_SEAT = 'settings.plugins.tab'; // 0.1.5
const ITEM_SEAT = 'settings.plugin.item'; // 0.1.2 / 0.1.3
const SECTION_SEAT = 'settings.section'; // 0.1.1-rc.2
const HOST_015 = [TAB_SEAT, INPUT_SEAT];
const HOST_012 = [ITEM_SEAT, INPUT_SEAT];
const HOST_011 = [SECTION_SEAT, INPUT_SEAT];

/** 任意属性都返回可调用的桩：bundle 不渲染，只需这些模块能被 require 到。 */
function stubModule(): unknown {
  const target = function () {};
  return new Proxy(target, {
    get: (_t, prop) => {
      if (prop === Symbol.toStringTag) return 'Module';
      if (prop === 'Fragment') return {};
      return stubModule();
    },
    apply: () => ({}),
  });
}

/**
 * 供 require 解析的模块表。
 *
 * 判据不是「写死一张白名单」，而是**数据驱动**：允许集合 = react 基线 ∪
 * `package.json` 的 `dsh.client.inject` 清单。这样清单变了测试自动跟上，
 * 不会因为漏抄一个包名而假红。
 *
 * 另有一条硬禁令：**已退役的发布版专属包**（`dsh-client-runtime` / `dsh-client-store`）
 * 绝不允许出现 —— 这两个在 0.1.2/0.1.5 上互为专有，bundle 只要碰了其中一个，
 * 在另一条线加载时就炸（见 compatibility-guide §16A）。
 */
const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as {
  dsh?: { client?: { inject?: string[] } };
};
const REACT_BASELINE = ['react', 'react/jsx-runtime'];
const DECLARED = new Set([...REACT_BASELINE, ...(pkg.dsh?.client?.inject ?? [])]);
const RETIRED = /@deepseek-ai\/dsh-client-(runtime|store)(\/|$)/;

function documentStub(): unknown {
  const el = () => ({
    dataset: {}, style: {}, textContent: '', attributes: {}, className: '',
    setAttribute() {}, removeAttribute() {}, remove() {}, appendChild() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  });
  return {
    head: { appendChild: () => {} },
    documentElement: { style: {}, setAttribute() {}, removeAttribute() {} },
    body: el(),
    createElement: () => el(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
}

interface Loaded {
  exports: { apply: (ctx: unknown) => void; inject?: readonly string[] };
  seen: string[];
}

/** 按 handoff 协议跑起产物，返回其导出面与它 require 过的外部模块。 */
function loadBundle(): Loaded {
  const captured: Array<{ id: string; factory: (req: (s: string) => unknown) => unknown }> = [];
  const sandbox: Record<string, unknown> = {
    window: { __ModuleLoader__: { load: (reg: unknown) => captured.push(reg as never) } },
    document: documentStub(),
    MutationObserver: class { observe() {} disconnect() {} },
    queueMicrotask: (fn: () => void) => fn(),
    setTimeout, clearTimeout, console,
    fetch: () => Promise.reject(new Error('network is not available in this test')),
  };
  sandbox.globalThis = sandbox;
  runInNewContext(readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'dist/client.js' });

  expect(captured).toHaveLength(1);
  const reg = captured[0];
  // bundle 的 id 必须与包名一致：宿主 loader 三处（package.json / patch / bundle）同步要求
  expect(reg.id).toBe(PLUGIN_ID);

  const seen: string[] = [];
  const exports = reg.factory((spec: string) => {
    seen.push(spec);
    // 出现声明之外的宿主模块 = 包了没在清单里报备的依赖；退役包更是硬禁令
    if (!DECLARED.has(spec)) throw new Error(`undeclared require "${spec}"`);
    return stubModule();
  }) as Loaded['exports'];
  return { exports, seen };
}

/** 记录注册动作的假宿主；`inject` 只在座位**被声明**时触发（真实语义）。 */
function clientCtx(declaredSlots: readonly string[]) {
  const ledger: Array<Record<string, unknown>> = [];
  const disposer = () => {};
  const declared = new Set(declaredSlots);
  const slots = {
    inject: (name: string, factory: () => unknown) => {
      if (declared.has(name)) factory();
      return disposer;
    },
    register: (options: Record<string, unknown>) => {
      ledger.push(options);
      return disposer;
    },
  };
  return { ctx: { slots, get: () => undefined }, ledger };
}

/** 某条宿主线下 apply，返回注册账本。 */
function applyOn(declaredSlots: readonly string[]): Array<Record<string, unknown>> {
  const { exports } = loadBundle();
  const { ctx, ledger } = clientCtx(declaredSlots);
  exports.apply(ctx);
  return ledger;
}

describe('客户端 bundle 的装载契约', () => {
  it('按 handoff 协议注册，且 id 与包名一致', () => {
    const { exports } = loadBundle();
    expect(typeof exports.apply).toBe('function');
  });

  it('只 require 已声明的模块(不越界引用未报备的宿主包)', () => {
    const { seen } = loadBundle();
    const undeclared = [...new Set(seen)].filter((s) => !DECLARED.has(s));
    expect(undeclared, `bundle required modules missing from dsh.client.inject: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('不引用已退役的发布版专属包(dsh-client-runtime / dsh-client-store)', () => {
    const { seen } = loadBundle();
    const retired = [...new Set(seen)].filter((s) => RETIRED.test(s));
    expect(retired, `bundle must not require release-specific modules: ${retired.join(', ')}`).toEqual([]);
  });

  it('inject 只声明 slots —— 声明可选服务会让 apply 永久挂起(UI 全静默消失)', () => {
    const { exports } = loadBundle();
    expect(exports.inject).toEqual(['slots']);
  });
});

describe('设置面板座位随宿主线择一', () => {
  it('0.1.5 线(声明 settings.plugins.tab)→ 注册 tab 座位', () => {
    const ledger = applyOn(HOST_015);
    const card = ledger.find((o) => o.name === TAB_SEAT);
    expect(card, `expected a ${TAB_SEAT} registration, got ${JSON.stringify(ledger.map((o) => o.name))}`).toBeDefined();
    expect(card!.id).toBe('dsh-memory');
    expect(typeof card!.order).toBe('number');
    expect(typeof card!.label).toBe('string');
    expect(typeof card!.inject).toBe('function');
    expect((card!.inject as () => { rpc: unknown })().rpc).toBeTypeOf('function');
  });

  it('0.1.2 线(声明 settings.plugin.item)→ 注册 item 座位,且 id/key 双写', () => {
    const ledger = applyOn(HOST_012);
    const card = ledger.find((o) => o.name === ITEM_SEAT);
    expect(card, `expected a ${ITEM_SEAT} registration, got ${JSON.stringify(ledger.map((o) => o.name))}`).toBeDefined();
    // CLI dsh 把该座位声明成 keyed(要 key)、DSH Desktop 声明成 list(要 id)：
    // 少给一个就在其中一处注册失败
    expect(card!.id).toBe('dsh-memory');
    expect(card!.key).toBe('dsh-memory');
  });

  it('0.1.1 线(声明 settings.section)→ 注册 section 座位', () => {
    const ledger = applyOn(HOST_011);
    expect(ledger.map((o) => o.name)).toContain(SECTION_SEAT);
  });

  it('三条线互斥 —— 每个宿主只注册自己声明的那一个座位', () => {
    const names = (seats: readonly string[]) => applyOn(seats).map((o) => o.name);
    const on015 = names(HOST_015);
    expect(on015).toContain(TAB_SEAT);
    expect(on015).not.toContain(ITEM_SEAT);
    expect(on015).not.toContain(SECTION_SEAT);

    const on012 = names(HOST_012);
    expect(on012).toContain(ITEM_SEAT);
    expect(on012).not.toContain(TAB_SEAT);

    const on011 = names(HOST_011);
    expect(on011).toContain(SECTION_SEAT);
    expect(on011).not.toContain(TAB_SEAT);
    expect(on011).not.toContain(ITEM_SEAT);
  });

  it('输入栏 pill 在三条线上都注册(它不是设置面板，不受座位改名影响)', () => {
    for (const line of [HOST_015, HOST_012, HOST_011]) {
      expect(applyOn(line).map((o) => o.name)).toContain(INPUT_SEAT);
    }
  });

  it('注册的都是同一个面板组件，且不重复注册同一个座位', () => {
    const ledger = applyOn(HOST_015);
    const settingsCards = ledger.filter((o) => String(o.name).startsWith('settings.'));
    expect(settingsCards).toHaveLength(1);
  });
});
