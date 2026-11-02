# 执行资源规模控制台账（scale ledger）

> **这篇是什么**：dsh-prime-memory 在「一次要处理多少数据、并发多少、崩了怎么办、慢了怎么退」上的**全部控制面**及其处理记录。不只是 #22 的 token 帽——分批、子进程拆分、自愈、熔断/退避、队列与优先级、预算留痕，都是同一主题：**把一次执行的资源占用压在可预期区间内**。
> **怎么用**：改任何一个旋钮前，先在 §1 找到它属于哪个面、在 §8 找到它的值与锚点，再读 §9 看它和别的面**打架的老账**——本仓大多数回归都出在「单看一个面合理、合起来越界」。
> **真值源纪律**：值以代码为准（§8 给了符号锚）；本文件记录「口径 + 处理记录」，改旋钮时同步本表并在「处理记录」列追加一行，不要只改一处。
> **对应的另一篇**：宿主侧限制的成因见 [electron-constraints.md](./electron-constraints.md)。

---

## 1. 全景：六个控制面

| # | 控制面 | 解决的问题 | 主要落点 | 一句话口径 |
|---|---|---|---|---|
| **F1** | **分批 / 分块（batch & partition）** | 单次调用太大 → 超时、prompt 爆炸、失败半径过大 | L1 抽取 `MAX_EXTRACT_CHUNK_CHARS`、去重 `MAX_DEDUP_BATCH_SIZE`、L2 `MAX_SCENE_CHUNK_CHARS`、reindex `CHUNK`、sqlite `IN_CHUNK`、graph `chunkOf` | **按字符/条数切块，失败半径 ≤ 一块** |
| **F2** | **子进程拆分（isolation）** | 同进程 DLL 撞名；ORT 同步调用冻结宿主；崩了拖死宿主 | `resources/embedding-child.cjs` + `store/local-embedding.ts`、worker 逃生门 | **原生重活一律出进程** |
| **F3** | **崩溃自愈（respawn）** | 崩一次停摆到宿主重启 | `respawnChannel()` / `crashCb` / `ack` 断点续试 | **有界重启：60s ≤2 次 + 只续一次** |
| **F4** | **压力控制（熔断 / 退避 / 预算）** | 慢依赖拖垮写入；反复撞同一堵墙 | `EmbedHelper` 断路器、抽取退避、`dedupRetryCap`、`consecutiveFailCap`、LLM 回退链、召回/输出预算 | **快失败 + 降级 + 有界重试** |
| **F5** | **队列与优先级（queueing）** | 后台填充堵塞用户请求 | 管线任务队列 `pickNextTaskIndex`、graph 泵护栏、子进程推理队列 `priority` | **live 永远优先，批可以被插队** |
| **F6** | **预算留痕与观测（budget & observability）** | 规模越界后无法追责/复现 | `tokensMax` / `pid` / `execPath` / `embedding_meta` / receipt digest / trace | **每个越界都要留可核对的数** |

> 记忆锚：**F1 决定「一次处理多少」，F2 决定「在哪处理」，F3 决定「坏了怎么活」，F4 决定「慢了怎么退」，F5 决定「谁先跑」，F6 决定「事后能不能证明」。**

---

## 2. F1 分批 / 分块

| 落点 | 机制 | 默认 / 值 | 处理记录 |
|---|---|---|---|
| L1 抽取分块 | `chunkByCharBudget(pending, perChunk)`；`perChunk = min(MAX_EXTRACT_CHUNK_CHARS, max(20_000, llm.maxInputChars − 42_000))`，再受 `llm.modelMaxInputChars` 与「该路由学到的块长」二次收紧 | 上限 24 000 字符；下限 20 000 | **0.26.9**（distill-load-balance 汇总）R1′：**每块 try/catch + 失败块留 pending**（部分消费，不整批丢）；同版 R5 加整轮墙钟预算、R9 加「学习到的块长只降不升」 |
| L1 去重分批 | 按固定条数切块发 LLM（`MAX_DEDUP_BATCH_SIZE`） | **20** | #10 教训：旧版整批丢单次调用，prompt 随候选池线性膨胀；**有意不加**，同会话碎片改由 0.26.30 的批内预收拢解决 |
| L2 场景整合分块 | 复用 `chunkByCharBudget`，单块路径与旧逻辑逐字一致（零漂移） | 上限 24 000 字符 | 旧版整族 backlog 单调用实测 >60s abort；分块后失败半径从「整族」缩到「一块」 |
| reindex（补向量） | 按 `CHUNK` 条取记录批量嵌入 | **16** | 崩溃自愈后由它逐批补齐；`undefined` 空洞按「本轮未取到」跳过（不炸整轮） |
| 重建（rebuild）调用估算 | `estimateCalls()`：`max(sessions, ceil((chars + 64×messages) / perChunk))` | perChunk 同上 | 让用户在触发重建前看到「大概多少次调用」，而不是跑完才知道 |
| sqlite 批量 | `IN_CHUNK`（IN 列表分块，避开变量数上限）、`VEC_SKIP_CAP`（skip 集上限） | 900 / 900 | skip 集封顶防止无限增长；封顶后宁可漏记也不爆内存 |
| 图谱侧 | `chunkOf(ids, 900)`、claim 上限 `min(limit, 9000)`、`queueMissing(500 / 启动 9000)` | 500 / 9000 | 启动补投影单次限速入队，避免一口气灌满队列 |
| 远程嵌入并发 | `concurrency`（信号量）、`maxRetries`、单次 `timeoutMs` | 4 / 2 / 10 000ms | 远程档专属；本地档不走这条（子进程串行） |
| 未蒸馏缓冲 | `PENDING_BUCKET_CAP`（桶截断）、`STARTUP_RETRY_DELAY_MS`（启动补跑） | 200 / 20 000ms | 重建取消后的大桶不至于每次蒸馏都整量序列化落盘 |

**F1 的不变量**：任何「一次处理 N 条」的地方都必须有 N 的上界与「失败只影响本块」的语义；没有上界的批是债，不是性能。

---

## 3. F2 子进程拆分

- **为什么拆**：① 插件 runtime 的 `libvips-42.dll` 与宿主 Electron 的 sharp 同名 → 同进程 `LoadLibrary` 互相顶掉（fix #11）；② ORT `run()` 同步阻塞，留主线程会冻结整个宿主页面。
- **拆什么**：模型加载 + tokenizer + 推理全部在 `resources/embedding-child.cjs`；主线程只做协议代理（`warmup` / `embed` / `ping`）。
- **IPC 体积护栏**：`embedding.maxInputChars`（5000）在**子进程侧再截一次**——它管的是「一条消息别太大」，与 token 帽不是同一护栏（见 §9-1）。
- **逃生门**：`useWorker=true` 切回 `worker_threads`（同协议），用于「宿主侧 DLL 冲突将来被根治」或排查 IPC 层问题。
- **代价**：向量必须序列化（child 走 `Array.from`，~4KB/条），以及一次 fork 的启动成本；换来的是**崩溃不传染**、DLL 冲突物理消失、宿主事件循环不被冻结。

---

## 4. F3 崩溃自愈（respawn）

| 机制 | 值 / 行为 | 为什么这样 |
|---|---|---|
| 单点发起 | 只有 `crashCb` 能触发 `respawnChannel()`；`respawnPromise` 合流 | 否则 warmup / embed / reindex 三个入口会并发 fork（风暴） |
| 速率窗 | `RESPAWN_WINDOW_MS = 60_000`，`RESPAWN_MAX_PER_WINDOW = 2` | fork+ready ≈1.72s + 首条 ≈1.21s ≈ **2.9s/次**；反复 fork 比停摆更贵 |
| 状态复用 | 自愈期间复用既有 `loading` 态（不新增契约态） | 现有 `vectorsReady()` 门与 EmbedHelper 降级链**零改动**接管半成品窗口 |
| 断点续试 | 多条目批逐条实时上报 `embedProgress{cid,done}`；崩后 `texts.slice(ack)` **只续一次** | 不整批重放（毒输入会活锁）；头段向量随子进程丢失 → 返回空洞，交周期性 backfill 逐条补 |
| 终态钉死 | `close()`/`terminated` 后任何 exit/crash 都不复活 | 否则插件卸载/切源后残留重嵌循环会把模型重新加载常驻 |
| 超限终局 | 超过速率窗 → 回 `failed`（旧语义：换源或重启恢复） | 有界失败优于无限重启 |

**表述红线**：自愈**不保证不丢向量**（头段空洞 = 少一批）；也不宣称消除崩溃。

---

## 5. F4 压力控制（熔断 / 退避 / 预算）

| 机制 | 参数 | 行为 | 为什么 |
|---|---|---|---|
| 嵌入慢调用断路器（EmbedHelper） | `SLOW_MS=5s`、`COOLDOWN_MS=60s`、`EMA_ALPHA=0.3`、连续失败 ≥2 | 熔断期内 `query/batch` 直接 `undefined` → 调用方降级 FTS-only；冷却后半开探测一次，成功复位 | 不让每条写入都干等一次慢嵌入；所有调用方本就有 undefined 降级路 |
| 抽取退避（per-session） | `extractFailures` 的 `nextAt` | 退避窗内跳过该会话 | 一个坏会话不应反复烧 LLM |
| 去重连续失败上限 | `extract.dedupRetryCap`（默认 5） | 达上限 → fail-loud + park，不再无限重放同一肥调用 | #10 的另一半：失败要显性停，不要默默循环 |
| L2 连续失败上限 | `l2.consecutiveFailCap`（默认 3） | 停攒该族 + fail-loud | 同上，L2 更贵 |
| LLM 分层输出预算 | extract 16k / dedup 8k / l2 32k / l3 16k / graph 8k（`resolveLayerTokens`，可被运行时覆盖，硬顶 `llm.maxTokens=65 536`） | 每层调用带显式 maxTokens | 层与层的信息密度不同；用小预算压住长尾成本 |
| LLM 回退链 | `llm.fallbacks`：主路由失败（error/aborted/网络异常/空输出）按序降级 | 每条路由**各享全额** `timeoutMs` | 慢 TTFT 模型的回退位要留足首包时间 |
| 整轮墙钟预算 | `llm.extractTimeBudgetMs`（默认 0 = 不限） | 超时即收手，防单轮独占泵 | 批多时避免「一轮跑到天荒地老」 |
| 模型真实容量 | `llm.modelMaxInputChars`（默认 0 = 沿用旧口径） | 与 42k 余量一起决定 perChunk | 模型换了不用改代码，只要声明容量 |
| 召回预算 | `maxResults=5`、`maxCharsPerMemory=500`、`maxTotalRecallChars=2000`、`recall.timeoutMs=5000` | 注入内容有长度与时间双帽；超时**静默跳过本轮** | 绝不因为召回慢而拖慢对话 |
| 过时播报 | `MAX_PER_TURN = 8` | 单轮最多播报 8 条，超出折叠 | 防一次批量误操作灌满上下文 |
| 触发阈值 | `minMessages=6`（起步从 1 翻倍爬坡）、`idleSeconds=300`、`backgroundMessages=10` | 攒够才抽；静默兜底 | 省 token 的同时保证「用户走了也落袋」 |
| 保留期 | `trace.retentionDays=14`、`tokenCost.retentionDays=365` | 观测数据有界 | 观测面不能自己变成规模问题 |

---

## 6. F5 队列与优先级

| 队列 | 选择规则 | 关键护栏 |
|---|---|---|
| 管线任务队列（`runner`） | `pickNextTaskIndex`：**live > graph > 队首** | `drain()` 单飞（`draining` 标志，不并发跑任务）；单任务失败只 warn，不中断后续 |
| 图谱泵 | `graphPumpQueued` 单飞；**每轮 drain 至多消费 1 个 graph 任务**；有实际投影才续排 | 永远让位 live；claim 落空即停泵，等下一个触发源（不空转） |
| 子进程推理队列（child） | `priority===true && texts.length===1` → `queue.unshift`；批 → `queue.push`；`pump` 单飞；**条与条之间 `setImmediate` 让路** | 让「单条召回 query」插到 reindex 长批之前；批内条目仍可被后来的插队 |
| 去重批 | 逐批串行发 LLM（不并发） | 批间不并发，避免同时多份大 prompt |
| 待蒸馏三桶 | `auto / chat / work` + 按会话切片（`groupPendingBySession`） | 单会话失败不连坐同桶其它会话 |

**F5 的本质**：这不是「吞吐优化」，而是**优先级与饥饿控制**——后台工作永远不能把用户轮次卡住。

---

## 7. F6 预算留痕与观测（规模越界必须可追）

| 留痕 | 落点 | 回答什么 |
|---|---|---|
| `tokensMax`（每批） | `memory.log` 的 info 行 | 这一批真正进模型的最大 token 数（-1 = 不可证） |
| `pid` / `execPath` / `release` | 拉起日志 | 崩的是哪个子进程、跑在哪种运行时下（Electron vs 纯 node） |
| 生效 `tokenBudget` | `embedding_meta.embedding_token_budget` | 库里的向量是在哪个帽下嵌出来的（只记录，不进重嵌判据） |
| 去重凭证 | `l1_receipts`（kind + `input_digest` + 批内吸收关系） | 这一条当时看到什么候选池、被判成了什么、被谁吸收 |
| trace / token 账本 | `trace` / `token_cost` | 分层调用次数与成本的时间序列 |

---

## 8. 参数总表（值 / 符号锚）

> 值以代码为准；改任一项请同步本表与 §2–§7 的「处理记录」。

| 参数 | 值 | 锚点 |
|---|---|---|
| `HARD_CAP_TOKENS` | **1536** | `src/store/model-catalog.ts` |
| 模型 `contextTokens` | 512 / 2048 / 8192 | `model-catalog.ts` 三个 catalog 条目 |
| `embedding.maxInputChars` | 5000 | `src/config.ts`（只 IPC/远程面） |
| `embedding.timeoutMs` | 10 000 | 同上 |
| `embedding.respawnOnCrash` | `true` | 同上（0.26.30 新增，只增不改键） |
| `RESPAWN_WINDOW_MS` / `RESPAWN_MAX_PER_WINDOW` | 60 000 / 2 | `src/store/local-embedding.ts` |
| `MAX_EXTRACT_CHUNK_CHARS` | 24 000 | `src/pipeline/l1.ts` |
| `MAX_SCENE_CHUNK_CHARS` | 24 000 | `src/pipeline/l1.ts` |
| `MAX_DEDUP_BATCH_SIZE` | 20 | `src/pipeline/l1.ts` |
| perChunk 下界 / 余量 | 20 000 / 42 000 | `src/pipeline/l1.ts`（`max(20_000, X − 42_000)`） |
| `extract.candidatePool` | 5（1–20） | `src/config.ts` |
| `extract.intraBatchDedupe` / `intraBatchCosine` | `true` / 0.92（0.85–0.99，代码 clamp） | `config.ts` + `pipeline/intra-dedupe.ts`（0.26.30 新增） |
| `extract.minMessages` / `idleSeconds` / `backgroundMessages` | 6 / 300 / 10 | `src/config.ts` |
| `extract.dedupRetryCap` / `l2.consecutiveFailCap` | 5 / 3 | 同上 |
| reindex `CHUNK` | 16 | `src/store/l1.ts` |
| sqlite `IN_CHUNK` / `VEC_SKIP_CAP` | 900 / 900 | `src/store/sqlite.ts` |
| graph `chunkOf` / claim / `queueMissing` | 900 / 9000 / 500（启动 9000） | `src/store/graph-store.ts` + `src/pipeline/runner.ts` |
| `PENDING_BUCKET_CAP` / `STARTUP_RETRY_DELAY_MS` | 200 / 20 000 | `src/pipeline/runner.ts` |
| EmbedHelper `SLOW_MS` / `COOLDOWN_MS` / `EMA_ALPHA` / 失败阈值 | 5 000 / 60 000 / 0.3 / ≥2 | `src/store/embedding.ts` |
| 远程嵌入 `concurrency` / `maxRetries` / `timeoutMs` | 4 / 2 / 10 000 | `src/store/embedding.ts` |
| LLM 层预算 extract/dedup/l2/l3/graph | 16 000 / 8 000 / 32 000 / 16 000 / 8 000 | `src/llm.ts` |
| `llm.maxTokens` / `llm.timeoutMs` | 65 536 / 120 000 | `src/config.ts` |
| `llm.extractTimeBudgetMs` / `modelMaxInputChars` | 0 / 0 | `src/config.ts` |
| 蒸馏 LLM 调用的串行性 | **无并发配置项**——由 `runner.drain()` 单飞保证（任务队列逐个跑） | `src/pipeline/runner.ts` |
| backfill `maxRecords` / `timeBudgetMs` / `concurrency` / `callTimeoutMs` / `cancelGraceMs` | 300 / 1 800 000 / 1 / 240 000 / 15 000 | `src/config.ts` |
| recall `maxResults` / `maxCharsPerMemory` / `maxTotalRecallChars` / `timeoutMs` | 5 / 500 / 2 000 / 5 000 | `src/config.ts` |
| 过时播报 `MAX_PER_TURN` | 8 | `src/hooks/obsolete-notice.ts` |

---

## 9. 面与面的冲突（老账本，改任何一项前先读）

| # | 冲突 | 已定裁决 | 依据 |
|---|---|---|---|
| 1 | 字符帽 vs token 帽 | **两个护栏，不许换算**：字符帽只管 IPC 体积/远程档，token 帽只管本地推理 | 5000 中文≈3651 token，已在单发致死线之上；`CHARS_PER_TOKEN=4` 已禁止用于嵌入预算（中文低估 4 倍） |
| 2 | batch 越大越省调用 vs prompt 膨胀 | **20 封顶**，碎片问题改用批内预收拢 | #10 失败面：prompt 随批条数线性膨胀，超时即整批失败 |
| 3 | 分块越多失败半径越小 vs 调用次数越多 | **按字符预算切 + 逐块容错**（失败块留 pending 重投） | 一整块失败不该连坐其余块，但也不能碎到失去上下文 |
| 4 | 并发越高吞吐越好 vs 子进程单飞 | 远程嵌入 **4**、backfill **1**；蒸馏 LLM 调用**由 `drain()` 单飞天然串行**（没有并发旋钮） | 本地推理在子进程里本就是串行队列；多并发只会在同一队列堆活 |
| 5 | 单条召回要快 vs 长批要连续 | **priority 只对单条请求生效**（批仍追加队尾） | 让用户 query 插队，但不打乱 reindex 的长批语义 |
| 6 | 熔断 60s vs 自愈 60s 窗 | **允许重叠**：熔断半开探测会自然恢复；**不要**为自愈复位 `failStreak` | 复位会把「慢依赖」误判成健康，破坏背压 |
| 7 | 自愈要快 vs 毒输入会活锁 | **不整批重放 + ack 切片 + 速率窗 2/60s** | 毒记录最多吃 2 批；第三次进 failed，显性终局 |
| 8 | 降峰（memPattern）vs 时延（arena 关闭） | 选 **memPattern**（零 infer 代价）；`enableCpuMemArena:false` 只作逃生手段 | arena 关闭在混合形状下 infer +130~160% |
| 9 | 收紧上限 vs 配置树安全 | **宽外壁 + 代码内 clamp+warn**，不用窄区间 schema | 收窄边界会让已部署 YAML 解析直接抛错，故障半径是整个配置树 |
| 10 | 观测越全越好 vs 观测自己变成规模问题 | 保留期 + 条数上限（trace 14 天 / token 账本 365 天 / 播报 8 条/轮） | 观测面必须有界 |

---

## 10. 实测与自证边界（本机口径）

> 环境：Windows / **纯 node**。峰值与耗时只证「机理形状与方向」，绝对值不可搬到 macOS。

| 判据 | 结果 | 边界 |
|---|---|---|
| 关 memPattern 输出等价性 | 三样本 **maxAbsDiff = 0**（chars 64/512/5000） | 跨进程两臂；等价 ⇒ 不需要重嵌 |
| 关 memPattern 降峰 | 连发 6 轮 **1597MB → 1264MB** | 外部轮询；稳态 infer 无回退 |
| token 帽对连发一致 | `--serial 5` 各轮 `seq = 1535` | 只证预算一致，**不证不崩** |
| 无护栏对照 | `seq = 5003`；峰值 **3.6–3.7GB**（两次运行 3600 / 3688MB） | 证明护栏在拦真东西 |
| 批内去重收益 | raw 24 → exact 23 → **effective 20**；LLM 调用 **2 → 1** | 只减条数/时长，**不降单次峰值** |
| 向量复用 | 3 条 / 2 复用 ⇒ 只嵌 1 次 | 记账型 EmbeddingService 注入 |
| 自愈成本 | fork+ready ≈1.72s，首条 ≈1.21s ⇒ ≈2.9s/次；reindex 75 chunk 最坏 +16~22% 总时长 | 速率窗 ≤2 次/60s 的定量依据 |

**待外部回验（本机不可证）**：① 关 memPattern 后 `--budget 2048` 连发是否仍 SIGTRAP；② 自愈后新进程首轮 trap 概率；③ 报告人语料的 token 分位（决定 1536 长期是否够用）。

---

## 11. 被否决的方案与理由

| 方案 | 否决理由 |
|---|---|
| recycle-on-N（跑 N 轮回收） | 高水位是 `max(T seen)` 的函数、非计数累加器：同形状 24 轮无蠕变；收益≈0，代价 fork+load ≈1.7s/次。其唯一真实收益（m:2→1）已由 memPattern 零成本获得 |
| 降档到 1024 | 不改 m 只缩 T；1536 已实测拦住；对本机语料截断受众 0/1218，却带来 top-5 丢席与口径混叠债 |
| N4 源头截断 | 子侧帽已全覆盖（崩溃面零增益）；装配文本头部截断先丢实质内容 |
| `enableCpuMemArena:false` 默认化 | 混合长度语料 infer +130~160% 时延；只作逃生手段 |
| `global.gc()` / ORT shrinkage env | 证伪：T² 张量由 C++ BFCArena 持有，V8 不可见 |
| 加大 `MAX_DEDUP_BATCH_SIZE` | prompt 线性膨胀（#10） |
| 为自愈复位 `failStreak` | 会把慢依赖误判为健康 |
| 用窄 schema 区间卡新键 | 配置树抛错的故障半径过大；改宽外壁 + clamp+warn |

---

## 12. 变更时间线（只记与执行资源规模相关的）

| 版本 | 动作 | 证据/备注 |
|---|---|---|
| 0.26.x 早期（CHANGELOG『Unreleased — 长任务模式』节） | **F2 fix #11 子进程隔离**：模型加载/推理搬进 fork 子进程 | 解 DLL 撞名 + 事件循环冻结；早于 0.26.9 的分块/调度批 |
| **0.26.9**（distill-load-balance 汇总，2026-10-23） | **F1/F4/F5 成批落地**：R1′ 块级容错 + 部分消费；R1 L2 分块（零漂移）；R3 二线大容量兜底；R4 fail-closed 显式路由；R9 路由健康学习（只降不升）；R10 面板可调蒸馏超时；R5 整轮墙钟预算 + 模型容量；R6 反刍豁免退避；**R7 live flush 按 (session,mode) 去重** | **R1″（去重批 checkpoint 续跑）同版明确未做**：去重批崩仍整轮抛穿（无数据丢失但重付抽取成本） |
| 0.26.25–0.26.31 | **F6 → F1/F4 → F3**：#22 链（token 帽 2048→1536、tokensMax 留痕、`-1` 不可证、memPattern 降峰、有界自愈 + ack 断点续试） | 详见 §10 与 CHANGELOG |
| 0.26.30 | **F5/F1 补充**：批内自去重（同族同类向量收拢）+ 写侧向量复用（同一条记忆不再嵌两次） | 见 §10 收益行 |

---

## 13. 复跑与观测入口

```bash
# F1/F4 规模与预算（真 bge-m3，需本机 runtime + 模型）
node scripts/verify-token-guard-realmodel.mjs --equivalence   # 输出等价性（关 memPattern）
node scripts/verify-token-guard-realmodel.mjs --repeat 6      # 连发峰值两臂
node scripts/verify-token-guard-realmodel.mjs --serial 5      # 连发护栏一致性

# F2/F3/F6 装机侧可自证的部分
node scripts/verify-desktop-smoke.mjs        # [A] 产物断言 / [B] 监听口 / [C] 进程内读端到端
node scripts/verify-claims.mjs               # 宿主提供包不在 profile node_modules 的反证

# macOS 连发崩溃复现（三重门：darwin + DSH_REPRO_LOCAL_EMBED=1 + 本机有模型/宿主）
node scripts/repro/embedding-repeat-crash.repro.mjs --chars 5000 --count 5 --budget 2048 --mode electron

# 观测面
grep -E "一批完成|子进程拉起|自愈|断点续试|熔断|L1 批内自去重" ~/.dsh/memory/memory.log
```
