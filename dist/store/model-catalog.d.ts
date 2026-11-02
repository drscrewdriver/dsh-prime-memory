/**
 * 本地嵌入模型目录:插件内置白名单,不提供任意 repo 下载。
 * 每款锁定 revision(commit sha)+ 每文件 sha256——目录即完整性契约,
 * 升级模型 = 改这里(维度变化会触发使用方全量重嵌入)。
 *
 * 数据来源(2026-08-17 采集):
 * - revision 与 LFS 大文件 sha256:HF tree API(LFS oid 即 sha256);
 * - 小文件 sha256:从镜像按锁定 revision 下载后本地实测。
 * embeddinggemma 是 ONNX 外部权重格式:model_quantized.onnx(图,~0.5MB)与
 * model_quantized.onnx_data(权重,~294MB)必须成对存在,onnxruntime 同目录自动加载。
 *
 * 注:以下 revision/size/sha256 数据表为上游模型文件的完整性事实数据,
 * 净室重写按原值逐字保留(改动任何一位都会破坏校验)。
 */
export interface CatalogFile {
    /** 仓库内相对路径（同时是 models/<id>/ 下的落盘路径）。 */
    path: string;
    /** 字节数（磁盘检查的进度分母）。 */
    size: number;
    /** sha256 hex（64 位）。 */
    sha256: string;
}
export interface CatalogEntry {
    /** 稳定 id：嵌入源状态文件（embedding-source.json）引用它。 */
    id: string;
    /** 展示名。 */
    name: string;
    /** HF 仓库 repo id。 */
    repo: string;
    /** 锁定的 revision。 */
    revision: string;
    /** 向量维度（vec0 建表与切换重嵌的判据）。 */
    dims: number;
    /**
     * 上下文窗口（token）。0.26.25 起从「仅 UI 展示」升格为**本地推理预算的推导真值**
     * （见 `deriveTokenBudget`）——改动这里就是改本地嵌入的截断口径,不再只是个展示字段。
     */
    contextTokens: number;
    /** 池化方式：BGE 系 CLS；embeddinggemma 系（Gemma 解码器底座）MEAN。 */
    pooling: 'cls' | 'mean';
    /** UI 标签。 */
    tags: string[];
    /** 一句话说明（设置页模型卡）。 */
    description: string;
    files: CatalogFile[];
}
export declare const MODEL_CATALOG: CatalogEntry[];
/** 按 id 取目录项。 */
export declare function catalogById(id: string): CatalogEntry | undefined;
/**
 * 本地 ONNX 推理的单条 token 上限（**唯一硬编码源**,issue #22）。
 *
 * 取值 2048 的理由（不是拍脑袋）：#22 实测 Electron 宿主下约 **2700 token** 即被分配器
 * SIGTRAP 打死（栈：MatMul 输出张量 → BFCArena::Extend → malloc_zone_memalign），且峰值
 * 内存按 **O(T²)** 增长（attention 张量 `[1,heads,T,T]`）——2048 在致死线下留 ≈24% 余量，
 * 同时把单次峰值从 ≈4.7GB 压到 ≈0.43 倍。它是**崩溃护栏也是内存护栏**，两者同源。
 *
 * 不拿 `maxInputChars` 当护栏的原因：bge-m3/embeddinggemma 是 Unigram/BPE，中文≈**1 字/token**
 * 而 emoji/泰文可 >1.5，所以 5000 字符**既可只 750 token（英文）也可近 8192（中文）**——
 * 字符与 token 无稳定比值，字符帽永远约不到安全线。
 */
export declare const HARD_CAP_TOKENS = 2048;
/**
 * 推导生效的本地嵌入 token 预算（**单一实现点**,截断执行在 `resources/embedding-child.cjs`）。
 *
 * 默认（`userTokens` 缺省/0/负）= `min(modelContext, HARD_CAP_TOKENS)`：bge-small-zh(512)
 * 不受 HARD_CAP 影响（本来就到 512 窗口），bge-m3(8192) 被压到 2048。`modelContext`
 * 取不到（非目录模型）时回退 HARD_CAP_TOKENS，**取小不取大**。
 *
 * 用户显式超限只 **clamp 不抛错**（收窄 schema 边界会让已部署 YAML 解析直接失败，故障半径
 * 是整个插件配置树），`clamped` 由调用方打 warn 使其可见。
 */
export declare function deriveTokenBudget(modelContext: number | undefined, userTokens: number | undefined): {
    tokens: number;
    clamped: boolean;
};
/** 模型总字节数（磁盘检查与整体进度分母）。 */
export declare function catalogTotalBytes(entry: CatalogEntry): number;
