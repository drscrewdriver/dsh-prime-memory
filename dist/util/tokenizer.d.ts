export type TokenizerMode = 'jieba' | 'bigram';
/** 启动期主动初始化并返回模式(MemoryDb 记日志用)。 */
export declare function ensureTokenizer(): TokenizerMode;
/** FTS 分词器版本戳(存 embedding_meta 表,键 fts_tokenizer)。 */
export declare function tokenizerStamp(): string;
/** 模式描述(日志用)。 */
export declare function describeTokenizer(): string;
/** jieba 切词(回退模式下返回 undefined,调用方走二元组路径)。 */
export declare function jiebaCut(text: string): string[] | undefined;
