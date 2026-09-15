/**
 * vec0 编码工具:抽取向量 ↔ Buffer 的**唯一**编码约定。
 *
 * 为什么单独一个文件:`l1_vec` / `l0_vec`（在 `sqlite.ts`）与 `graph_node_vec`
 * （在 `graph-store.ts`）必须用**同一种**二进制编码，否则同一份 vec0 扩展会出现
 * 两种字节布局。而 `sqlite.ts` 已经 import 了 `GraphStore`——若让 `graph-store.ts`
 * 反过来 import `sqlite.ts`，就形成模块环：能跑，但生死取决于加载顺序，
 * 属于"隐式依赖"，不是可以留在代码里的东西。
 */
/** 全零向量(cosine 未定义,不可入向量表)。reindex 侧用它区分"不可嵌入"与"写入失败"。 */
export function isZeroVector(vec) {
    for (const v of vec) {
        if (v !== 0)
            return false;
    }
    return true;
}
/**
 * Float32Array → Buffer（零拷贝视图，共享底层 ArrayBuffer）。
 * vec0 的 `float[N]` 列按 little-endian 连续 float32 读取，这正是该视图的布局。
 */
export function vecToBuffer(vec) {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
