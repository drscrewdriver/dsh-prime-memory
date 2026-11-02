# 规模台账及处理记录（dsh-prime-memory）

> **这篇是什么**：本地嵌入相关的「规模口径」（token 帽、字符帽、batch、chunk…）与 #22 崩溃链每次改动**为什么改、改到哪、拿什么证明**的账本。
> **不是**：调参教程。这里的每个数字都带「可自证性」标注——本机（Windows/纯 node）能证的与只有 macOS 能证的，绝不混写。
> **真值源纪律**：常量以代码为准（下表给了 file:line）；本文件只记录「口径 + 处理记录」，不复制常量值作为第二真值源——改常量时请同步本表并在「处理记录」里追加一行。

---

## 1. 规模口径总表（值 / 锚点 / 处理记录）

| 口径 | 值 | 代码锚（唯一真值源） | 处理记录 |
|---|---|---|---|
| 硬上限 `HARD_CAP_TOKENS` | **1536** | `src/store/model-catalog.ts`（`export const HARD_CAP_TOKENS`） | 0.26.25 定为 2048（按**单发**致死线 ≈2700 留 24%）；0.26.27 因报告人二分出**连发**致死线 (1960, 1976] 而收紧到 1536 |
| 模型 `contextTokens` | bge-small-zh 512 / embeddinggemma-300m 2048 / bge-m3 8192 | `model-catalog.ts` 三个 catalog 条目 | 0.26.25 起从「仅 UI 展示」升格为 `deriveTokenBudget` 的推导输入 |
| 生效 token 预算 | `min(contextTokens, HARD_CAP_TOKENS)`；用户显式值超限只 **clamp + warn** | `deriveTokenBudget()` | 0.26.25 确立；0.26.27 把「测试/脚本里 8 处魔数」全部改为从常量推导，防止改常量后假绿/假红 |
| 字符粗筛 `maxInputChars` | 5000 | `src/config.ts`（`embedding.maxInputChars`） | **本刀不动**（键名/边界/默认全保留）。它只管 IPC 体积与远程档，**不是崩溃护栏**——5000 中文≈3651 token，已在致死线之上 |
| LLM 侧输入帽 | 200 000 字符 | `config.ts`（`llm.maxInputChars`） | 未动；与嵌入预算无关 |
| 去重候选池 `candidatePool` | 5（min 1 / max 20） | `config.ts`（`extract.candidatePool`） | 未动；0.26.31 之后的批内自去重仍按它召回库内候选 |
| 去重单批上限 `MAX_DEDUP_BATCH_SIZE` | 20 | `src/pipeline/l1.ts` | 未动。**有意不加**：批越大 prompt 越膨胀（#10 失败面），「同会话碎片」问题改用批内预收拢解决 |
| L2 场景单块字符顶 | 24 000 | `pipeline/l1.ts`（`MAX_SCENE_CHUNK_CHARS`） | 未动；来源是「旧版整族 backlog 单调用必撞超时」 |
| reindex 批 | `CHUNK = 16` | `store/l1.ts`（`reindex()`） | 未动；崩溃自愈后由它按缺失向量逐批补 |
| sqlite IN 分块 | `IN_CHUNK = 900` | `store/sqlite.ts` | 未动 |
| 批内自去重阈值 | `extract.intraBatchDedupe=true`（默认）/ `intraBatchCosine=0.92`（有效 0.85–0.99） | `config.ts` + `pipeline/intra-dedupe.ts` | **0.26.30 新增**（只增键不改键）；schema 取宽外壁 0–10，有效区间在代码里 clamp+warn（避免配置树抛错的故障半径） |

**口径不可换算**：字符帽与 token 帽不是同类护栏（中文≈1 字/token，emoji/泰文 >1.5）。`src/util/context-occupancy.ts` 的 `CHARS_PER_TOKEN=4`（官方同值）**已明令禁止**用于嵌入预算——中文会低估 4 倍，这正是「5000 字符看着安全」长期未被怀疑的成因。

---

## 2. 时间线（每版：问题 → 动作 → 证据）

| 版本 | 提交 | 问题 | 动作 | 证据 |
|---|---|---|---|---|
| 0.26.25 | `f3c1c07` | 护栏单位错了：按**字符**截断，与崩溃条件不同源 | 改**token** 帽（2048）+ `deriveTokenBudget`；子进程 `shrinkToBudget` 按库口径实测截断；`describeExit` 保留 `signal`（SIGTRAP/OOM/自然退出不再同形） | 真 bge-m3：5000/4000/3800 字符截断后 seq=2047 |
| 0.26.26 | `fa266d2` | 真模型暴露 3 个桩测试测不到的缺陷 | ① `tokensMax` 取库口径（`.dims`，不是不存在的 `.shape`）② 按实测超出量**逐轮收紧** ③ 基准取 `max(encode, pipeline)` | 两个独立取法互验（2047 == 2047）；无护栏实测 5003 |
| 0.26.27 | `88dfcd9` | 帽只对了「单发」，真实负载是「连发」 | 帽 2048→**1536**；脚本加 `--serial`；魔数收干 | 报告人二分：1960 全过 / 1976 必崩 ⇒ 连发致死线 (1960,1976] |
| 0.26.28 | `a6b73ca` | 「实测进模型 token 数」从未落进 `memory.log` | 每批 `info` 落 `tokensMax`；fork 后补 `pid` | 真链路日志逐字节断言 |
| 0.26.29 | `28f31b2` | `tokensMax=未知` 在真实链路不可达（初值 0 + 严格大于） | 子进程初值改 **-1** | 3 例（初值哨兵/归并语义/端到端）+ 反向验证（改回 0 即红） |
| 0.26.30 | `cb9d5a6` | **机理未动**：相邻两次大推理的 T² 张量在 BFCArena 高水位不回落时共存（m=2），且崩一次停摆到宿主重启 | 三层防线：① 1536 帽（既有）② 关 memPattern（child+worker `session_options`）③ 有界自愈 respawn（60s≤2 + `ack` 断点续试一次）+ `respawnOnCrash` 键；`tokenBudget` 写 `embedding_meta` 留痕 | 见 §3 实测 |
| 0.26.31 | `bb0440e` | 0.26.30 的凭证「被批内哪条吸收」只有不回归、无专项断言 | 纯提取 `receiptItemsForAbsorbed()` + `tests/l1-receipts.test.ts` 专例（**无运行时行为变更**） | 1976 passed / 1 skipped；CI 七步绿 |

---

## 3. 实测数据（本机口径，禁止跨平台外推）

> 环境：Windows / **纯 node**（非 Electron-node）。峰值与耗时只能证「机理形状与方向」，绝对值不可搬到 macOS。

| 判据 | 结果 | 方法与边界 |
|---|---|---|
| 关 memPattern 的**输出等价性** | 三样本 **maxAbsDiff = 0**（chars 64 / 512 / 5000，1024 维） | 跨进程两臂（同模型同权重，仅 `session_options` 不同）；等价 ⇒ **不需要重嵌** |
| 关 memPattern 的**降峰** | 同形状连发 6 轮：**1597MB → 1264MB**（−333MB） | 外部轮询子进程峰值；稳态 infer 无回退 |
| token 帽对连发一致成立 | `--serial 5` 各轮 `seq = 1535` 恒定 | 只证「预算对连发一致」，**不证「连发不崩」**（后者只能 macOS） |
| 无护栏对照 | 实测 `seq = 5003`；峰值 3688MB | 证明护栏确实在拦真东西，不是恒成立 |
| 批内自去重收益 | raw 24 → exact 23 → **effective 20**；LLM 去重调用 **2 → 1** | 真 bge-m3、τ=0.92；同族同 type |
| 向量复用 | 3 条新记忆、2 条可复用 ⇒ **只嵌 1 次** | 记账型 `EmbeddingService` 注入断言 |

**收益边界（写死在这里，防止后续被夸大）**：
- 批内去重只减**条数与总时长**；对 **单次推理峰值 O(T²)** 没有任何降低。
- 峰值由 ① token 帽（降低 T）与 ② 关 memPattern（把共存份数 m 从 2 压到 1）处理，与去重无关。
- 1536 是**实测经验值**（对报告人语料留 ≈21% 余量），不是证明。

---

## 4. 被否决的方案与理由（避免重复讨论）

| 方案 | 否决理由 |
|---|---|
| recycle-on-N（跑 N 轮回收进程） | 高水位是 `max(T seen)` 的函数、不是计数累加器：同形状 24 轮区间震荡无蠕变，N≥2 回收收益≈0 而每次代价 fork+load ≈1.7s。它唯一真实收益（m:2→1）已由 memPattern 零成本拿到 |
| 降档到 1024 | 不改 m 只缩 T；1536 已在 macOS 实测拦住致死档；且对本机 L1 语料截断受众 0/1218、却带来 top-5 丢席与「token 口径/字符口径」混叠债 |
| N4 源头截断（装配侧只喂前 N 字符） | 子进程侧帽已全覆盖，崩溃面零增益；且 `nodeEmbedText` 装配 name+aliases+currentState，头部截断**先丢实质内容** |
| `enableCpuMemArena:false` 默认化 | 峰值最低但混合长度语料 infer **+130%~160% 时延**；留作文档化逃生手段，不进默认 |
| `global.gc()` / ORT arena shrinkage 环境变量 | 均证伪：T² 张量由 C++ BFCArena 持有，V8 看不见；shrinkage 传得进去但曲线重合 |
| 加大 `MAX_DEDUP_BATCH_SIZE` | prompt 随批条数线性膨胀（#10 失败面）；同会话碎片问题改由批内预收拢解决 |

---

## 5. 待外部回验（本机原理上不可证）

1. **关 memPattern 后 `--budget 2048` 连发是否仍 SIGTRAP**——一条实验决定「机理面是否闭合」。
2. respawn 后新进程**首轮**推理的 trap 概率（理论：无历史水位 → 更安全，未证）。
3. 报告人 788 条 L1 的 **token 分位**（决定 1536 长期是否够用；字符均值不可换算）。

复跑入口：
```bash
# 等价性 / 连发峰值 / 连发护栏（需本机 bge-m3 + runtime）
node scripts/verify-token-guard-realmodel.mjs --equivalence
node scripts/verify-token-guard-realmodel.mjs --repeat 6
node scripts/verify-token-guard-realmodel.mjs --serial 5

# macOS 复现（连发崩溃；三重门缺一即 SKIP，本机拿不到 trap 不作为通过依据）
node scripts/repro/embedding-repeat-crash.repro.mjs --chars 5000 --count 5 --budget 2048 --mode node
node scripts/repro/embedding-repeat-crash.repro.mjs --chars 5000 --count 5 --budget 2048 --mode electron
```
