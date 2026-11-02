/**
 * 本地嵌入子进程(fix #11):transformers.js 的模型加载与推理在 fork 出的独立
 * 子进程执行,主线程只投递文本、收回向量。取代 worker_threads 的原因:
 * 插件 runtime 的 sharp/libvips 与宿主 Electron 的 sharp/libvips 在同一进程内
 * 加载会撞 libvips-42.dll 名字(OS LoadLibrary 层冲突,同名不同路径行为未定义)
 * ——worker_thread 与主线程同进程,撞名前提仍在;子进程自带独立 DLL 表,物理隔离。
 *
 * 推理队列语义与 embedding-worker.cjs 完全一致(单线程串行、priority 插队、
 * 条间 setImmediate 让路),只有 IPC 传输层不同:
 *
 * 协议(与 src/store/local-embedding.ts 的 RealChildChannel 配对;自增 id):
 * - 启动配置:env DSH_EMBED_CFG(JSON 字符串:{runtimeDir,modelDir,pooling,dtype,
 *   maxInputChars,maxInputTokens}——fork 的 env 只收标量,嵌套对象经序列化传递);
 * - 入向:{id,type:'ping'} | {id,type:'warmup'} | {id,type:'embed',texts,priority}
 * - 出向:{id,ok:true,type:'pong'|'ready'|'embedded',vectors?,tokensMax?}(vectors 为
 *   number[][],fork IPC 默认 JSON 序列化不支持 TypedArray,主线程侧重建
 *   Float32Array;512d×32 条 ≈64KB,序列化 <5ms,瓶颈在推理不在传输)。
 *   tokensMax = 本批**实测**进模型的最大 token 数(#22 护栏自证用,主线程不消费也不报错);
 *   初值为 -1 而非 0 —— -1 表示「不可证」,与「真的一个 token 也没进」必须区分开。
 *   | {id,ok:false,stage:'load'|'infer',error} | {type:'fatal',error}
 *
 * 信任边界(沿 AGENTS.md 审查记录):runtime/ 目录在数据目录信任边界内,
 * 本进程按其 package.json createRequire 加载 transformers——对数据目录有写
 * 权限的进程理论上可植入恶意模块;模型文件逐文件 sha256 锁定,运行时代码
 * 无同级防护,完整修复需安装指纹设计,暂以文档化假设为准。
 */
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
// token 精截放在独立无副作用模块(而非本文件):本文件是 fork 入口,顶层有进程监听与
// 「无 IPC 就 exit」守卫,被测试 require 会把副作用带进来。截断逻辑本身必须零模型可验。
const { shrinkToBudget } = require('./embedding-token-guard.cjs');

/**
 * 本文件是 **fork 专用入口**：顶层的 `process.on('message'/'disconnect'/'uncaughtException')`
 * 与「无 IPC 就 exit」守卫都是执行体行为，**不得被测试 require**（给宿主进程装全局监听会
 * 污染同进程的其他代码：实测过给 vitest worker 装 `uncaughtException` 后，同 worker 的
 * `memory-md-sync` 用例无端转红）。需要零模型可验的逻辑一律放 `embedding-token-guard.cjs`。
 */

// 必须由 fork 启动(需要 IPC channel);裸 node 执行时静默退出,不报 SyntaxError、不永挂。
if (typeof process.send !== 'function') {
  console.error('[embedding-child] 未经 fork 启动,无 IPC 通道,退出');
  process.exit(0);
}

/** 错误消息归一化(Error 取 message,其余 String 化)。 */
function errMsg(err) {
  return err && err.message ? err.message : String(err);
}

const cfg = JSON.parse(process.env.DSH_EMBED_CFG || '{}');
const RUNTIME_DIR = typeof cfg.runtimeDir === 'string' ? cfg.runtimeDir : '';
const MODEL_DIR = typeof cfg.modelDir === 'string' ? cfg.modelDir : '';
const POOLING = cfg.pooling === 'cls' ? 'cls' : 'mean';
const DTYPE = typeof cfg.dtype === 'string' ? cfg.dtype : 'q8';
const MAX_INPUT_CHARS = cfg.maxInputChars > 0 ? cfg.maxInputChars : 5000;
/**
 * token 预算(issue #22)。预算值由主进程从模型窗口与硬上限推导后传进来(单一真值源
 * 在 src/store/model-catalog.ts);本处只消费。**截断必须在子进程做**:tokenizer 只在
 * pipeline 对象上可达,且 ORT run() 同步阻塞——单条内部不可中断,预检只能放推理前。
 */
const MAX_INPUT_TOKENS = cfg.maxInputTokens > 0 ? cfg.maxInputTokens : 0; // 0 = 未给,不启用 token 截断

// 字符粗筛后的 token 精截需要 tokenizer(pipeline 对象上的 .tokenizer,加载后可达)
let tokenizer = null;

let extractor = null; // pipeline('feature-extraction', …)
let loadState = 'idle'; // idle | loading | ready | failed
let loadPromise = null;
let loadError = null;

// ── 模型懒加载(首请求触发;失败后经 warmup 可重试,embed 请求失败快返回) ──
function ensureLoaded() {
  if (loadState === 'ready') return Promise.resolve();
  if (loadState === 'loading' && loadPromise) return loadPromise;
  loadState = 'loading';
  loadError = null;
  loadPromise = (async () => {
    try {
      if (!RUNTIME_DIR || !MODEL_DIR) throw new Error('DSH_EMBED_CFG 缺少 runtimeDir/modelDir');
      const req = createRequire(path.join(RUNTIME_DIR, 'package.json'));
      const mod = req('@huggingface/transformers');
      if (mod.env) {
        mod.env.allowRemoteModels = false;
        if (mod.env.allowLocalModels !== undefined) mod.env.allowLocalModels = true;
      }
      // #22 机理面:关 memPattern。ORT 默认按图形预分配输入绑定驻留 BFCArena,连发时
      // 新旧 T² 张量共存把峰值叠成 m×T²(实测 r0→r1 再跳 +341MB;单发/连发致死线之比
      // ≈√2 即 m=2 的定量旁证)。关掉后同形状连发峰值 1583→1247MB(m:2→1 方向)、
      // 稳态 infer 零代价、输出 12 位小数全同(不触发重嵌)。传参链已实证:
      // pipelines.js:111/167 → onnx.js:286-293 摊进 InferenceSession.create。
      // **边界**:对 macOS 分配器 trap 的消除效果本机不可证,不得据此宣称「不再崩」。
      extractor = await mod.pipeline('feature-extraction', MODEL_DIR, {
        dtype: DTYPE,
        session_options: { enableMemPattern: false },
      });
      // token 截断要用到 pipeline 内部的 tokenizer（未单独暴露 AutoTokenizer,4.x 形态）
      tokenizer = extractor && extractor.tokenizer ? extractor.tokenizer : null;
      loadState = 'ready';
    } catch (err) {
      loadState = 'failed';
      loadError = errMsg(err);
      loadPromise = null; // 失败后下一次 warmup 重新走加载
      throw err;
    }
  })();
  return loadPromise;
}

// ── 推理队列(逐条 job;priority 插队;条间让路) ──
const queue = []; // [{ request, index, text }]
let pumping = false;

function postReply(msg) {
  // 通道已断(父进程退出/正在终止)时 send 抛错——静默即可,父进程侧有 exit 兜底
  try {
    process.send(msg);
  } catch {
    /* IPC 已关闭,回复无处可去 */
  }
}

/** 请求全部条目完成 → 回执(Float32Array → number[] 序列化,IPC JSON 通道不支持 TypedArray)。 */
function settle(request) {
  if (request.failed || request.remaining !== 0) return;
  postReply({
    id: request.id,
    ok: true,
    type: 'embedded',
    vectors: request.vectors.map((v) => Array.from(v)),
    // #22 护栏自证:本批**实测**进模型的最大 token 数(不可测时为 -1,主线程不读此字段也不会坏)
    tokensMax: request.tokensMax,
    // #22 机理刀:ack = 本批已完整完成的条目数(全部完成时恒 = total);多条目批另有
    // embedProgress 实时推进度——子进程被硬杀时最后的 ack 就是父侧的断点位。
    ack: request.total,
  });
}

/** 首个失败即回执错误,并移除该请求尚未开跑的条目(正在跑的至多 1 条,算完即弃)。 */
function failRequest(request, error, stage) {
  if (request.failed) return;
  request.failed = true;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].request === request) queue.splice(i, 1);
  }
  postReply({ id: request.id, ok: false, stage: stage, error: errMsg(error) });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (job.request.failed) continue;
      try {
        // 字符粗筛(IPC 体积) + token 精截(#22 崩溃/内存护栏);截断只在推理前,run() 同步不可中断
        const screened = job.text.slice(0, MAX_INPUT_CHARS);
        const cut = shrinkToBudget(screened, MAX_INPUT_TOKENS, tokenizer);
        const result = await extractor([cut.text], { pooling: POOLING, normalize: true });
        const data = result[0] && result[0].data;
        job.request.vectors[job.index] = data instanceof Float32Array ? data : new Float32Array(data);
        // tokensMax 用 cut.seq（按库口径实测将要进模型的 seq 长度,含 special token）。
        // 曾试过从**输出**张量取形状——真 bge-m3 实测证明两事:① Tensor 上根本没有 `.shape`
        // (属性叫 `.dims`),② 池化后输出是一维向量,里面不存在 seq 维——旧写法永远拿不到值。
        // 不可证时为 -1（不是 0）,不拿假数据当护栏证据。
        if (cut.seq > job.request.tokensMax) job.request.tokensMax = cut.seq;
        job.request.remaining -= 1;
        // 多条目批实时上报断点(完成一条报一条;单条批无断点可续,不报)——
        // 父侧若在两条之间被 SIGTRAP 打断,最后收到的 done 就是重试切片位。
        // cid 由服务侧生成并回显(通道内部 id 与请求配对同形,不暴露给服务侧)。
        if (job.request.total > 1) postReply({ id: job.request.id, cid: job.request.cid, type: 'embedProgress', done: job.request.total - job.request.remaining });
        settle(job.request);
      } catch (err) {
        failRequest(job.request, err, 'infer');
      }
      // 条间让路:交还本进程事件循环,新消息(含 priority 插队)可在批间被处理
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    pumping = false;
  }
}

function handleEmbed(msg) {
  const texts = Array.isArray(msg.texts) ? msg.texts : [];
  if (texts.length === 0) {
    postReply({ id: msg.id, ok: true, type: 'embedded', vectors: [] });
    return;
  }
  // tokensMax 初值必须是 -1（不可证）而不是 0：下面的累加用严格大于，若初值为 0，
  // 则永远量不出 seq 的情形（tokenizer 不可达/预算为 0）会把 -1 压成 0，
  // 而主线程的 `>= 0` 判据会把 0 当有效值印出来——正好印成「一条也没进」，
  // 与「不可证」撞车，使这行日志在最需要它的时刻说谎（#22 报告人回验实测）。
  const request = { id: msg.id, cid: msg.cid, total: texts.length, vectors: new Array(texts.length), remaining: texts.length, failed: false, tokensMax: -1 };
  // 单条请求(召回 query)插队到队首;批次追加到队尾(批内条目间仍会被后来的插队)
  const priority = msg.priority === true && texts.length === 1;
  for (let i = 0; i < texts.length; i++) {
    const job = { request: request, index: i, text: String(texts[i] == null ? '' : texts[i]) };
    if (priority) queue.unshift(job);
    else queue.push(job);
  }
  void pump();
}

process.on('message', (msg) => {
  if (!msg || typeof msg.id !== 'number' || typeof msg.type !== 'string') return;
  if (msg.type === 'ping') {
    postReply({ id: msg.id, ok: true, type: 'pong' });
    return;
  }
  if (msg.type === 'warmup') {
    ensureLoaded().then(
      () => postReply({ id: msg.id, ok: true, type: 'ready' }),
      () => postReply({ id: msg.id, ok: false, stage: 'load', error: loadError ?? '模型加载失败' }),
    );
    return;
  }
  if (msg.type === 'embed') {
    void (async () => {
      try {
        await ensureLoaded();
      } catch {
        postReply({ id: msg.id, ok: false, stage: 'load', error: loadError ?? '模型加载失败' });
        return;
      }
      handleEmbed(msg);
    })();
    return;
  }
});

// 父进程disconnect(通道被主动关闭,如宿主优雅退出/RealChildChannel 前置断开):
// 模型与 onnxruntime 都只服务于这条通道,留着就是孤儿常驻——直接退出。
// taskkill /T /F 兜底覆盖"父进程被硬杀、无 disconnect"的路径。
process.on('disconnect', () => process.exit(0));

// 未捕获异常:尽力通知父进程后强制退出(父进程的 exit 处理会拒绝全部 pending
// 并转入 failed 态)。不保持半死状态——半死的子进程只会让调用方挂到超时。
process.on('uncaughtException', (err) => {
  postReply({ type: 'fatal', error: errMsg(err) });
  setTimeout(() => process.exit(1), 50);
});
