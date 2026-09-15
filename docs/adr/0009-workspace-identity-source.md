# 工作区标识的来源：canonical cwd，而非宿主的 WorkspaceId

背景：§E（存储作用域）需要一个"当前工作区"标识来做归属与可见性判定。落地时发现
**宿主已经有这个概念的实现**：`@deepseek-ai/dsh-workspace` 提供 `ctx.workspaceRegistry`，
其 `Workspace.id` 是 `WorkspaceId`——一个 uuid。类型定义里写着：

> *"A generated uuid, **never the path**: path normalization rewrites paths,
> and a reference anchor must stay stable."*

一个字节不差地照用它是很自然的选择：宿主既然有权威实体，我们凭什么另造标尺？
**本 ADR 记录的是"没有照用它"以及为什么**——因为这个决定与宿主的显式设计取向相反，
不留痕的话，日后读代码的人（或我自己）会把它当成一处疏忽。

决定：

1. **工作区标识取 canonical cwd（会话 `session.header.cwd` 的归一形态），不取 `WorkspaceId`。**
   四条理由，前两条是决定性的：

   | # | 理由 | 说明 |
   |---|------|------|
   | 1 | **同步可得** | `session.header.cwd` 与 §A 用的 `parentSession` 是**同一条通路**（`dsh-session` 的 `SessionHeader`，两个字段相邻）。§A 的 spike 已把这条通路实测过——零新增风险。而 `WorkspaceId` 要经 `workspaceRegistry.resolveByPath()`，是 **async**。 |
   | 2 | **不能声明 `inject`** | 把 `workspaceRegistry` 写成硬依赖，宿主缺该服务时**整棵插件树加载失败**——直接违反 ADR-0008 条 4。走 `ctx.get()` 宽容路径虽可行，但那就不再是"同步可得"，退化成"异步 + 服务缺失分支"。 |
   | 3 | **宿主自己就拿 cwd 当身份** | `Workspace` 的成员判据原文：*"Membership requires both an id in that account and a session header whose canonical cwd equals the workspace path."* —— cwd 是宿主认可的身份来源，不是我们另造的标尺。 |
   | 4 | **uuid 需要"已注册的工作区"** | 未注册目录在 uuid 方案下**没有 id**，只能整片回落 `global`——隔离静默失效，且用户无从察觉。消费者的记忆隔离不该先要求用户去宿主里注册工作区。 |

2. **归一是纯字符串操作**（`path.resolve` + Windows 转小写），**不碰文件系统、不抛、无 I/O**。
   理由：`fs.realpath` 是 async 且**在路径不存在时 reject**（`realpathNormalize` 的文档原文：
   *"A path that does not exist rejects with the original ENOENT"*）。把它接进写入与召回
   主链路，等于让一次 fs 失败有机会打断蒸馏——而 §E 的定位是"可见范围过滤"，
   不该拥有这种能力。

3. **归一收在存储层，不只收在调用方。** `MemoryDb.upsertL1` 对传入的 `workspaceId`
   再归一一次。理由不是"防御性冗余"，而是一次**真实故障**：检索侧传归一后的小写路径、
   写入侧原样存调用方给的大写字符串 → `isScopeVisible` 的字符串相等判定必然落空，
   表现为"**记忆写进去了，但再也查不出来**"。写入路径不止一条（抽取管线 / `memory_add` /
   `memory_import` / 外部导入），逐个记得归一迟早漏一个；收在存储层才是结构性保证。

4. **取不到标识一律回落 `global`（fail-open），不抛、不阻断。**
   宁可退化成"全局可见"，也不能因为拿不到 cwd 就让记忆**写不进去**或**读不出来**。
   与 ADR-0008 条 4 同源。

5. **`isScopeVisible` 的"不过滤"与"匹配空归属"必须分开写死。**
   调用方没传标识时（`cfg.scope='global'`）是**不做过滤**，不是"匹配 `workspace_id` 为空的记录"。
   两者写成一个表达式的话，既有部署会从"零漂移"变成"只看得见 global 记录"——
   一个没有报错的行为变更。

已知边界（是选择的代价，不是待办事项）：

- **不解析符号链接**。宿主 `realpathNormalize()` 走 `fs.realpath`，对符号链接指向同一目录的
  两种拼写会给出不同标识；本实现会给两个。后果是**过度隔离**（同一目录的两种 cwd 拼写
  互相看不见），而非泄漏。
- **取向说明**：拼写差异在实践中罕见（同一会话的 cwd 来自同一来源），
  而"过度隔离"至少是安全方向——记忆看起来少了，不会串到别的工作区。

失效条件（何时应当重新评估本条）：

- 若出现"同一物理目录以不同拼写进入 cwd"的真实案例（例如 symlink 工作流），
  则应改为：**异步**解析 `realpathNormalize`，失败回落当前的字符串归一——
  即把"精确"做成可选精化而非必需前提。
- 若插件将来**必须**声明 `workspaceRegistry` 依赖（例如要读 `Workspace.title` 做展示），
  则条 2 的理由消失，届时可重新考虑用 uuid 并接受"未注册目录回落全局"。
- **`dsh-prime-memory` 的 `scope` 与 mnemon 的 `storageScope` 不是同一件事**：
  后者选**存储根目录**（`global`/`custom`/`workspace` 指向不同目录），前者选**同一根内的可见范围**。
  本仓库的 `resolveDataDir` 语义**未被改动**（ADR-0008 条 5）。

组合关系：

- 与 ADR-0008：本 ADR 只补充"标识从哪来"，不改其五条决策中的任何一条。
- 与 §A（子代理档位隔离）：**两者都从 `session.header` 取信息，但取的是不同字段**
  （§A 取 `parentSession`，§E 取 `cwd`），也都不能声明硬 `inject`。
  §A 解决"同一会话树内的可见性"，§E 解决"同一档位下跨工作区的可见性"。
- 与 §C（矛盾冻结）：待裁决队列**尚未**接入 `scope`（ADR-0008 组合关系末条已登记），
  届时若给队列加作用域维度，其工作区标识**必须走本 ADR 的同一个入口**
  （`workspaceIdOf` / `sessionWorkspaceIdOf`），不得各写一份 cwd 解析。
