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
 * 为什么是 1536 而不是 2048：本值受**连发**致死线约束，不是单发线。
 * #22 报告人在 macOS/M5 上二分实测（Electron-node，5×5000 中文字符串行）：
 * 512/1024 全过、1900/1960 全过、**1990/2000/2010/2016/2020/2040/2048 均第 2 条即 SIGTRAP**
 * —— 即**连发致死线落在 1960～1990**，而单发致死线是 ≈2700（issue 初测）。
 * 两者不同源的机理：BFCArena 高水位不回落，第二条进来时第一份 T² 张量尚未回收完，
 * 新块与旧块共存瞬间的峰值才是真正的天花板。
 *
 * 而**真实负载就是连发**：`pipeline/graph.ts` 对 touched 节点「`for … await embed(…)`」
 * 逐条串行，一个投影批里常有 5～8 个节点，其中两条长就命中。
 * 1536 在连发线（≈1960）下留 ≈21% 余量（报告人建议值）；代价是单条 infer 从 ~2.2s
 * 降到 ~1.2s，反而使 `embedding.ts` 的 EMA>5s 熔断更不容易被误触发。
 * 它同时是**崩溃护栏与内存护栏**：峰值按 O(T²) 增长（attention 张量 `[1,heads,T,T]`）。
 *
 * 不拿 `maxInputChars` 当护栏的原因：bge-m3/embeddinggemma 是 Unigram/BPE，中文≈**1 字/token**
 * 而 emoji/泰文可 >1.5，所以 5000 字符**既可只 750 token（英文）也可近 8192（中文）**——
 * 字符与 token 无稳定比值，字符帽永远约不到安全线。
 */
export declare const HARD_CAP_TOKENS = 1536;
/**
 * 推导生效的本地嵌入 token 预算（**单一实现点**,截断执行在 `resources/embedding-token-guard.cjs`）。
 *
 * 默认（`userTokens` 缺省/0/负）= `min(modelContext, HARD_CAP_TOKENS)`：bge-small-zh(512)
 * 不受 HARD_CAP 影响（本来就到 512 窗口），bge-m3(8192) 被压到硬上限。`modelContext`
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
