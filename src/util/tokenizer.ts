/**
 * 分词器装配:jieba 词级分词(@node-rs/jieba,Rust napi 预编译二进制)优先,
 * 加载失败(平台无预编译二进制等)永久回退 CJK 二元组。
 *
 * - 惰性单例:首次调用即定死本进程的分词模式,运行中不漂移——FTS 读写两侧共用
 *   同一实例,索引/查询天然对齐;
 * - require 走 createRequire(与原生模块装配同款):失败只降级不抛出,由 MemoryDb
 *   启动时主动 ensure 并记录模式日志;
 * - 分词器版本戳 jieba-v1/bigram-v1 是 FTS 重建的触发键:戳 ≠ 索引构建时的戳,
 *   FTS 表 drop 后从源表全量回灌——戳必须如实反映"构建当前 FTS 内容的分词器"。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type TokenizerMode = 'jieba' | 'bigram';

interface JiebaLike {
  cut(sentence: string, hmm?: boolean): string[];
}

let mode: TokenizerMode | undefined;
let cutFn: ((text: string) => string[]) | undefined;

/** 惰性初始化(永不抛出)。词典约 5MB,首次加载 ~100ms。 */
function ensure(): TokenizerMode {
  if (mode !== undefined) return mode;
  try {
    const { Jieba } = require('@node-rs/jieba') as {
      Jieba: { withDict(dict: Uint8Array): JiebaLike };
    };
    const { dict } = require('@node-rs/jieba/dict') as { dict: Uint8Array };
    const jieba = Jieba.withDict(dict);
    cutFn = (text: string) => jieba.cut(text, true);
    mode = 'jieba';
  } catch {
    cutFn = undefined;
    mode = 'bigram';
  }
  return mode;
}

/** 启动期主动初始化并返回模式(MemoryDb 记日志用)。 */
export function ensureTokenizer(): TokenizerMode {
  return ensure();
}

/** FTS 分词器版本戳(存 embedding_meta 表,键 fts_tokenizer)。 */
export function tokenizerStamp(): string {
  return ensure() === 'jieba' ? 'jieba-v1' : 'bigram-v1';
}

/** 模式描述(日志用)。 */
export function describeTokenizer(): string {
  return ensure() === 'jieba'
    ? 'jieba 词级分词(@node-rs/jieba)+ CJK 二元组并集'
    : 'jieba 加载失败,回退 CJK 二元组分词(子词召回降级)';
}

/** jieba 切词(回退模式下返回 undefined,调用方走二元组路径)。 */
export function jiebaCut(text: string): string[] | undefined {
  return ensure() === 'jieba' ? cutFn!(text) : undefined;
}
