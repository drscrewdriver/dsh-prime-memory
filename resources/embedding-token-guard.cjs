// token 精截(#22)。**独立无副作用模块**,不注册任何进程级监听:
// embedding-child.cjs 是 fork 入口(顶层有 process.on 与无 IPC 即 exit 的守卫),被测试
// require 会把副作用一并带进来(vitest worker 里实测崩在收集期),故截断逻辑只能放在这里
// 才能既被子进程用、又被测试用。**本文件同时被拷贝进 dist/**(见 scripts/copy-client.mjs)。
'use strict';

/**
 * 把一条文本裁到 **实测** token 预算内。返回 `{ text, seq }`：
 * - `text` = 应送进 pipeline 的文本；
 * - `seq` = 按库自己的口径（`padding:true, truncation:true`，含 special token）**实测将要**进模型
 *   的序列长度；不可测时为 -1（-1 是「不可证」，不是 0）。
 *
 * 为什么截断只能在子进程做：tokenizer 只在加载后的 pipeline 对象上可达，且 onnxruntime
 * 的 run() 是同步阻塞调用——单条内部不可中断，预检只能放推理前。又因为「子进程隔离」本身
 * 是 #11（libvips-42.dll 同进程撞名）的修复，不得为省一次 IPC 把 tokenize 挪回主线程。
 *
 * 为什么不靠「固定留几个位」这种推断（真 bge-m3 实测已证伪）：
 * 切 ids → decode 回文本 → pipeline 再分词，**不保证得到同一序列**——在当时的 2048 预算下实测：
 * 切 2046 个 id 解码后重分词得 2045 token，加 2 个 special token = **2047**，**只剩 1 位余量**。
 * 换一段文本就可能多漂一位而越界，所以下限靠**实测逐轮收紧**，不靠常数猜测。
 *
 * 不做「短文本跳过 tokenize」的优化：字符→token 比值按词表而变（CJK≈1、emoji/泰文>1.5、
 * 英文≈0.27），任何启发式下限都可能放走真超限的文本（实测反例：3800 中文字符 ×0.5=1900
 * 会跳过，而它实际约 2774 token，正落在 #22 致死档），而 tokenize 只占单次推理 ≈2.4%。
 * 护栏上省 2.4% 不值一个未验证的跳跃。
 *
 * 任何一步不可用（transformers 未挂 tokenizer、不认选项、decode 回空串、抛错）一律
 * **退回粗筛原文保持旧行为**：护栏不得把能跑的链路搞坏。
 *
 * 成本：每轮多一个 encode（实测占单次推理 ≈2.4%）；至多重试 ROUNDS 轮。
 */
const ROUNDS = 3;

/** 按库口径量一次真实序列长度（pipeline 内部就是 `this.tokenizer(texts,{padding:true,truncation:true})`）。 */
function seqLenOf(tok, text) {
  const enc = tok(text, { padding: true, truncation: true });
  const ids = enc && enc.input_ids;
  if (!ids) return -1;
  if (Array.isArray(ids)) return ids.length;
  if (Array.isArray(ids.dims) && ids.dims.length >= 2) return ids.dims[1];
  return -1;
}

function shrinkToBudget(raw, maxTokens, tok) {
  if (!tok || !(maxTokens > 0)) return { text: raw, seq: -1 };
  try {
    // 实测陷阱:return_tensor 缺省为 true,直取 .input_ids 得到的是 _Tensor(.length undefined
    // 且不抛错) -> 必须显式 return_tensor:false
    const ids = tok.encode(raw, { return_tensor: false });
    if (!Array.isArray(ids)) return { text: raw, seq: -1 };
    // 基准长度用原文的库口径实测值（含 special token）。注意：**不能**只看 encode 的 id 数——
    // 真 bge-m3 实测 5000 中文字符的 encode 长 5000,而 pipeline 实际会送进 5003(库自己补的
    // special token 与词表边界),所以只有库口径才是「到底进了多少」的那个数。
    let base = ids.length;
    let direct = -1;
    try {
      direct = seqLenOf(tok, raw);
    } catch {
      direct = -1;
    }
    if (direct >= 0) base = Math.max(base, direct);
    if (base <= maxTokens) return { text: raw, seq: direct >= 0 ? direct : -1 };

    // 递降量由**上一轮实测的超出量**推出,而不是猜常数:切片长度是编码的单调函数,
    // 所以每轮必比上一轮更短;再编码一次是为了拿到那个长度的真 seq,不做二次推断。
    // 起点先留 2 位（special token 的下界,真测=+2）,之后按实测超出量继续收。
    let text = raw;
    let seq = -1;
    let prevLen = ids.length;
    let cut = Math.max(1, ids.length - (base - maxTokens) - 2);
    for (let round = 0; round < ROUNDS; round++) {
      if (cut >= prevLen) cut = Math.max(1, prevLen - 1); // 保证严格变短
      const kept = ids.slice(0, cut);
      // 实测陷阱：decode 缺省 skip_special_tokens=false，会把 [CLS]/[SEP] 编回文本再二次分词
      const shrunk = tok.decode(kept, { skip_special_tokens: true });
      if (typeof shrunk !== 'string' || shrunk.length === 0) break; // decode 不可用 -> 停止递降
      text = shrunk;
      const reIds = tok.encode(text, { return_tensor: false });
      if (!Array.isArray(reIds) || reIds.length === 0) return { text: raw, seq: -1 };
      seq = seqLenOf(tok, text);
      if (seq < 0) return { text: raw, seq: -1 }; // 量不了 -> 降级（不送无法审计的截断文本）
      if (seq <= maxTokens) return { text, seq };
      prevLen = reIds.length;
      // 递降量 = 实测超出量 + 2 位余量（经验值,但正确性不依赖它:依赖上文的严格变短）
      cut = Math.max(1, prevLen - (seq - maxTokens) - 2);
    }
    // 逐轮后仍超（极端漂移）：宁报 -1（不可证）也不报一个超限的数当安全证据。
    if (seq > maxTokens) return { text, seq: -1 };
    return { text, seq };
  } catch {
    return { text: raw, seq: -1 }; // 降级:不截断,保持旧行为
  }
}

module.exports = { shrinkToBudget, seqLenOf };
