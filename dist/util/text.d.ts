/**
 * 中英混排分词:jieba 词元 ∪ 拉丁词 ∪ CJK 二元组,按首次出现顺序去重。
 *
 * 分词结果是 FTS 索引内容的定义——token 序列必须与既有索引构建算法严格一致,
 * 否则旧库检索错位(这是格式级契约,不是可自由重设计项):
 * - 词元给 BM25 提供高精度整词命中("负载均衡"作为词,idf 远高于碎片二元组);
 * - 二元组保住子词召回底线:查询"负载"仍能命中只含"负载均衡"词元的行,且旧库
 *   纯二元组索引无需迁移即可被新查询命中(新查询仍含二元组 token);
 * - 去重防 2 字词与其自身二元组重复计数(FTS tf / 词频被同一出现双计);
 * - jieba 加载失败时 jiebaCut 返回 undefined,自动退化为纯二元组。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
/** 把消息的 ContentBlock[] 展平成纯文本(仅 text 与 reasoning 块,换行连接)。 */
export declare function blocksToText(blocks: readonly ContentBlock[] | undefined): string;
/** FTS / BM25 共用分词入口(输入内部统一小写)。 */
export declare function tokenize(text: string): string[];
