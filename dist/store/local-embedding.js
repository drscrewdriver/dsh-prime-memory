/**
 * 本地嵌入服务(子进程隔离版,fix #11):transformers.js 的模型加载与 ONNX 推理
 * 全部在 fork 出的独立子进程执行(resources/embedding-child.cjs),本类只是主线程侧
 * 的协议代理——双重隔离:① onnxruntime-node 的 run/loadModel 是同步调用,留在宿主
 * 事件循环会冻结整个 dsh 页面(0.8.6 修复的真实事故);② 插件 runtime 的 sharp/libvips
 * 与宿主 Electron 的 sharp/libvips 同进程加载会撞 libvips-42.dll 名字(OS LoadLibrary
 * 层冲突)——worker_thread 与主线程同进程,撞名前提仍在(issue #11);子进程自带独立
 * DLL 表,冲突物理消失。
 *
 * - 懒加载:首次嵌入/warmup 才让子进程加载模型,close()=kill 释放进程与
 *   模型(嵌入源切走/关闭时调用),terminated 后不可复用;
 * - 崩溃有界自愈(#22 机理刀,config `embedding.respawnOnCrash` 默认开):子进程被硬杀后
 *   由 crashCb 单点重 fork+重预热,60s 窗内 ≤2 次;多条目批按实时断点(ack)续试一次,
 *   不整批重放——毒输入最多多吃两批,不成活锁;超限回 failed(旧语义:换源/重启恢复);
 * - 模型从数据目录 models/<id>/ 本地加载(子进程侧 env.allowRemoteModels=false);
 * - channel 可注入(测试缝):用假通道验证协议与状态机,不触真模型;
 * - useWorker=true 切回旧 worker_threads 通道(回滚逃生门;若宿主侧 DLL 冲突
 *   将来被根治,可一行切回获得 transfer 零拷贝的微弱性能优势);
 * - callOpts.timeoutMs 经 Promise.race 钉制(迟到回复按 id 丢弃——推理在
 *   子进程无法真正取消,但主线程可以停止等待并降级 FTS);
 * - 池化方式来自模型目录(BGE 系 CLS / Gemma 系 MEAN),normalize 交给
 *   pipeline 内建 L2 归一(与远程路径的 sanitizeAndNormalize 语义一致)。
 */
import { fork, spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { deriveTokenBudget, HARD_CAP_TOKENS } from './model-catalog.js';
/**
 * 崩溃自愈速率窗(#22 机理刀)：60s 滚动窗内最多 2 次重 fork。
 * 对齐 EmbedHelper 的 COOLDOWN_MS=60_000 口径；超限回 failed 是故意留的终局——
 * 反复 fork 风暴比停摆更贵(每次 fork+载入≈1.7s、峰值≈550MB)。
 */
const RESPAWN_WINDOW_MS = 60_000;
const RESPAWN_MAX_PER_WINDOW = 2;
/** 默认 worker 资产路径(旧通道,useWorker 逃生门):dist/store/ → dist/embedding-worker.cjs(构建期拷入)。 */
function defaultWorkerPath() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'embedding-worker.cjs');
}
/** 默认子进程资产路径(fix #11 主通道):dist/store/ → dist/embedding-child.cjs(构建期拷入)。 */
function defaultChildPath() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'embedding-child.cjs');
}
/** 真实通道:spawn worker_threads + 自增 id 配对 + 崩溃兜底拒绝。 */
class RealWorkerChannel {
    worker;
    pending = new Map();
    /** #22 断点位:多条目批实时上报的 done 计数(按请求 id;回复/终止时清理)。 */
    progress = new Map();
    nextId = 1;
    terminated = false;
    crashed;
    crashCb;
    constructor(workerPath, workerData) {
        this.worker = new Worker(workerPath, { workerData });
        this.worker.on('message', (msg) => {
            if (msg && msg.type === 'fatal') {
                this.failAll(`本地嵌入 worker 致命错误: ${msg.error ?? '未知'}`);
                return;
            }
            if (msg && msg.type === 'embedProgress') {
                // 非请求-应答消息:按 cid 记断点位,不进 pending 配对(#22 机理刀)
                const cid = msg.cid;
                const done = msg.done;
                if (typeof cid === 'number' && typeof done === 'number')
                    this.progress.set(cid, done);
                return;
            }
            const id = msg.id;
            if (typeof id !== 'number')
                return;
            const entry = this.pending.get(id);
            if (!entry)
                return; // 迟到回复(调用方已超时放弃)
            this.pending.delete(id);
            entry.resolve(msg);
        });
        // error(未捕获异常且 worker 未自处理)与 exit(含 fatal 后的退出)都兜底拒绝
        this.worker.on('error', (err) => this.failAll(`本地嵌入 worker 线程错误: ${err.message}`));
        this.worker.on('exit', (code, signal) => {
            // signal 必须留痕:被信号硬杀时 code===null,单看 code 无法区分「SIGTRAP/OOM-kill/自然退出」
            // (issue #22 就是靠 macOS 崩溃报告对毫秒时间戳才归因上的)。
            // worker 的 exit 事件在 typings 里无强类型重载,故 signal 取守性可选形参。
            if (!this.terminated)
                this.failAll(describeExit('本地嵌入 worker 线程', code, signal ?? null));
        });
    }
    request(call) {
        // 已释放/已崩溃的通道快速拒绝——postMessage 到死线程是静默无回应,调用方会挂到超时
        if (this.terminated)
            return Promise.reject(new Error('嵌入 worker 已释放'));
        if (this.crashed)
            return Promise.reject(new Error(this.crashed));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...call, id });
        });
    }
    isAlive() {
        return !this.terminated && !this.crashed;
    }
    /** #22 断点续试:按 cid 读最后实时进度(旧通道死后的值保留在此供服务侧读)。 */
    lastProgressFor(cid) {
        return this.progress.get(cid);
    }
    terminate() {
        if (this.terminated)
            return;
        this.terminated = true;
        this.failAll('嵌入 worker 已释放');
        void this.worker.terminate();
    }
    setOnCrash(cb) {
        this.crashCb = cb;
        // 构造与回调注册之间发生的崩溃(spawn 即失败等)不丢通知
        if (this.crashed)
            cb(this.crashed);
    }
    failAll(error) {
        for (const [, entry] of this.pending)
            entry.reject(new Error(error));
        this.pending.clear();
        // progress **不清**：崩溃时刻的断点位正是服务侧要读的(lastProgressFor);cid 单调不复用,无跨批误读之虞
        if (!this.terminated && !this.crashed) {
            this.crashed = error;
            this.crashCb?.(error);
        }
    }
}
/**
 * 退出描述归一化(issue #22 取证面):被信号硬杀时 Node 给的是 `code===null` + `signal`,
 * 只打 code 会让 SIGTRAP(分配器 trap)/OOM-kill(SIGKILL)/自然退出(code=0)在日志里长得一模一样。
 * signal 同时进 crashed 串、向上传为 loadError,故一处修三处可见。
 */
export function describeExit(what, code, signal) {
    return `${what}退出(code=${code ?? 'null'},signal=${signal ?? 'null'})`;
}
/**
 * 每批推理的可见性行(info 才能进 memory.log)。`tokensMax` 是子进程**实测**上报的
 * 「本轮真正进模型的最大 token 数」(-1 = 不可证):把它落盘才能事后回答
 * 「护栏当时到底生效了没有」,否则它只存在于本地脚本的探针里。
 */
export function describeEmbedBatch(modelId, n, tokensMax, ms) {
    const tok = typeof tokensMax === 'number' && tokensMax >= 0 ? String(tokensMax) : '未知';
    return `[memory] 本地嵌入一批完成:model=${modelId} n=${n},进模型 tokensMax=${tok},耗时=${ms}ms`;
}
/**
 * 真实子进程通道(fix #11 默认):fork 独立进程隔离 sharp/libvips DLL 冲突。
 * 与 RealWorkerChannel 同协议语义,差异仅在传输层:
 * - 配置经 env DSH_EMBED_CFG(JSON 字符串,fork env 只收标量);
 * - 向量经 number[][] 序列化回传(IPC JSON 通道不支持 TypedArray;512d×32 条
 *   ≈64KB,<5ms,不构成瓶颈),主线程侧收到后重建 Float32Array;
 * - 终止 Windows 走 taskkill /T /F(同 runtime-installer 模式,防只杀包装进程),
 *   其余 SIGTERM + 3s 强杀钉底。
 */
class RealChildChannel {
    child;
    pending = new Map();
    /** #22 断点位:与 worker 通道同语义(多条目批实时 done 计数;failAll 不清,新批才清)。 */
    progress = new Map();
    nextId = 1;
    terminated = false;
    crashed;
    crashCb;
    constructor(childPath, cfg, onForked) {
        this.child = fork(childPath, [], {
            // execPath 显式沿用当前二进制:宿主 Electron 自带 Node runtime,打包后 PATH 里没有 node
            execPath: process.execPath,
            env: { ...process.env, DSH_EMBED_CFG: JSON.stringify(cfg) },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        // pid 必须落日志:#22 报告人就是靠「崩溃报告 ↔ 日志」的时间对撞才归因上的,而有 pid
        // 才能把一份系统崩溃报告对上哪个子进程(taskkill /T 的进程树也因此可核)。
        onForked?.(this.child.pid);
        this.child.on('message', (msg) => {
            if (msg && msg.type === 'fatal') {
                this.failAll(`本地嵌入子进程致命错误: ${msg.error ?? '未知'}`);
                return;
            }
            if (msg && msg.type === 'embedProgress') {
                // 非请求-应答消息:按 cid 记断点位,不进 pending 配对(#22 机理刀;与 worker 通道同语义)
                const cid = msg.cid;
                const done = msg.done;
                if (typeof cid === 'number' && typeof done === 'number')
                    this.progress.set(cid, done);
                return;
            }
            const id = msg.id;
            if (typeof id !== 'number')
                return;
            const entry = this.pending.get(id);
            if (!entry)
                return; // 迟到回复(调用方已超时放弃)
            this.pending.delete(id);
            // 子进程侧 vectors 是 number[][](IPC JSON 序列化),本侧重建 Float32Array 保持协议类型不变
            const reply = msg;
            if (reply.ok && reply.type === 'embedded') {
                reply.vectors = reply.vectors.map((v) => new Float32Array(v));
            }
            entry.resolve(reply);
        });
        // error(fork 启动失败等)与 exit(含 fatal 后自杀、OOM 被杀)都钉底拒绝
        this.child.on('error', (err) => this.failAll(`本地嵌入子进程错误: ${err.message}`));
        this.child.on('exit', (code, signal) => {
            // 同上:signal 是被硬杀的唯一线索,不得丢弃(#22)
            if (!this.terminated)
                this.failAll(describeExit('本地嵌入子进程', code, signal));
        });
    }
    request(call) {
        // 已释放/已崩溃的通道快速拒绝——send 到死进程是静默无回应,调用方会挂到超时
        if (this.terminated)
            return Promise.reject(new Error('嵌入子进程已释放'));
        if (this.crashed)
            return Promise.reject(new Error(this.crashed));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            // 递送失败(通道已关/子进程已死)走 send 回调拒绝,不留挂死的 pending
            this.child.send({ ...call, id }, (err) => {
                if (!err)
                    return;
                const entry = this.pending.get(id);
                if (entry) {
                    this.pending.delete(id);
                    entry.reject(new Error(`嵌入子进程 IPC 发送失败: ${err.message}`));
                }
            });
        });
    }
    isAlive() {
        return !this.terminated && !this.crashed;
    }
    /** #22 断点续试:按 cid 读最后实时进度(旧通道死后的值保留在此供服务侧读;与 worker 通道同签名,
     *  否则默认 fork 通道上 lastProgressFor 缺失 → 断点续试静默失效)。 */
    lastProgressFor(cid) {
        return this.progress.get(cid);
    }
    terminate() {
        if (this.terminated)
            return;
        this.terminated = true;
        this.failAll('嵌入子进程已释放');
        if (process.platform === 'win32' && this.child.pid !== undefined) {
            // 同 runtime-installer 的 taskkill 模式:Windows 上 child.kill() 信号语义弱,
            // /T 按进程树杀防孤儿;taskkill 自身启动失败回退裸 kill
            const tk = spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
            tk.on('error', () => this.child.kill());
        }
        else {
            this.child.kill('SIGTERM');
            // 钉底:子进程卡在同步 native 调用时收不到 SIGTERM → 3s 后强杀;自然退出则撤销定时器
            const force = setTimeout(() => {
                if (this.child.exitCode === null && this.child.signalCode === null)
                    this.child.kill('SIGKILL');
            }, 3000);
            this.child.once('exit', () => clearTimeout(force));
        }
    }
    setOnCrash(cb) {
        this.crashCb = cb;
        // 构造与回调注册之间发生的崩溃(fork 即失败等)不丢通知
        if (this.crashed)
            cb(this.crashed);
    }
    failAll(error) {
        for (const [, entry] of this.pending)
            entry.reject(new Error(error));
        this.pending.clear();
        // progress 不清:#22 断点续试要在崩溃后读到最后的 done(新批起批才清)
        if (!this.terminated && !this.crashed) {
            this.crashed = error;
            this.crashCb?.(error);
        }
    }
}
export class LocalEmbeddingService {
    state = 'idle';
    loadError = null;
    channel;
    entry;
    logger;
    /** 通道重建上下文(构造期固化;respawn 时原样重建,不重新推导预算)。 */
    cfgObj;
    useWorker;
    workerPath;
    childPath;
    injectedChannel;
    respawnOnCrash;
    /** 生效 token 预算(留痕用，见 embedding-source 的 recordTokenBudget 调用点)。 */
    tokenBudgetTokens;
    /** 自愈发起时刻滚动窗(60s ≤2 次;只允许 crashCb 单点读写)。 */
    respawnTimes = [];
    /** 服务侧请求关联号(#22 断点续试:多条目批带 cid,进度按 cid 归属)。 */
    nextCid = 1;
    /** 在飞自愈合流点——非空期间所有崩溃事件归并到同一次重建(防 fork 风暴)。 */
    respawnPromise = null;
    constructor(entry, modelDir, opts) {
        this.entry = entry;
        this.logger = opts.logger;
        const maxInputChars = opts.maxInputChars && opts.maxInputChars > 0 ? opts.maxInputChars : 5000;
        const budget = deriveTokenBudget(entry.contextTokens, opts.maxInputTokens);
        if (budget.clamped) {
            // 用户写了个必崩的值:压到上限并留痕(不抛错——拒绝启动比 clamp 更难排查)
            this.logger?.warn(`[memory] 本地嵌入 token 预算已从 ${opts.maxInputTokens} 压到 ${budget.tokens}` +
                `(模型窗口 ${entry.contextTokens} / 硬上限 ${HARD_CAP_TOKENS},#22 安全余量)`);
        }
        const cfgObj = {
            runtimeDir: opts.runtimeDir,
            modelDir,
            pooling: entry.pooling,
            dtype: 'q8',
            maxInputChars,
            maxInputTokens: budget.tokens,
        };
        this.cfgObj = cfgObj;
        this.useWorker = opts.useWorker === true;
        this.workerPath = opts.workerPath ?? defaultWorkerPath();
        this.childPath = opts.childPath ?? defaultChildPath();
        this.injectedChannel = opts.channel;
        this.respawnOnCrash = opts.respawnOnCrash !== false;
        this.tokenBudgetTokens = budget.tokens;
        // #22 取证面:同一份代码在纯 node 能跑、在 Electron-node 崩,而仓内任何地方都没记录
        // execPath 差异与生效预算 —— 下次不用靠系统崩溃报告对时间戳。
        this.logger?.info(`[memory] 本地嵌入子进程拉起:execPath=${process.execPath},release=${process.release?.name ?? 'unknown'},` +
            `model=${entry.id},contextTokens=${entry.contextTokens},tokenBudget=${budget.tokens},` +
            `粗筛 chars=${maxInputChars},通道=${opts.useWorker ? 'worker(旧逃生门,无 token 护栏)' : 'child'}`);
        this.channel = this.createChannel();
        // 崩溃有界自愈(#22 机理刀;有意翻转 0.26.25 的「本刀声明不做自愈」——理由与 bound 面
        // 见 RESPAWN_* 两常量与 respawnChannel 注释;注入假通道(测试)不重建:重建工厂会拿到
        // 同一个假实例,自愈无意义且会混淆既有崩溃用例,故假通道维持旧语义)
        this.channel.setOnCrash((error) => {
            if (this.state === 'terminated')
                return;
            if (!this.respawnOnCrash || this.injectedChannel || !this.respawnAllowed()) {
                this.state = 'failed';
                this.loadError = error;
                this.logger?.warn(`[memory] ${error}(本地嵌入转入 failed 态,换源或重启可恢复)`);
                return;
            }
            this.logger?.warn(`[memory] ${error}(#22 自愈第 ${this.respawnTimes.length} 次,60s 窗内 ≤${RESPAWN_MAX_PER_WINDOW})`);
            void this.respawnChannel();
        });
    }
    /** 真通道工厂(构造与自愈共用同一重建路径;假通道注入缝原样返回同一实例,不重建)。 */
    createChannel() {
        if (this.injectedChannel)
            return this.injectedChannel;
        if (this.useWorker)
            return new RealWorkerChannel(this.workerPath, this.cfgObj);
        return new RealChildChannel(this.childPath, this.cfgObj, (pid) => {
            // pid 只能在 fork 后拿到,故补一条(与拉起日志同前缀,便于 grep 成对)
            this.logger?.info(`[memory] 本地嵌入子进程 pid=${pid ?? '未知'}(model=${this.entry.id})`);
        });
    }
    /** 60s 滚动窗内是否还允许一次自愈(调用即计入,先占位后重建)。 */
    respawnAllowed() {
        const now = Date.now();
        while (this.respawnTimes.length > 0 && now - this.respawnTimes[0] > RESPAWN_WINDOW_MS)
            this.respawnTimes.shift();
        if (this.respawnTimes.length >= RESPAWN_MAX_PER_WINDOW)
            return false;
        this.respawnTimes.push(now);
        return true;
    }
    /**
     * 单点自愈：关旧通道→新通道→重预热→markReady。
     * 不变量：在飞期间 `respawnPromise` 非空且 `state='loading'`（isReady 为假），
     * 现有 vectorsReady 门/EmbedHelper 降级链天然接管半成品窗口，不加新契约态。
     */
    respawnChannel() {
        if (this.respawnPromise)
            return this.respawnPromise;
        const p = (async () => {
            let next;
            try {
                next = this.createChannel();
            }
            catch (err) {
                this.state = 'failed';
                this.loadError = err instanceof Error ? err.message : String(err);
                this.logger?.warn(`[memory] 本地嵌入自愈失败(通道重建): ${this.loadError}`);
                return;
            }
            // close() 竞态窗口：重建期间被外部释放→新通道不得残留(terminated 后不自愈是铁律)
            if (this.state === 'terminated') {
                next.terminate();
                return;
            }
            next.setOnCrash((error) => {
                // 新通道预热完成前暂不挂钩(避免旧通道残景再触发);完成后同路径重装
                if (this.channel !== next || this.state === 'terminated')
                    return;
                if (!this.respawnOnCrash || this.injectedChannel || !this.respawnAllowed()) {
                    this.state = 'failed';
                    this.loadError = error;
                    this.logger?.warn(`[memory] ${error}(本地嵌入转入 failed 态,换源或重启可恢复)`);
                    return;
                }
                this.logger?.warn(`[memory] ${error}(#22 自愈第 ${this.respawnTimes.length} 次,60s 窗内 ≤${RESPAWN_MAX_PER_WINDOW})`);
                void this.respawnChannel();
            });
            this.channel.terminate();
            this.channel = next;
            this.state = 'loading';
            this.loadError = null;
            try {
                await next.request({ type: 'warmup' });
                // 外部 close() 可能在 await 期间把状态推至 terminated(插件卸载/切走);TS 因调用发生在
                // next 上不失效 'loading' 窄化,故显式 cast 回完整并集再比——不能当作不可能分支删掉。
                if (this.state === 'terminated')
                    return;
                this.markReady();
                this.logger?.info(`[memory] 本地嵌入自愈完成(第 ${this.respawnTimes.length} 次,60s 窗)`);
            }
            catch (err) {
                if (this.state === 'terminated')
                    return;
                const msg = err instanceof Error ? err.message : String(err);
                this.state = 'failed';
                this.loadError = msg;
                this.logger?.warn(`[memory] 本地嵌入自愈失败(重预热): ${msg}`);
            }
            finally {
                this.respawnPromise = null;
            }
        })();
        this.respawnPromise = p;
        return p;
    }
    /** 自愈在飞时外部请求的等待缝(带超时;超时/失败都让调用方走既有降级链)。 */
    async awaitRespawn(timeoutMs) {
        const p = this.respawnPromise;
        if (!p)
            return;
        if (!(timeoutMs && timeoutMs > 0)) {
            await p;
            return;
        }
        let timer;
        try {
            await Promise.race([p, new Promise((resolve) => {
                    timer = setTimeout(resolve, timeoutMs);
                })]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    getDimensions() {
        return this.entry.dims;
    }
    /** 生效的单条 token 预算(=子进程侧 shrinkToBudget 的硬帽;embedding_meta 留痕用)。 */
    getTokenBudget() {
        return this.tokenBudgetTokens;
    }
    getProviderInfo() {
        // dimensions 语义与远程路径一致(sqlite 的 providerInfo 比对含维度)
        return { provider: 'local', model: this.entry.id, dimensions: this.entry.dims };
    }
    isReady() {
        return this.state === 'ready';
    }
    /** 状态(进度展示用)。 */
    getState() {
        return this.state;
    }
    getLoadError() {
        return this.loadError;
    }
    /** 后台预热:启动后让 worker 立即加载模型(幂等;失败态可重试)。 */
    startWarmup() {
        void this.waitForReady().catch(() => { });
    }
    /** 等待模型就绪(warmup 协议;applyChain 的 warming 阶段与测试用)。 */
    async waitForReady() {
        if (this.state === 'ready')
            return;
        if (this.state === 'terminated') {
            throw new Error('本地嵌入服务已释放(嵌入源已切换);本实例不可复用');
        }
        if (this.state !== 'failed')
            this.state = 'loading';
        const reply = await this.channel.request({ type: 'warmup' });
        if (!reply.ok) {
            this.applyLoadFailure(reply.error);
            throw new Error(reply.error);
        }
        this.markReady();
    }
    async embed(text, callOpts) {
        const [vec] = await this.embedBatch([text], callOpts);
        return vec;
    }
    async embedBatch(texts, callOpts) {
        if (texts.length === 0)
            return [];
        if (this.state === 'terminated') {
            throw new Error('本地嵌入服务已释放(嵌入源已切换);本实例不可复用');
        }
        if (this.state === 'failed') {
            // 只有明确失败过的服务才抛错(EmbedHelper 捕获后降级 FTS);warmup 可重试
            throw new Error(`本地嵌入模型加载失败: ${this.loadError ?? '未知原因'}(重启插件或重新下载模型可重试)`);
        }
        if (this.state !== 'ready')
            this.state = 'loading';
        // 单条请求(召回 query)带优先标记:worker 侧插队,不被 reindex 批次堵队尾
        const startedAt = Date.now();
        const usedChannel = this.channel;
        // 多条目批才带 cid(单条批无断点可续;消息形态对旧通道保持向后兼容)
        const cid = texts.length > 1 ? this.nextCid++ : undefined;
        let reply;
        try {
            reply = await this.requestWithTimeout({ type: 'embed', texts, priority: texts.length === 1, cid }, callOpts?.timeoutMs);
        }
        catch (err) {
            // #22 机理刀·断点续试：仅当**所用通道已死**(被杀/崩溃)才触发——超时降级/infer 错误回执/
            // 假通道注入缝都不走此路。旧批条目已进不了库(子进程连同未回执向量一起消失)，
            // 但从实时进度拿到的断点位把重做面从「整批」压到「尾部未完段」；只续一次，
            // 再失败走既有 reject——毒输入最多多吃两批，不把补齐链拖进活锁。
            const ack = cid !== undefined && typeof usedChannel.lastProgressFor === 'function' ? usedChannel.lastProgressFor(cid) : undefined;
            const alive = typeof usedChannel.isAlive === 'function' ? usedChannel.isAlive() : true;
            if (!alive &&
                this.respawnOnCrash &&
                !this.injectedChannel &&
                texts.length > 1 &&
                ack !== undefined &&
                ack < texts.length) {
                await this.awaitRespawn(callOpts?.timeoutMs);
                if (this.state === 'ready' || this.state === 'loading') {
                    const tail = texts.slice(ack);
                    this.logger?.warn(`[memory] 本地嵌入断点续试:model=${this.entry.id} from=${ack}(已 ack 不重放,剩 ${tail.length} 条,仅一次)`);
                    const retry = await this.requestWithTimeout({ type: 'embed', texts: tail, priority: false, cid }, callOpts?.timeoutMs);
                    if (!retry.ok)
                        throw new Error(`断点续试仍失败(from=${ack}): ${retry.error}`);
                    if (retry.type !== 'embedded')
                        throw new Error(`嵌入通道返回异常消息类型: ${retry.type}`);
                    this.markReady();
                    for (const v of retry.vectors) {
                        if (v.length !== this.entry.dims) {
                            throw new Error(`本地嵌入维度不匹配:期望 ${this.entry.dims},得到 ${v.length}`);
                        }
                    }
                    this.logger?.info(describeEmbedBatch(this.entry.id, tail.length, retry.tokensMax, Date.now() - startedAt));
                    return new Array(ack).concat(retry.vectors);
                }
            }
            throw err;
        }
        if (!reply.ok) {
            if (reply.stage === 'load')
                this.applyLoadFailure(reply.error);
            else
                this.markReady(); // 推理失败说明模型已加载成功(loading → ready),失败只属于这一次调用
            throw new Error(reply.error);
        }
        if (reply.type !== 'embedded')
            throw new Error(`嵌入 worker 返回异常消息类型: ${reply.type}`);
        this.markReady();
        for (const v of reply.vectors) {
            if (v.length !== this.entry.dims) {
                throw new Error(`本地嵌入维度不匹配:期望 ${this.entry.dims},得到 ${v.length}`);
            }
        }
        // 每批一行 info(#22 取证面):子进程**实测**进模型的 tokensMax 必须落盘,
        // 否则事后无法回答「护栏当时生效了没」;耗时兼作 EMA 熔断之外的裸值参考。
        this.logger?.info(describeEmbedBatch(this.entry.id, texts.length, reply.tokensMax, Date.now() - startedAt));
        return reply.vectors;
    }
    /** 释放推理子进程与模型(嵌入源切走/关闭时调用;幂等)。terminated 后不可
     *  再复用——防止插件卸载/切走后残留的重嵌循环把模型重新加载常驻(内存泄漏)。 */
    close() {
        this.state = 'terminated';
        this.loadError = null;
        this.channel.terminate();
    }
    /** 内层钳制(仅缩短):超时放弃等待(迟到回复由通道按 id 丢弃),调用方降级。 */
    async requestWithTimeout(call, timeoutMs) {
        if (!(timeoutMs && timeoutMs > 0))
            return this.channel.request(call);
        let timer;
        try {
            return await Promise.race([
                this.channel.request(call),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`本地嵌入调用超时(${timeoutMs}ms),已放弃等待`)), timeoutMs);
                }),
            ]);
        }
        finally {
            // 先到者胜出后清掉另一个定时器(不清理会挂住引用至自然到期)
            if (timer)
                clearTimeout(timer);
        }
    }
    /** loading → ready 一次性日志(memory.log 时序可读性:启动到模型就绪的间隔)。 */
    markReady() {
        if (this.state === 'ready')
            return;
        this.state = 'ready';
        this.logger?.info(`[memory] 本地嵌入模型就绪: ${this.entry.id}(dims=${this.entry.dims},pooling=${this.entry.pooling})`);
    }
    applyLoadFailure(error) {
        this.state = 'failed';
        this.loadError = error;
        this.logger?.warn(`[memory] 本地嵌入模型加载失败(${this.entry.id}): ${error}`);
    }
}
