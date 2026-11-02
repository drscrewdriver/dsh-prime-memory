import type { MemoryLogger } from '../types.js';
import { type CatalogEntry } from './model-catalog.js';
import type { EmbedCallOptions, EmbeddingProviderInfo, EmbeddingService } from './embedding.js';
type LocalState = 'idle' | 'loading' | 'ready' | 'failed' | 'terminated';
/** 推理侧启动参数(worker 经 workerData / 子进程经 env DSH_EMBED_CFG;构造后不可变)。 */
export interface EmbedWorkerData {
    runtimeDir: string;
    modelDir: string;
    pooling: 'cls' | 'mean';
    dtype: string;
    /** 字符粗筛上限(IPC 体积护栏;不是语义护栏,也**不是**崩溃护栏——token 帽才是)。 */
    maxInputChars: number;
    /**
     * 本地推理的单条 token 预算(issue #22)。主进程推导(`deriveTokenBudget`)、
     * 子进程执行截断——因为 tokenizer 只在子进程可达,且 ORT `run()` 同步不可中断。
     */
    maxInputTokens: number;
}
/** 主线程 → worker 的调用(id 由通道分配)。 */
export type EmbedWorkerCall = {
    type: 'ping';
} | {
    type: 'warmup';
} | {
    type: 'embed';
    texts: string[];
    priority: boolean;
};
/** worker → 主线程的应答。 */
export type EmbedWorkerReply = {
    id: number;
    ok: true;
    type: 'pong';
} | {
    id: number;
    ok: true;
    type: 'ready';
} | {
    id: number;
    ok: true;
    type: 'embedded';
    vectors: Float32Array[];
    tokensMax?: number;
} | {
    id: number;
    ok: false;
    stage: 'load' | 'infer';
    error: string;
};
/** worker 通道抽象(测试缝:注入假实现验证协议与状态机)。 */
export interface EmbedWorkerChannel {
    request(call: EmbedWorkerCall): Promise<EmbedWorkerReply>;
    /** 立即终止 worker 并拒绝全部未决请求(close 语义);幂等。 */
    terminate(): void;
    /** worker 意外崩溃通知(此后所有未决请求已被通道拒绝)。 */
    setOnCrash(cb: (error: string) => void): void;
}
/**
 * 退出描述归一化(issue #22 取证面):被信号硬杀时 Node 给的是 `code===null` + `signal`,
 * 只打 code 会让 SIGTRAP(分配器 trap)/OOM-kill(SIGKILL)/自然退出(code=0)在日志里长得一模一样。
 * signal 同时进 crashed 串、向上传为 loadError,故一处修三处可见。
 */
export declare function describeExit(what: string, code: number | null, signal: string | null): string;
/**
 * 每批推理的可见性行(info 才能进 memory.log)。`tokensMax` 是子进程**实测**上报的
 * 「本轮真正进模型的最大 token 数」(-1 = 不可证):把它落盘才能事后回答
 * 「护栏当时到底生效了没有」,否则它只存在于本地脚本的探针里。
 */
export declare function describeEmbedBatch(modelId: string, n: number, tokensMax: number | undefined, ms: number): string;
export interface LocalEmbeddingOptions {
    /** 数据目录 runtime/(推理侧据此 createRequire 加载 transformers)。 */
    runtimeDir: string;
    /** 子进程资产路径(默认 dist/embedding-child.cjs;测试可显式指定)。 */
    childPath?: string;
    /** 旧 worker 资产路径(仅 useWorker=true 时生效;默认 dist/embedding-worker.cjs)。 */
    workerPath?: string;
    /** 回滚逃生门:true 切回 worker_threads 通道(fix #11 前的旧路径)。 */
    useWorker?: boolean;
    /** 通道注入缝(测试用;缺省起真实子进程通道)。 */
    channel?: EmbedWorkerChannel;
    logger?: MemoryLogger;
    maxInputChars?: number;
    /**
     * 用户显式 token 预算(config `embedding.maxInputTokens`);缺省/0 = 按模型窗口与
     * `HARD_CAP_TOKENS` 自动推导。超限只 clamp + warn,不抛错。
     */
    maxInputTokens?: number;
}
export declare class LocalEmbeddingService implements EmbeddingService {
    private state;
    private loadError;
    private readonly channel;
    private readonly entry;
    private readonly logger?;
    constructor(entry: CatalogEntry, modelDir: string, opts: LocalEmbeddingOptions);
    getDimensions(): number;
    getProviderInfo(): EmbeddingProviderInfo;
    isReady(): boolean;
    /** 状态(进度展示用)。 */
    getState(): LocalState;
    getLoadError(): string | null;
    /** 后台预热:启动后让 worker 立即加载模型(幂等;失败态可重试)。 */
    startWarmup(): void;
    /** 等待模型就绪(warmup 协议;applyChain 的 warming 阶段与测试用)。 */
    waitForReady(): Promise<void>;
    embed(text: string, callOpts?: EmbedCallOptions): Promise<Float32Array>;
    embedBatch(texts: string[], callOpts?: EmbedCallOptions): Promise<Float32Array[]>;
    /** 释放推理子进程与模型(嵌入源切走/关闭时调用;幂等)。terminated 后不可
     *  再复用——防止插件卸载/切走后残留的重嵌循环把模型重新加载常驻(内存泄漏)。 */
    close(): void;
    /** 内层钳制(仅缩短):超时放弃等待(迟到回复由通道按 id 丢弃),调用方降级。 */
    private requestWithTimeout;
    /** loading → ready 一次性日志(memory.log 时序可读性:启动到模型就绪的间隔)。 */
    private markReady;
    private applyLoadFailure;
}
export {};
