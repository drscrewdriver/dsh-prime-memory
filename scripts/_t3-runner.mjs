/**
 * T3 峰值采样的执行体：被 verify-token-guard-realmodel.mjs fork 出来，在**本进程**里
 * 跑一次真推理，让父进程可以从外部轮询到真实峰值 RSS。
 *
 * 为什么要单独一个子进程：onnxruntime 的 run() 是同步阻塞调用，同进程内 setInterval
 * 根本采不到峰值（实测 peakMB=0），取「推理前后各一次 RSS」又只会拿到释放后的余量
 * （实测甚至出过 -8MB 的负数）。峰值必须由外部观察者采。
 *
 * 只做一件事，不注册退出守卫以外的任何行为；仅供本地验证，不进 CI。
 */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeDir = process.env.T3_RUNTIME;
const modelDir = process.env.T3_MODEL;
const budget = Number(process.env.T3_BUDGET || 0);
const chars = Number(process.env.T3_CHARS || 5000);
// #22 机理刀复现面：两条会话臂——'on' = ORT 默认（改前），'off' = enableMemPattern:false（改后）。
// 默认 on，保持旧 T3 峰值基线行为不变（不传此环境变量时与改前完全一致）。
const memPattern = process.env.T3_MEMPATTERN !== 'off';
// 同形状连发轮数（arena 高水位累积只在同进程内显现，故连发必须同进程）。
const repeat = Math.max(1, Number(process.env.T3_REPEAT || 1));
// 回传最后一轮向量（--equivalence 用；默认不回传，峰值臂不需要）。
const echo = process.env.T3_ECHO === '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(runtimeDir, 'package.json'));
const mod = req('@huggingface/transformers');
mod.env.allowRemoteModels = false;

const extractor = await mod.pipeline('feature-extraction', modelDir, {
  dtype: 'q8',
  session_options: { enableMemPattern: memPattern },
});
const tokenizer = extractor.tokenizer;
const { shrinkToBudget } = await import(pathToFileURL(path.join(root, 'resources', 'embedding-token-guard.cjs')).href);

const raw = '记'.repeat(chars);
const cut = shrinkToBudget(raw, budget, tokenizer);
let last = null;
for (let i = 0; i < repeat; i++) {
  last = await extractor([cut.text], { pooling: 'cls', normalize: true });
}

const payload = { seq: cut.seq, memPattern, repeat };
if (echo && last && last[0]) payload.vector = Array.from(last[0].data);
// 上报护栏自己的实测值(与库口径对照)+ 本臂配置
if (typeof process.send === 'function') process.send(payload);
process.exit(0);
