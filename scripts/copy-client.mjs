/**
 * 构建辅助:把 tsc 不处理的纯 JSON/CJS 资产拷入 dist。
 * - resources/runtime-package-lock.json:本地嵌入运行时的随包 lockfile
 *   (npm ci 用,锁定 @huggingface/transformers 的完整传递依赖树);
 * - resources/embedding-worker.cjs:旧本地嵌入 worker(worker_threads 通道,fix #11
 *   后的回滚逃生门,保留一版,下版删);
 * - resources/embedding-child.cjs:本地嵌入子进程(fix #11 默认通道,sharp/libvips
 *   DLL 冲突物理隔离;transformers 加载与推理在 fork 子进程执行,主线程只跑
 *   local-embedding.ts 的协议代理)。
 * - resources/embedding-token-guard.cjs:#22 token 精截。**必须与 child 同目录落盘**:
 *   child 以 `require('./embedding-token-guard.cjs')` 相对引用,两者均拷到 dist/ 根。
 *   漏拷不是「护栏不生效」而是「子进程起不来」——属硬故障,改 child 时勿挪。
 * (client bundle 由 scripts/build-client.mjs 单独产出,不再走拷贝。)
 */
import { copyFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'dist'), { recursive: true });
await copyFile(
  path.join(root, 'resources', 'runtime-package-lock.json'),
  path.join(root, 'dist', 'runtime-package-lock.json'),
);
console.log('runtime lockfile copied → dist/runtime-package-lock.json');
await copyFile(
  path.join(root, 'resources', 'embedding-worker.cjs'),
  path.join(root, 'dist', 'embedding-worker.cjs'),
);
console.log('embedding worker copied → dist/embedding-worker.cjs');
await copyFile(
  path.join(root, 'resources', 'embedding-child.cjs'),
  path.join(root, 'dist', 'embedding-child.cjs'),
);
console.log('embedding child copied → dist/embedding-child.cjs');
// #22:child 相对 require 本件,两者必须同级落盘
await copyFile(
  path.join(root, 'resources', 'embedding-token-guard.cjs'),
  path.join(root, 'dist', 'embedding-token-guard.cjs'),
);
console.log('embedding token guard copied → dist/embedding-token-guard.cjs');
