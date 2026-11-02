/**
 * #22 嵌入子进程 token 护栏 —— 跨平台可证伪测试。
 *
 * 设计约束(为什么不是「跑真模型看崩不崩」):
 * - SIGTRAP 只在 macOS/Electron 分配器上出现(栈 malloc_zone_memalign),本机 Windows
 *   **无法复现也无法发出**(process.kill(SIGTRAP) 在 Windows 抛 EINVAL)。所以本文件测的是
 *   「进入模型的 token 数是否受预算约束」与「被信号杀是否可归因」这两个**平台无关**的判据;
 *   真模型实证见 scripts/verify-token-guard-realmodel.mjs(可选跑,不进 CI)。
 * - token 截断只能发生在子进程(tokenizer 只在加载后的 pipeline 上可达、ORT run() 同步不可
 *   中断),故 `shrinkToBudget` 做成无副作用纯模块 + 显式形参,用桩 tokenizer 零模型验证。
 *
 * 为什么预算不靠「budget-2 留位」推断:真 bge-m3 实测 2046 个 id 解码后重分词得 2045 token,
 * 加 special token = 2047(预算 2048 仅剩 1 位)——漂移真实存在。护栏改为**按库口径实测并逐轮
 * 收紧**,本文件的桩件因此必须同时提供 `encode/decode` 与**可调用形式** `tok(text, opts)`。
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { memorySchema } from '../src/config.js';
import { deriveTokenBudget, HARD_CAP_TOKENS } from '../src/store/model-catalog.js';
import { describeExit, describeEmbedBatch } from '../src/store/local-embedding.js';

const require = createRequire(import.meta.url);
// 只 require 无副作用的纯模块。`embedding-child.cjs` 是 fork 专用入口,顶层有 process.on 与
// 「无 IPC 就 exit」守卫——测试载它会把全局监听装进 vitest worker（实测会让同 worker 的
// memory-md-sync 用例转红）。对 child 只作下方「接线契约」的字面断言;它的真行为由
// scripts/verify-token-guard-realmodel.mjs 用真 bge-m3 实测。
const guard = require('../resources/embedding-token-guard.cjs') as {
  shrinkToBudget(raw: string, maxTokens: number, tok: unknown): { text: string; seq: number };
  seqLenOf(tok: unknown, text: string): number;
};
const childShrink = guard.shrinkToBudget;

/**
 * 确定性桩 tokenizer:默认**一个字符一个 token**(即 CJK 的真实形态,也是最坏形态),
 * 且可配置**二次分词漂移量**——用来逼出「留位不够时逐轮收紧」这条桩默认测不到的路径。
 *
 * `special` = 库补上的 special token 数(真 bge-m3 实测 +2)。
 */
function stubTokenizer(
  opts: {
    throwOn?: 'encode' | 'decode' | 'call';
    tensorWhenOptionMissing?: boolean;
    alwaysTensor?: boolean;
    decodeEmpty?: boolean;
    drift?: number;
    special?: number;
  } = {},
) {
  const calls: Array<{ fn: 'encode' | 'decode' | 'call'; raw: string | number[]; arg?: unknown }> = [];
  const special = opts.special ?? 2;
  // 库口径:seq = 字符数 + special + 漂移。这是 pipeline 真正会送进模型的长度。
  const libSeq = (text: string) => text.length + special + (opts.drift ?? 0);
  const askedTensorOff = (arg: unknown) =>
    !!arg && (arg as { return_tensor?: boolean }).return_tensor === false;

  const tok = ((text: string, arg?: unknown) => {
    calls.push({ fn: 'call', raw: text, arg });
    if (opts.throwOn === 'call') throw new Error('tokenizer call unsupported');
    return { input_ids: { dims: [1, libSeq(text)] } };
  }) as unknown as {
    (text: string, arg?: unknown): { input_ids: { dims: number[] } };
    encode(raw: string, arg?: unknown): unknown;
    decode(ids: number[], arg?: unknown): string;
    calls: typeof calls;
    libSeq: typeof libSeq;
  };

  (tok as { calls: typeof calls }).calls = calls;
  (tok as { libSeq: typeof libSeq }).libSeq = libSeq;
  tok.encode = (raw: string, arg?: unknown) => {
    calls.push({ fn: 'encode', raw, arg });
    if (opts.throwOn === 'encode') throw new Error('no truncation support');
    const ids = Array.from(raw, (ch) => ch.codePointAt(0) ?? 0);
    // 实测陷阱复现:return_tensor 缺省为 true 时给的是 _Tensor(无 .length 且不抛错)
    if (opts.alwaysTensor || (opts.tensorWhenOptionMissing && !askedTensorOff(arg))) return { data: ids };
    return ids;
  };
  tok.decode = (ids: number[], arg?: unknown) => {
    calls.push({ fn: 'decode', raw: ids, arg });
    if (opts.throwOn === 'decode') throw new Error('decode unsupported');
    if (opts.decodeEmpty) return '';
    const skip = (arg as { skip_special_tokens?: boolean } | undefined)?.skip_special_tokens === true;
    const body = String.fromCharCode(...ids);
    return skip ? body : `[CLS]${body}[SEP]`;
  };
  return tok;
}

describe('#22 token 预算推导(单一真值来源)', () => {
  it('默认走「模型窗口与硬上限取小」,不是无条件硬上限', () => {
    expect(deriveTokenBudget(8192, undefined)).toEqual({ tokens: HARD_CAP_TOKENS, clamped: false });
    expect(deriveTokenBudget(8192, 0)).toEqual({ tokens: HARD_CAP_TOKENS, clamped: false });
    expect(deriveTokenBudget(512, undefined)).toEqual({ tokens: 512, clamped: false });
    expect(deriveTokenBudget(HARD_CAP_TOKENS, undefined)).toEqual({ tokens: HARD_CAP_TOKENS, clamped: false });
  });

  it('取不到窗口(非目录模型)回退硬上限,取小不取大', () => {
    expect(deriveTokenBudget(undefined, undefined).tokens).toBe(HARD_CAP_TOKENS);
    expect(deriveTokenBudget(0, undefined).tokens).toBe(HARD_CAP_TOKENS);
    expect(deriveTokenBudget(-1, undefined).tokens).toBe(HARD_CAP_TOKENS);
  });

  it('用户显式值:窗口内照收,超限 clamp 并标记(不抛错)', () => {
    const under = Math.max(1, HARD_CAP_TOKENS - 448); // 总取一个低于硬上限的值,不贴魔数
    expect(deriveTokenBudget(8192, under)).toEqual({ tokens: under, clamped: false });
    expect(deriveTokenBudget(8192, 100_000)).toEqual({ tokens: HARD_CAP_TOKENS, clamped: true });
    expect(deriveTokenBudget(512, 4096)).toEqual({ tokens: 512, clamped: true });
  });

  it('硬上限必须低于 **#22 报告人 macOS 二分的「连发」致死线**,不是单发线', () => {
    // 真实负载是连发：graph 投影逐条 `await embed()`，一个批里常有 5～8 个节点。
    // 报告人实测：1960 串行全过、1990 起第 2 条即 SIGTRAP → 连发致死线 = 1960 以下。
    // 单发线≈2700 不得当依据（0.26.25 就是按单发线取 2048，连发仍会崩）。
    const SERIAL_DEATH_LINE = 1960;
    expect(HARD_CAP_TOKENS).toBeLessThan(SERIAL_DEATH_LINE);
    expect(HARD_CAP_TOKENS).toBeGreaterThan(0);
  });
});

describe('#22 shrinkToBudget(按库口径实测,而不是按字符猜)', () => {
  it('最坏情形:中文一字符一 token,超限必须裁到预算内并回报实测 seq', () => {
    const out = childShrink('记'.repeat(3800), HARD_CAP_TOKENS, stubTokenizer());
    expect(out.seq).toBeLessThanOrEqual(HARD_CAP_TOKENS);
    expect(out.seq).toBeGreaterThan(0);
    expect(out.text.length).toBe(out.seq - 2); // 桩口径:seq = 字符数 + 2 special
  });

  it('漂移较小时首轮就能收敛,且结果仍满足预算(不靠常数留位碰运气)', () => {
    // 不断精确长度（属实现细节）：首轮的 cut 用**原始 ids 长度**与**库口径 base** 相减,
    // 两者各自含 special token,故结果天然留了 ≈4 位富余。要断的是契约：收到预算内且真的截了。
    const tok = stubTokenizer({ drift: 3 });
    const out = childShrink('记'.repeat(5000), HARD_CAP_TOKENS, tok);
    expect(out.seq).toBeGreaterThan(0);
    expect(out.seq).toBeLessThanOrEqual(HARD_CAP_TOKENS);
    expect(out.text.length).toBeLessThan(5000);
    // 首轮就达标:不得出现无意义的多轮重试
    expect(tok.calls.filter((c) => c.fn === 'decode').length).toBe(1);
  });

  it('首轮递降过头时确实重算下一轮,而不是停在错值上', () => {
    // 预算取极小值使递降过冲：算法仍须报出**实测**值而非碰运气的目标值
    const tok = stubTokenizer({ special: 1 });
    const out = childShrink('记'.repeat(11), 10, tok);
    expect(out.seq).toBe(8);
    expect(out.seq).toBeLessThanOrEqual(10);
    expect(tok.calls.filter((c) => c.fn === 'decode').length).toBe(1);
  });

  it('special token 占额很大时,按实测超出量递降仍能收敛(不靠常数留位)', () => {
    // 库补 900 个 special token：固定留位（只减 2）会直接越界，必须靠实测超出量收到位
    const out = childShrink('记'.repeat(5000), HARD_CAP_TOKENS, stubTokenizer({ special: 900 }));
    expect(out.seq).toBeGreaterThan(0);
    expect(out.seq).toBeLessThanOrEqual(HARD_CAP_TOKENS);
    // 真的收到了 900 以外的量级：文本长度必须远小于原文,且不得为负
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text.length).toBeLessThan(HARD_CAP_TOKENS);
  });

  it('库口径不可用时降级报 -1（不可证），不拿算不清的数当安全证据', () => {
    const raw = '记'.repeat(3800);
    // 库口径不可用(抛错) -> seq 不可证
    expect(childShrink(raw, HARD_CAP_TOKENS, stubTokenizer({ throwOn: 'call' }))).toEqual({ text: raw, seq: -1 });
  });
  
  it('未超限的文本仍按库口径实测一次,不因「ids 不超」就免检', () => {
    const tok = stubTokenizer();
    const raw = '短文本'.repeat(10); // 30 字符
    const out = childShrink(raw, HARD_CAP_TOKENS, tok);
    expect(out.text).toBe(raw);
    expect(out.seq).toBe(32); // 30 + 2 special,实测值而非 0/-1
    expect(tok.calls.filter((c) => c.fn === 'call').length).toBe(1);
  });

  it('库口径超了但 id 数没超(中文 1 字≈1 token 的常态)时,仍走截断不直通', () => {
    // encode 得 2040 ≤ 预算,但库口径 2040+2+10 = 2052 真超；预算取小值使该情形可构造
    const budget = 200;
    const raw = '记'.repeat(195);
    const out = childShrink(raw, budget, stubTokenizer({ drift: 10 }));
    expect(out.seq).toBeLessThanOrEqual(budget);
    expect(out.text.length).toBeLessThan(raw.length);
  });

  it('不靠字符长度猜 token 数(旧启发式的漏判情形)', () => {
    // 500 英文字符按 CHARS_PER_TOKEN=4 估算=125 token「很安全」,桩给逐字符=500,预算 200 必须裁
    const out = childShrink('a'.repeat(500), 200, stubTokenizer());
    expect(out.seq).toBeLessThanOrEqual(200);
  });

  it('降级路径一律退回粗筛原文并标不可证:护栏不得搞坏能跑的链路', () => {
    const raw = '记'.repeat(3800);
    expect(childShrink(raw, HARD_CAP_TOKENS, null)).toEqual({ text: raw, seq: -1 });
    expect(childShrink(raw, 0, stubTokenizer())).toEqual({ text: raw, seq: -1 });
    expect(childShrink(raw, HARD_CAP_TOKENS, stubTokenizer({ throwOn: 'encode' })).text).toBe(raw);
    expect(childShrink(raw, HARD_CAP_TOKENS, stubTokenizer({ throwOn: 'decode' })).seq).toBe(-1);
    expect(childShrink(raw, HARD_CAP_TOKENS, stubTokenizer({ throwOn: 'call' })).seq).toBe(-1);
    expect(childShrink(raw, HARD_CAP_TOKENS, stubTokenizer({ decodeEmpty: true })).text).toBe(raw);
  });

  it('实测陷阱:return_tensor 必须显式关掉(否则拿到没有 length 的张量)', () => {
    const raw = '记'.repeat(3800);
    const tok = stubTokenizer({ tensorWhenOptionMissing: true });
    childShrink(raw, HARD_CAP_TOKENS, tok);
    const enc = tok.calls.find((c) => c.fn === 'encode');
    expect((enc?.arg as { return_tensor?: boolean })?.return_tensor).toBe(false);
    // 给了选项拿到数组 -> 确实裁了(而不是静默地「测不到长度就不裁」)
    expect(childShrink(raw, HARD_CAP_TOKENS, tok).text).not.toBe(raw);
    // 不管选项都给张量(异常/老版) -> 退回原文,不抛错、不猜长度
    expect(childShrink(raw, HARD_CAP_TOKENS, stubTokenizer({ alwaysTensor: true }))).toEqual({ text: raw, seq: -1 });
  });

  it('实测陷阱:decode 必须 skip_special_tokens,否则 [CLS]/[SEP] 被编回文本二次分词', () => {
    const tok = stubTokenizer();
    childShrink('记'.repeat(3800), HARD_CAP_TOKENS, tok);
    const dec = tok.calls.find((c) => c.fn === 'decode');
    expect((dec?.arg as { skip_special_tokens?: boolean })?.skip_special_tokens).toBe(true);
  });

  it('seqLenOf 同时吃数组形与张量形 input_ids(库版本差异不得导致崩)', () => {
    expect(guard.seqLenOf(((_t: string) => ({ input_ids: [1, 2, 3, 4] })) as unknown as never, 'x')).toBe(4);
    expect(guard.seqLenOf(((_t: string) => ({ input_ids: { dims: [1, 77] } })) as unknown as never, 'x')).toBe(77);
    expect(guard.seqLenOf(((_t: string) => ({})) as unknown as never, 'x')).toBe(-1);
  });
});

/**
 * 接线契约哨兵。
 *
 * 为什么需要它:上面的用例都直接调纯函数(拿不到真 tokenizer 时唯一可跑的办法),它们
 * **测不到调用点**。实测证据:把 `pump()` 里那一行改成 `const sent = screened;`(整体断开
 * 护栏),19 例仍全绿——而 #22 恰恰是「护栏存在但单位错」那一类缺陷。
 *
 * 所以本组只能是字符串级契约断言(沿 src/smoke.ts 对子进程产物的同型做法):它保证「不接线」
 * 与「预算不传给子进程」两类回归会红,**不能**证明真跑通了推理——那条真证据在
 * scripts/verify-token-guard-realmodel.mjs(真 bge-m3 实测 seq 受预算约束,且与库口径互验)。
 */
describe('#22 接线契约(哨兵级,非运行时证明)', () => {
  const childSrc = readFileSync(new URL('../resources/embedding-child.cjs', import.meta.url), 'utf-8');
  const copySrc = readFileSync(new URL('../scripts/copy-client.mjs', import.meta.url), 'utf-8');
  const localSrc = readFileSync(new URL('../src/store/local-embedding.ts', import.meta.url), 'utf-8');

  it('子进程推理入口必须把精截接在实际送模型的那条文本上', () => {
    expect(childSrc).toMatch(/const cut = shrinkToBudget\(screened, MAX_INPUT_TOKENS, tokenizer\);/u);
    expect(childSrc).toMatch(/extractor\(\[cut\.text\]/u); // 送的是截断后的文本
    expect(childSrc).toMatch(/cut\.seq > job\.request\.tokensMax/u); // 上报用实测值
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
    expect(localSrc).toMatch(/maxInputTokens: budget\.tokens,/u);
    expect(localSrc).toMatch(/deriveTokenBudget\(entry\.contextTokens, opts\.maxInputTokens\)/u);
  });

  it('单一真值来源:HARD_CAP_TOKENS 不得在子进程/服务层被重新写一遍', () => {
    expect(childSrc).not.toMatch(/\b(1536|2048|2700)\b/u);
    expect(localSrc).not.toMatch(/maxInputTokens[^\n]*\b(1536|2048)\b/u);
    const catalogSrc = readFileSync(new URL('../src/store/model-catalog.ts', import.meta.url), 'utf-8');
    expect(catalogSrc).toMatch(/export const HARD_CAP_TOKENS = \d+;/u);
  });

  it('嵌入预算路径不得复用上下文占用的 CHARS_PER_TOKEN=4(中文会低估 4 倍)', () => {
    expect(localSrc).not.toMatch(/CHARS_PER_TOKEN/u);
    expect(childSrc).not.toMatch(/CHARS_PER_TOKEN/u);
  });
});

type EmbCfg = { embedding: { maxInputChars: number; maxInputTokens: number } };

describe('#22 配置面回归(只增不改——防「改名=无声失效」)', () => {
  it('缺省值不动 maxInputChars 的 5000(已部署 YAML 行为不得变)', () => {
    const cfg = memorySchema({}) as EmbCfg;
    expect(cfg.embedding.maxInputChars).toBe(5000);
    expect(cfg.embedding.maxInputTokens).toBe(0);
  });

  it('旧键显式值仍被读(schemastery 未知键静默透传,改名会让值无声回落)', () => {
    expect((memorySchema({ embedding: { maxInputChars: 1200 } }) as EmbCfg).embedding.maxInputChars).toBe(1200);
  });

  it('新键被读且不抢旧键的语义', () => {
    const cfg = memorySchema({ embedding: { maxInputChars: 3000, maxInputTokens: 1600 } }) as EmbCfg;
    expect(cfg.embedding.maxInputChars).toBe(3000);
    expect(cfg.embedding.maxInputTokens).toBe(1600);
  });

  it('maxInputChars 边界未收窄(收窄会让已部署 YAML 直接解析抛错)', () => {
    expect(() => memorySchema({ embedding: { maxInputChars: 100_000 } })).not.toThrow();
    expect(() => memorySchema({ embedding: { maxInputChars: 100_001 } })).toThrow();
  });

  it('新键超大值不抛错(靠 clamp+warn 而非配置树爆炸;必崩值也加载得起来)', () => {
    const cfg = memorySchema({ embedding: { maxInputTokens: 100_000 } }) as EmbCfg;
    expect(deriveTokenBudget(8192, cfg.embedding.maxInputTokens).tokens).toBe(HARD_CAP_TOKENS);
  });
});

describe('#22 退出归因(signal 不得丢弃)', () => {
  it('被信号硬杀时 code===null + signal 可读,三种形态互不相同', () => {
    expect(describeExit('本地嵌入子进程', null, 'SIGTRAP')).toContain('signal=SIGTRAP');
    expect(describeExit('本地嵌入子进程', null, 'SIGKILL')).toContain('signal=SIGKILL');
    expect(describeExit('本地嵌入子进程', 0, null)).toContain('code=0');
    expect(describeExit('本地嵌入子进程', 0, null)).toContain('signal=null');
    expect(describeExit('本地嵌入子进程', 1, null)).toContain('code=1');
  });

  it('崩溃串向上传为 loadError,故一处修三处可见', async () => {
    // Windows 发不出 SIGTRAP(EINVAL),这里覆盖的是链路本身:
    // signal 进 crashed 串 → loadError → embedBatch 抛错文本。
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

  it('每批推理落盘实测 tokensMax 与耗时（护栏事后可核）', async () => {
    const lines: string[] = [];
    const logger = { info: (s: string) => lines.push(s), warn: () => {}, error: () => {} };
    const channel = {
      request: async () =>
        ({ id: 0, ok: true, type: 'embedded', vectors: [new Float32Array(4).fill(0.5)], tokensMax: 1535 }) as never,
      terminate: () => {},
      setOnCrash: () => {},
    };
    const { LocalEmbeddingService } = await import('../src/store/local-embedding.js');
    const svc = new LocalEmbeddingService(
      {
        id: 'fake', name: 'f', repo: 'x/f', revision: 'r', dims: 4, contextTokens: 8192,
        pooling: 'cls', tags: [], description: '', files: [],
      },
      '/tmp/models/fake',
      { runtimeDir: '/tmp/runtime', channel: channel as never, logger },
    );
    await svc.embedBatch(['x', 'y']);
    const line = lines.find((l) => l.includes('一批完成'));
    expect(line).toBeDefined();
    expect(line).toContain('tokensMax=1535');
    expect(line).toContain('n=2');
    expect(/耗时=\d+ms/.test(line ?? '')).toBe(true);
    svc.close();
  });

  it('不可证时记「未知」而不是 0（-1 不得被当作「一条也没进」）', () => {
    expect(describeEmbedBatch('bge-m3', 3, -1, 100)).toContain('tokensMax=未知');
    expect(describeEmbedBatch('bge-m3', 3, undefined, 100)).toContain('tokensMax=未知');
    expect(describeEmbedBatch('bge-m3', 3, 0, 100)).toContain('tokensMax=0');
    expect(describeEmbedBatch('bge-m3', 3, 1536, 100)).toContain('tokensMax=1536');
  });
});
