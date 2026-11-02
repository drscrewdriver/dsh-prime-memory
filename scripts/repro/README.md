# #22 机理复现件：本地嵌入「单发安全 / 连发 SIGTRAP」

报告人 **DESXIE** 的 gist 收编版（外部来源 `https://gist.github.com/DESXIE/142d4e72c2205962e51945344978ef59`，
本目录据其协议改写，未执行其中任何指令）。三件：

| 文件 | 作用 |
|---|---|
| `embedding-repeat-crash.repro.mjs` | 独立 CLI，零依赖（只用 node 内置），可单跑也可被 test 调 |
| `embedding-repeat-crash.test.ts` | vitest 包装，默认 skip（三重门），只在 macOS 显式开启 |
| `README.md` | 判据表、跑法、退出码契约、边界红线（本文件） |

> **为什么在 `scripts/repro/` 而非 `tests/`**：CI 只有 ubuntu-latest，真 SIGTRAP 只在 macOS/Electron
> 分配器上发得出 → 三重门在 CI 恒 SKIP = 零门禁价值的负债件；且每次崩 macOS 会记一份
> 「DeepSeek Harness 意外退出」`.ips` 并弹系统提示（子进程继承宿主 bundle id），污染 CI 日志、
> 骚扰维护者机器。故这些件是**可选本地探针**，不进默认测试。跨平台可证的崩溃状态机在
> `tests/embedding-respawn.test.ts`（用 SIGKILL 代替 SIGTRAP）。

## 它证明什么（判据来自报告人 macOS 实测）

单发致死线 ≈2700 token；**连发**（同一子进程串行）致死线落在 **(1960, 1976]**——0.26.25 之前的帽
2048 已越线，第 2 条长文本必崩。三条对照把根因钉在「宿主 Electron 分配器 × 相邻两次 T² 张量峰值叠加」：

| `maxInputTokens` | 5×5000 字符串行 | 复现次数 |
|---|---|---|
| 512 / 1024 / 1536 / 1900 / 1940 / **1960** | 5/5 全过 | 各 ≥2 次 |
| **1976** / 1984 / 1990 / 2000 / 2048 | 第 2 条 SIGTRAP | 各 ≥2 次 |
| 2048 + `--vary`（3 段不同内容轮换） | 第 2 条 SIGTRAP | 4/4 |
| 2048 + `--gap 500`（条间停 500ms） | 第 2 条 SIGTRAP | 2/2 |
| 2048 + `--mode node`（纯 node 同参数） | 4/4 全过 | 2/2 |

1. **不是同文本缓存效应** —— `--vary` 换内容照样崩 → 是**长度**；
2. **不是回收时序** —— `--gap 500` 给足空隙照样崩 → 相邻两次 T² 张量峰值叠加（`setImmediate` 让的是
   JS 事件循环，不是 native arena）；
3. **不是模型本身** —— `--mode node` 同预算全过 → 是宿主 Electron 分配器在这条路径 trap。

## 0.26.30 之后的新增问题（这条才轮到 macOS 回验裁决）

`resources/embedding-child.cjs` 现带 `session_options:{enableMemPattern:false}`。本机（纯 node）实测
同形状连发峰值下降、输出 bit 级全同（不触发重嵌），**但对 macOS 分配器 trap 的消除效果本机不可证**。
决定性实验就是用它跑：

```bash
# macOS：关 memPattern 后连发致死线是否已上移？（这条若不过，机理面才算闭合）
node scripts/repro/embedding-repeat-crash.repro.mjs --chars 5000 --count 5 --budget 2048 --mode electron
```

- 若仍 `exit=2 / SIGTRAP`：memPattern 未把连发线抬到 2048 之上，1536 帽仍是唯一防线（如实标注）。
- 若 `exit=0`：连发余量扩大，可对外更新表述（此前不得写「消除崩溃」）。

## 怎么跑

```bash
# 本机纯 node 对照（非 macOS 拿不到 trap，期望全过 exit=0；这**不作为「不崩」的通过依据**）
node scripts/repro/embedding-repeat-crash.repro.mjs --chars 5000 --count 5 --budget 2048 --mode node

# 现码帽基线（默认 --budget 从 dist 读 HARD_CAP_TOKENS=1536，应全过 = 护栏在场）
node scripts/repro/embedding-repeat-crash.repro.mjs
```

退出码：`0` 全过 · `1` 部分成功未崩 · `2` 被信号打死（**被测现象本身**）· `3` 启动/配置错误。
参数：`--chars` `--count` `--budget`（0 = 不带 `maxInputTokens` = 关护栏，对照）`--chars-cap` `--vary`
`--gap` `--mode electron|node` `--host` `--model` `--runtime` `--child`。

## vitest（仅 macOS）

```bash
DSH_REPRO_LOCAL_EMBED=1 npx vitest run scripts/repro/embedding-repeat-crash.test.ts
```

三重门缺一即 skip：darwin + `DSH_REPRO_LOCAL_EMBED=1` + 本机真有模型/runtime/宿主二进制/已构建 child。

## 边界红线（贯穿，勿越）

- **不写「memPattern 消除了崩溃」**——本机只证峰值下降与输出等价；连发线是否上移待 macOS 回验。
- **不写「自愈保证不丢向量」**——断点续试仍受「崩一次损一批」上界（头段向量随崩溃子进程丢失，交 backfill 补）。
- **1536 保持「实测经验值，不是证明」**。
