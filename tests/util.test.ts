/**
 * util 层单元测试:原子写/JSONL、分词、清洗、文件日志、召回预算、分词器戳。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appendJsonl,
  atomicWriteJson,
  atomicWriteText,
  dayKey,
  readJsonIfExists,
  readJsonl,
  readTextIfExists,
} from '../src/util/io.js';
import { blocksToText, tokenize } from '../src/util/text.js';
import { sanitizeText, shouldCaptureL0, stripCodeBlocks } from '../src/util/sanitize.js';
import { errDetail, withFileLog } from '../src/util/filelog.js';
import {
  RECALL_EMBED_CAP_MS,
  RECALL_TRUNCATION_SUFFIX,
  applyRecallBudget,
  raceRecallTimeout,
  truncateRecallLine,
} from '../src/util/recall-budget.js';
import { describeTokenizer, ensureTokenizer, jiebaCut, tokenizerStamp } from '../src/util/tokenizer.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-util-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('io', () => {
  it('atomicWriteText survives re-write and readTextIfExists', async () => {
    const f = join(await tmp(), 'a', 'b.txt');
    await atomicWriteText(f, 'one');
    expect(await readTextIfExists(f)).toBe('one');
    await atomicWriteText(f, 'two');
    expect(await readTextIfExists(f)).toBe('two');
    expect(await readTextIfExists(join(await tmp(), 'nope.txt'))).toBeUndefined();
  });

  it('atomicWriteJson / readJsonIfExists roundtrip', async () => {
    const f = join(await tmp(), 'state.json');
    await atomicWriteJson(f, { version: 2, items: [1, 2] });
    expect(await readJsonIfExists(f)).toEqual({ version: 2, items: [1, 2] });
    expect(await readJsonIfExists(join(await tmp(), 'none.json'))).toBeUndefined();
  });

  it('appendJsonl + readJsonl roundtrip with bad-line skip and empty no-op', async () => {
    const f = join(await tmp(), 'log.jsonl');
    await appendJsonl(f, []);
    await appendJsonl(f, [{ a: 1 }, { a: 2 }]);
    await appendJsonl(f, [{ a: 3 }]);
    await writeFile(f, 'BROKEN\n', { flag: 'a' });
    expect(await readJsonl(f)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('dayKey formats local YYYY-MM-DD', () => {
    expect(dayKey(new Date(2026, 8, 2, 8, 0, 0).getTime())).toBe('2026-09-02');
  });
});

describe('text', () => {
  it('blocksToText flattens text and reasoning blocks only', () => {
    const blocks = [
      { type: 'text', text: 'a' },
      { type: 'image', url: 'x' },
      { type: 'reasoning', text: 'b' },
    ] as unknown as Parameters<typeof blocksToText>[0];
    expect(blocksToText(blocks)).toBe('a\nb');
    expect(blocksToText(undefined)).toBe('');
  });

  it('tokenize keeps latin words, cjk bigrams and dedupes', () => {
    const tokens = tokenize('Hello world 负载均衡');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('负载');
    expect(tokens).toContain('均衡');
    // 2 字词与其自身二元组去重:仅出现一次
    expect(tokens.filter((t) => t === '负载').length).toBe(1);
    // 纯标点/单拉丁字符被滤除
    const punct = tokenize('!! ?? 。');
    expect(punct.every((t) => /[\u3400-\u9fff\uf900-\ufaff]/.test(t) || t.length >= 2)).toBe(true);
  });
});

describe('sanitize', () => {
  it('strips injected memory tags to prevent feedback loops', () => {
    const text = '前文<relevant-memories>秘密</relevant-memories>后文<user-persona>x</user-persona>';
    expect(sanitizeText(text)).toBe('前文后文');
  });

  it('strips media markers, inline timestamps and base64 images', () => {
    expect(sanitizeText('[media attached: image.png] 正文')).toBe('正文');
    expect(sanitizeText('[2026-09-02 10:00:00] 你好')).toBe('你好');
    expect(sanitizeText('看图 data:image/png;base64,AAAAAAAAAA= 完')).toBe('看图  完');
  });

  it('stripCodeBlocks keeps prose only', () => {
    expect(stripCodeBlocks('说明\n```js\nconst x = 1;\n```\n结尾')).toBe('说明\n\n结尾');
  });

  it('shouldCaptureL0 drops framework noise and commands', () => {
    expect(shouldCaptureL0('正常对话')).toBe(true);
    expect(shouldCaptureL0('/help')).toBe(false);
    expect(shouldCaptureL0('NO_REPLY')).toBe(false);
    expect(shouldCaptureL0('(session bootstrap)')).toBe(false);
    expect(shouldCaptureL0('   ')).toBe(false);
    // 注入标签在捕获前已被 sanitizeText 剥离;剥完为空 → 不捕获
    expect(sanitizeText('<relevant-memories>x</relevant-memories>')).toBe('');
    expect(shouldCaptureL0('')).toBe(false);
  });
});

describe('filelog', () => {
  it('mirrors info lines into memory.log after flush threshold', async () => {
    const logs: string[] = [];
    const base = { info: (m: string) => logs.push(m), warn: () => {}, error: () => {} };
    const logger = withFileLog(await tmp(), base);
    logger.info('hello-file');
    logger.warn('warn-file');
    // 攒满 SIZE_CHECK_INTERVAL 触发刷盘
    for (let i = 0; i < 32; i++) logger.info(`fill-${i}`);
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(join(await tmp(), 'memory.log'), 'utf-8');
    expect(raw).toContain('[info] hello-file');
    expect(raw).toContain('[warn] warn-file');
    expect(logs).toContain('hello-file'); // 控制台镜像不丢
  });

  it('errDetail renders message with first stack frame', () => {
    const e = new Error('boom');
    expect(errDetail(e)).toContain('boom');
    expect(errDetail('plain')).toBe('plain');
  });
});

describe('recall budget', () => {
  it('truncateRecallLine counts code points and appends suffix', () => {
    expect(truncateRecallLine('short', 100)).toBe('short');
    // 上限大于后缀长度:截后带后缀,总长恰为 maxChars
    const cut = truncateRecallLine('记'.repeat(80), 60);
    expect(Array.from(cut).length).toBe(60);
    expect(cut.endsWith(RECALL_TRUNCATION_SUFFIX)).toBe(true);
    // 上限小于后缀长度时硬截
    expect(Array.from(truncateRecallLine('abcdef', 3)).length).toBe(3);
  });

  it('applyRecallBudget drops tail by total budget, separator-aware', () => {
    const lines = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)];
    expect(applyRecallBudget(lines, { maxCharsPerMemory: 0, maxTotalRecallChars: 0 })).toEqual(lines);
    expect(applyRecallBudget(lines, { maxCharsPerMemory: 5, maxTotalRecallChars: 0 }).every((l) => l.length <= 5)).toBe(true);
    // 总预算 15:第一行占 10;第二行 remaining = 15-10-1 = 4 < MIN_TRUNCATED(40) → 整条丢弃并停
    expect(applyRecallBudget(lines, { maxCharsPerMemory: 0, maxTotalRecallChars: 15 })).toEqual(['a'.repeat(10)]);
  });

  it('raceRecallTimeout resolves undefined on timeout and passes through otherwise', async () => {
    expect(await raceRecallTimeout(Promise.resolve('v'), 1000)).toBe('v');
    expect(await raceRecallTimeout(new Promise<string>(() => {}), 20)).toBeUndefined();
    expect(await raceRecallTimeout(Promise.resolve('x'), 0)).toBe('x'); // 0 = 不限时
    expect(RECALL_EMBED_CAP_MS).toBe(3000);
  });
});

describe('tokenizer', () => {
  it('mode is stable and stamp matches mode', () => {
    const mode = ensureTokenizer();
    expect(tokenizerStamp()).toBe(mode === 'jieba' ? 'jieba-v1' : 'bigram-v1');
    expect(describeTokenizer()).toBeTruthy();
    if (mode === 'jieba') {
      expect(jiebaCut('负载均衡策略')!.length).toBeGreaterThan(0);
    } else {
      expect(jiebaCut('负载均衡策略')).toBeUndefined();
    }
  });
});
