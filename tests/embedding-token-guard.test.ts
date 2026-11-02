/**
 * #22 嵌入子进程 token 护栏 —— 跨平台可证伪测试。
 *
 * 设计约束(为什么不是「跑真模型看崩不崩」):
 * - SIGTRAP 只在 macOS/Electron 分配器上出现(栈 malloc_zone_memalign),本机 Windows
 *   **无法复现也无法发出**(process.kill(SIGTRAP) 在 Windows 抛 EINVAL)。所以本文件测的是
 *   「进入模型的 token 数是否受预算约束」与「被信号杀是否可归因」这两个**平台无关**的判据,
 *   崩溃本身的消失由 #22 报告人在 macOS 用其 1:1 复现脚本回验。
 * - token 截断只能发生在子进程(tokenizer 只在加载后的 pipeline 上可达、ORT run() 同步不可
 *   中断),故 `shrinkToBudget` 做成显式形参 + 可 require,用桩 tokenizer 零模型验证。
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { memorySchema } from '../src/config.js';
import { deriveTokenBudget, HARD_CAP_TOKENS } from '../src/store/model-catalog.js';
import { describeExit } from '../src/store/local-embedding.js';

const require = createRequire(import.meta.url);
// 只 require 无副作用的纯模块。`embedding-child.cjs` 本身不可被测试载入:它是 fork 入口,
// 顶层有 process.on('message'/'disconnect'/'uncaughtException') 与「无 IPC 就 exit」守卫,
// 在 vitest worker 里载它会崩在收集期(实测 TypeError: reading 'config')。
const guard = require('../resources/embedding-token-guard.cjs') as {
  shrinkToBudget(raw: string, maxTokens: number, tok: unknown): string;
};
const childShrink = guard.shrinkToBudget;

/**
 * 确定性桩 tokenizer:一个字符一个 token(即 CJK 的真实形态,也是最坏形态)。
 * encode/decode 都带 special token 语义,用来逼出 +2 留位与「不认选项就退回原文」的降级路径。
 */
function stubTokenizer(
  opts: { throwOn?: 'encode' | 'decode'; tensorWhenOptionMissing?: boolean; alwaysTensor?: boolean; decodeEmpty?: boolean } = {},
) {
  const calls: Array<{ fn: 'encode' | 'decode'; raw: string | number[]; arg?: unknown }> = [];
  return {
    calls,
    encode(raw: string, arg?: unknown) {
      calls.push({ fn: 'encode', raw, arg });
      if (opts.throwOn === 'encode') throw new Error('no truncation support');
      const ids = Array.from(raw, (ch) => ch.codePointAt(0) ?? 0);
      const askedTensorOff = !!arg && (arg as { return_tensor?: boolean }).return_tensor === false;
      // 实测陷阱复现:return_tensor 缺省为 true 时给的是 _Tensor(.length undefined 且不抛错)
      if (opts.alwaysTensor || (opts.tensorWhenOptionMissing && !askedTensorOff)) {
        return { data: ids }; // 无 length 的张量形状
      }
      return ids;
    },
    decode(ids: number[], arg?: unknown) {
      calls.push({ fn: 'decode', raw: ids, arg });
      if (opts.throwOn === 'decode') throw new Error('decode unsupported');
      if (opts.decodeEmpty) return '';
      const skip = (arg as { skip_special_tokens?: boolean } | undefined)?.skip_special_tokens === true;
      const body = String.fromCharCode(...ids);
      return skip ? body : `[CLS]${body}[SEP]`;
    },
  };
}

describe('#22 token 预算推导(单一真值来源)', () => {
  it('默认走「模型窗口与硬上限取小」,不是无条件 2048', () => {
    // bge-m3 窗口 8192 → 被 HARD_CAP 压到 2048
    expect(deriveTokenBudget(8192, undefined)).toEqual({ tokens: HARD_CAP_TOKENS, clamped: false });
    expect(deriveTokenBudget(8192, 0)).toEqual({ tokens: HARD_CAP_TOKENS, clamped: false });
    // bge-small-zh 窗口 512 → 由模型窗口决定,HARD_CAP 不起作用
    expect(deriveTokenBudget(512, undefined)).toEqual({ tokens: 512, clamped: false });
    // embeddinggemma 窗口 2048 → 两值同
    expect(deriveTokenBudget(2048, undefined)).toEqual({ tokens: 2048, clamped: false });
  });

  it('取不到窗口(非目录模型)回退硬上限,取小不取大', () => {
    expect(deriveTokenBudget(undefined, undefined).tokens).toBe(HARD_CAP_TOKENS);
    expect(deriveTokenBudget(0, undefined).tokens).toBe(HARD_CAP_TOKENS);
    expect(deriveTokenBudget(-1, undefined).tokens).toBe(HARD_CAP_TOKENS);
  });

  it('用户显式值:窗口内照收,超限 clamp 并标记(不抛错)', () => {
    expect(deriveTokenBudget(8192, 1600)).toEqual({ tokens: 1600, clamped: false });
    // 必崩值:10 万 token 远超限 → 压到 cap 且 clamped=true(调用方据此 warn)
    expect(deriveTokenBudget(8192, 100_000)).toEqual({ tokens: HARD_CAP_TOKENS, clamped: true });
    // 用户值也受模型窗口约束:给 bge-small 配 4096 仍落到 512
    expect(deriveTokenBudget(512, 4096)).toEqual({ tokens: 512, clamped: true });
  });

  it('硬上限必须显著低于 #22 实测致死线 2700', () => {
    // 护栏的意义在于「比死线低」,数值一旦被人上调到死线之上,本断言即红
    expect(HARD_CAP_TOKENS).toBeLessThan(2700);
    expect(HARD_CAP_TOKENS).toBeGreaterThan(0);
  });
});

describe('#22 shrinkToBudget(token 精截,子进程实际执行的那份实现)', () => {
  it('最坏情形:中文一个字符一个 token,超限必须裁到预算内', () => {
    const budget = 2048;
    // 3800 个中文字符 = 3800 token,超预算;这是 #22 报告里「全部 SIGTRAP」的那一档
    const raw = '记'.repeat(3800);
    const out = childShrink(raw, budget, stubTokenizer());
    expect(out.length).toBeLessThanOrEqual(budget);
    // 留了 special token 位:不是刚好 2048 而是 2046
    expect(out.length).toBe(budget - 2);
  });

  it('未超限原样返回(不得裁短可用的长文本)', () => {
    const tok = stubTokenizer();
    const raw = '短文本'.repeat(10); // 30 token
    expect(childShrink(raw, 2048, tok)).toBe(raw);
    // 关键:仍然调用了 encode 去**实测**,而不是靠字符数启发式跳过
    expect(tok.calls.filter((c) => c.fn === 'encode').length).toBe(1);
  });

  it('不靠字符长度猜 token 数(旧启发式的漏判情形)', () => {
    // 500 个英文字符按 CHARS_PER_TOKEN=4 估算是 125 token「很安全」,
    // 但桩 tokenizer 给的是逐字符 = 500 token;预算 200 时必须裁。
    const raw = 'a'.repeat(500);
    const out = childShrink(raw, 200, stubTokenizer());
    expect(out.length).toBe(198);
  });

  it('降级路径一律退回粗筛原文:护栏不得搞坏能跑的链路', () => {
    const raw = '记'.repeat(3800);
    // tokenizer 不可达
    expect(childShrink(raw, 2048, null)).toBe(raw);
    // 预算未给(旧主进程 + 新子进程的版本错配情形)
    expect(childShrink(raw, 0, stubTokenizer())).toBe(raw);
    // encode 抛错(老版 transformers 不认选项)
    expect(childShrink(raw, 2048, stubTokenizer({ throwOn: 'encode' }))).toBe(raw);
    // decode 抛错
    expect(childShrink(raw, 2048, stubTokenizer({ throwOn: 'decode' }))).toBe(raw);
    // decode 回空串
    expect(childShrink(raw, 2048, stubTokenizer({ decodeEmpty: true }))).toBe(raw);
  });

  it('实测陷阱:return_tensor 必须显式关掉(否则拿到的是没有 length 的张量)', () => {
    const raw = '记'.repeat(3800);
    // 桩 A:忠实库行为 —— 不显式传 return_tensor:false 就给 _Tensor(.length undefined 且不报错)
    const tok = stubTokenizer({ tensorWhenOptionMissing: true });
    childShrink(raw, 2048, tok);
    const enc = tok.calls.find((c) => c.fn === 'encode');
    expect((enc?.arg as { return_tensor?: boolean })?.return_tensor).toBe(false);
    // 带了选项 -> 拿到数组 -> 确实裁了(而不是静默地「测不到长度就不裁」)
    expect(childShrink(raw, 2048, tok)).not.toBe(raw);

    // 桩 B:不管传什么选项都给张量(异常/老版形态) -> 必须退回原文,不得抛错、不得猜长度
    const always = stubTokenizer({ alwaysTensor: true });
    expect(childShrink(raw, 2048, always)).toBe(raw);
  });

  it('实测陷阱:decode 必须 skip_special_tokens,否则 [CLS]/[SEP] 被编回文本二次分词', () => {
    const tok = stubTokenizer();
    childShrink('记'.repeat(3800), 2048, tok);
    const dec = tok.calls.find((c) => c.fn === 'decode');
    expect((dec?.arg as { skip_special_tokens?: boolean })?.skip_special_tokens).toBe(true);
  });

  it('预算极小的退化边界:不得裁出空文本', () => {
    const out = childShrink('记'.repeat(50), 1, stubTokenizer());
    expect(out.length).toBeGreaterThan(0);
    // 也要尊重预算:预算 1 时留位后至少保 1 个字符,不能反向膨胀
    expect(out.length).toBeLessThanOrEqual(50);
  });
});

/**
 * 接线契约哨兵。
 *
 * 为什么需要它:上面的用列都是直接调 `shrinkToBudget`(拿不到真 tokenizer 时唯一可跑的
 * 办法),它们**测不到调用点**。实测证据:把 `pump()` 里那一行改成 `const sent = screened;`
 * (即整体断开护栏),13 例仍全绿——而 #22 恰恰是「护栏存在但单位错」那一类缺陷。
 *
 * 所以本组只能做到字符串级契约断言(沿 src/smoke.ts 对子进程产物的同型做法):
 * 它保证「不接线」与「预算不传给子进程」这两类回归会红,不能保证真跑通了推理。
 * 真进模型的 token 数另由 tokensMax 实测上报(需真模型,见下方标注)。
 */
describe('#22 接线契约(哨兵级,非运行时证明)', () => {
  const childSrc = readFileSync(new URL('../resources/embedding-child.cjs', import.meta.url), 'utf-8');
  const copySrc = readFileSync(new URL('../scripts/copy-client.mjs', import.meta.url), 'utf-8');

  it('子进程推理入口必须把精截接在实际送模型的那条文本上', () => {
    // 护栏必须参与 pump() 的送模型行,而不是只作为一个导出的死函数存在
    expect(childSrc).toMatch(/const sent = shrinkToBudget\(screened, MAX_INPUT_TOKENS, tokenizer\);/u);
    expect(childSrc).toMatch(/extractor\(\[sent\]/u); // 送的是截断后的 sent,不是 screened
  });

  it('子进程必须载到纯模块,且构建拷贝清单含它(漏拷 = 子进程起不来的硬故障)', () => {
    expect(childSrc).toMatch(/require\('\.\/embedding-token-guard\.cjs'\)/u);
    expect(copySrc).toMatch(/resources', 'embedding-token-guard\.cjs'/u);
    expect(copySrc).toMatch(/dist', 'embedding-token-guard\.cjs'/u);
  });

  it('预算必须从 cfg 读取并在旧主进程未传时自然关闭(不猜值)', () => {
    expect(childSrc).toMatch(/const MAX_INPUT_TOKENS = cfg\.maxInputTokens > 0 \? cfg\.maxInputTokens : 0;/u);
  });

  it('主进程必须把预算装进 DSH_EMBED_CFG(漏装 = 子进程永远拿 0 = 护栏形同不存在)', () => {
    const localSrc = readFileSync(new URL('../src/store/local-embedding.ts', import.meta.url), 'utf-8');
    expect(localSrc).toMatch(/maxInputTokens: budget\.tokens,/u);
    // 预算只应从 deriveTokenBudget 推导,不得就地硬编码数字
    expect(localSrc).toMatch(/deriveTokenBudget\(entry\.contextTokens, opts\.maxInputTokens\)/u);
  });

  it('单一真值来源:HARD_CAP_TOKENS 不得在子进程/服务层被重新写一遍', () => {
    // 预算数字只允许出现在 model-catalog.ts(防「两处 ?:5000」同类漂移重现)
    expect(childSrc).not.toMatch(/\b2048\b/u);
    const localSrc = readFileSync(new URL('../src/store/local-embedding.ts', import.meta.url), 'utf-8');
    expect(localSrc).not.toMatch(/maxInputTokens[^\n]*\b2048\b/u);
    const catalogSrc = readFileSync(new URL('../src/store/model-catalog.ts', import.meta.url), 'utf-8');
    expect(catalogSrc).toMatch(/export const HARD_CAP_TOKENS = 2048;/u);
  });

  it('嵌入预算路径不得复用上下文占用的 CHARS_PER_TOKEN=4(中文会低估 4 倍)', () => {
    const localSrc = readFileSync(new URL('../src/store/local-embedding.ts', import.meta.url), 'utf-8');
    const childSrc2 = readFileSync(new URL('../resources/embedding-child.cjs', import.meta.url), 'utf-8');
    expect(localSrc).not.toMatch(/CHARS_PER_TOKEN/u);
    expect(childSrc2).not.toMatch(/CHARS_PER_TOKEN/u);
  });
});

type EmbCfg = { embedding: { maxInputChars: number; maxInputTokens: number; dimensions: number } };

describe('#22 配置面回归(只增不改——防「改名=无声失效」)', () => {
  it('缺省值不动 maxInputChars 的 5000(已部署 YAML 行为不得变)', () => {
    const cfg = memorySchema({}) as EmbCfg;
    expect(cfg.embedding.maxInputChars).toBe(5000);
    expect(cfg.embedding.maxInputTokens).toBe(0); // 0 = 自动推导
  });

  it('旧键显式值仍被读(实测 schemastery 未知键静默透传,改名会让值无声回落)', () => {
    const cfg = memorySchema({ embedding: { maxInputChars: 1200 } }) as EmbCfg;
    expect(cfg.embedding.maxInputChars).toBe(1200);
  });

  it('新键被读且不抢旧键的语义', () => {
    const cfg = memorySchema({ embedding: { maxInputChars: 3000, maxInputTokens: 1600 } }) as EmbCfg;
    expect(cfg.embedding.maxInputChars).toBe(3000);
    expect(cfg.embedding.maxInputTokens).toBe(1600);
  });

  it('maxInputChars 边界未收窄(收窄会让已部署 YAML 直接解析抛错)', () => {
    expect(() => memorySchema({ embedding: { maxInputChars: 100_000 } })).not.toThrow();
    // 超出旧外壁仍然报错——说明区间还在,只是不再被当作安全护栏
    expect(() => memorySchema({ embedding: { maxInputChars: 100_001 } })).toThrow();
  });

  it('新键超大值**不抛错**(护栏靠 clamp+warn 而非配置树爆炸;必崩值也能加载起来)', () => {
    expect(() => memorySchema({ embedding: { maxInputTokens: 100_000 } })).not.toThrow();
    const cfg = memorySchema({ embedding: { maxInputTokens: 100_000 } }) as EmbCfg;
    // schema 不拦,由 deriveTokenBudget 压到上限
    expect(deriveTokenBudget(8192, cfg.embedding.maxInputTokens).tokens).toBe(HARD_CAP_TOKENS);
  });
});

describe('#22 退出归因(signal 不得丢弃)', () => {
  it('被信号硬杀时 code===null + signal 可读,三者形态互不相同', () => {
    // SIGTRAP(#22 的真实形态):旧实现只打 code,得到的是「code=null」——与 OOM-kill 无法区分
    expect(describeExit('本地嵌入子进程', null, 'SIGTRAP')).toContain('signal=SIGTRAP');
    expect(describeExit('本地嵌入子进程', null, 'SIGKILL')).toContain('signal=SIGKILL');
    // 自然退出
    expect(describeExit('本地嵌入子进程', 0, null)).toContain('code=0');
    expect(describeExit('本地嵌入子进程', 0, null)).toContain('signal=null');
    // 异常退出码
    expect(describeExit('本地嵌入子进程', 1, null)).toContain('code=1');
  });

  it('崩溃串向上传为 loadError,故一处修三处可见', async () => {
    // 说明:真通道的 signal 需要子进程被信号杀,Windows 上无法发 SIGTRAP(EINVAL),
    // 这里覆盖的是「signal 进入 crashed 串 → 成为 loadError → 出现在 embedBatch 抛错文本」
    // 这条链路本身(用注入通道模拟带 signal 的崩溃文案)。
    const { LocalEmbeddingService } = await import('../src/store/local-embedding.js');
    let crashCb: ((e: string) => void) | undefined;
    const channel = {
      request: async () => ({ id: 0, ok: true, type: 'ready' }) as never,
      terminate: () => {},
      setOnCrash: (cb: (e: string) => void) => {
        crashCb = cb;
      },
    };
    const svc = new LocalEmbeddingService(
      {
        id: 'fake', name: 'f', repo: 'x/f', revision: 'r', dims: 4, contextTokens: 8192,
        pooling: 'cls', tags: [], description: '', files: [],
      },
      '/tmp/models/fake',
      { runtimeDir: '/tmp/runtime', channel: channel as never },
    );
    crashCb?.(describeExit('本地嵌入子进程', null, 'SIGTRAP'));
    expect(svc.getState()).toBe('failed');
    expect(svc.getLoadError()).toContain('SIGTRAP');
    await expect(svc.embedBatch(['x'])).rejects.toThrow(/SIGTRAP/u);
  });
});
