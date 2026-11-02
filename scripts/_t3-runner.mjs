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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(runtimeDir, 'package.json'));
const mod = req('@huggingface/transformers');
mod.env.allowRemoteModels = false;

const extractor = await mod.pipeline('feature-extraction', modelDir, { dtype: 'q8' });
const tokenizer = extractor.tokenizer;
const { shrinkToBudget } = await import(pathToFileURL(path.join(root, 'resources', 'embedding-token-guard.cjs')).href);

const raw = '记'.repeat(chars);
const cut = shrinkToBudget(raw, budget, tokenizer);
await extractor([cut.text], { pooling: 'cls', normalize: true });

// 上报护栏自己的实测值,由父进程与库口径对照
if (typeof process.send === 'function') process.send({ seq: cut.seq });
process.exit(0);
