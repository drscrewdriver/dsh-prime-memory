// token 精截(#22)。**独立无副作用模块**,不注册任何进程级监听:
// embedding-child.cjs 是 fork 入口(顶层有 process.on 与无 IPC 即 exit 的守卫),被测试
// require 会把副作用一并带进来(vitest worker 里实测崩在收集期),故截断逻辑只能放在这里
// 才能既被子进程用、又被测试用。**本文件同时被拷贝进 dist/**(见 scripts/copy-client.mjs)。
'use strict';

/**
 * 把一条文本裁到 token 预算内。返回**实际应送进 pipeline 的文本**。
 *
 * 为什么截断只能在子进程做:tokenizer 只在加载后的 pipeline 对象上可达,且 onnxruntime
 * 的 run() 是同步阻塞调用——单条内部不可中断,预检只能放推理前。又因为「子进程隔离」本身
 * 是 #11(libvips-42.dll 同进程撞名)的修复,不得为省一次 IPC 把 tokenize 挪回主线程。
 *
 * 预算留 special token 位([CLS]/[SEP] 实测 +2):截完要 decode 回文本再送 pipeline,
 * pipeline 内部会重新分词并补上 special token。
 *
 * 不做「短文本跳过 tokenize」的优化:字符→token 比值按词表而变(CJK≈1、emoji/泰文>1.5、
 * 英文≈0.27),任何启发式下限都可能放走真超限的文本(实测反例:3800 中文字符 ×0.5=1900
 * 会跳过,而它实际约 2774 token,正落在 #22 致死档),而 tokenize 只占单次推理 ≈2.4%
 * (121-136ms vs 5427ms)。护栏上省 2.4% 不值一个未验证的跳跃。
 *
 * 任何一步不可用(transformers 未挂 tokenizer、不认选项、decode 回空串、抛错)一律
 * **退回粗筛原文保持旧行为**:护栏不得把能跑的链路搞坏。真实偏差由 tokensMax 实测上报兼证。
 */
function shrinkToBudget(raw, maxTokens, tok) {
  if (!tok || !(maxTokens > 0)) return raw;
  try {
    // 实测陷阱:return_tensor 缺省为 true,直取 .input_ids 得到的是 _Tensor(.length undefined
    // 且不抛错) -> 必须显式 return_tensor:false
    const ids = tok.encode(raw, { return_tensor: false });
    if (!Array.isArray(ids) || ids.length <= maxTokens) return raw;
    const kept = ids.slice(0, Math.max(1, maxTokens - 2));
    // 实测陷阱:decode 缺省 skip_special_tokens=false,会把 [CLS]/[SEP] 编回文本再二次分词
    const shrunk = tok.decode(kept, { skip_special_tokens: true });
    return typeof shrunk === 'string' && shrunk.length > 0 ? shrunk : raw;
  } catch {
    return raw; // 降级:不截断,保持旧行为
  }
}

module.exports = { shrinkToBudget };
