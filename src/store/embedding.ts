/**
 * Embedding 服务类型基座与空实现。
 *
 * dsh 的 ctx.llm 只有 chat 流式接口、无 embeddings 端点,因此向量能力
 * 需要用户自备任意 OpenAI 兼容 /embeddings 服务(OpenAI/SiliconFlow/Jina/自托管 BGE 等)。
 * 默认关闭(Noop)——纯 FTS 模式即可运行,这是官方 provider="none" 的同款语义。
 * (远程/本地实现与活切换管理在本仓库的嵌入子系统提交中落地。)
 */
import type { MemoryLogger } from '../types.js';

export interface EmbeddingProviderInfo {
  provider: string;
  model: string;
  dimensions: number;
}

/** 单次嵌入调用的可选参数:timeoutMs 只允许缩短服务配置的超时(内层钳制),
 *  永不放大——召回路径用它给 FTS 降级留时间(规格 A 节)。本地实现经 worker
 *  代理以 Promise.race 钳制(迟到回复丢弃,推理在 worker 线程无法真正取消)。 */
export interface EmbedCallOptions {
  timeoutMs?: number;
}

export interface EmbeddingService {
  embed(text: string, callOpts?: EmbedCallOptions): Promise<Float32Array>;
  embedBatch(texts: string[], callOpts?: EmbedCallOptions): Promise<Float32Array[]>;
  getDimensions(): number;
  getProviderInfo(): EmbeddingProviderInfo;
  isReady(): boolean;
  close?(): void;
}

/** 空实现:向量能力关闭/不可用时使用,一切调用安全返回。 */
export class NoopEmbeddingService implements EmbeddingService {
  getDimensions(): number {
    return 0;
  }
  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: 'noop', model: 'disabled', dimensions: 0 };
  }
  isReady(): boolean {
    return false;
  }
  async embed(): Promise<Float32Array> {
    return new Float32Array(0);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(0));
  }
}

export type { MemoryLogger };
