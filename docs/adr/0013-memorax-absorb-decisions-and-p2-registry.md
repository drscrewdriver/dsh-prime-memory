# ADR-0013 memorax-absorb 四波决策留痕与 P2 触发条件登记

> 状态：已采纳（2026-09-28，随 0.18.3 发布）
> 来源：`refer-memorax-code` 对比 + 计划 `dsh-prime-memory-memorax-absorb`（spec v2.1 / findings）
> 本 ADR 合并登记该计划 spec「交付留痕」承诺的四项决策 ADR 与 P2 触发条件表。

## 决策 ① 崩溃恢复的水位线对账与降级链（§A）

- **决策**：resume 时以 `MAX(l0_conversations.turn)` 为水位线，只补收其后 bracket 完整的尾轮（上限 2），不做全量对账。
- **理由**：L0 为追加式事实源从不裁剪 → 水位线崩溃安全且免新状态文件；窗口收窄与冷启动地板"防历史倾倒"的原动机调和。
- **幂等**：水位线只判"整轮无"，恢复窗口内逐 turn `(session_id, turn)` 存在性检查兜底部分写（重放 record id 非确定，upsert 不能去重）。
- **降级链**：`agent.session.events` → `ctx.sessionQuery.readSession` → `ctx.sessionPersistence.readFrom` → 维持现状 + 一次性提示；全程 fail-open，不阻塞会话启动。

## 决策 ② 脱敏默认开启及其翻案口（§C）

- **决策**：`capture.redactSecrets` 默认 `true`——偏离本仓库"新特性默认关"惯例（graph/conflictFreeze 先例）。
- **理由**：memorax 同一立场——密钥进入记忆库后被逐轮召回注入上下文并在 UI 展示的危害，大于偶发误脱敏；8 类词表 + 安全值 allowlist 控制误伤面。
- **代价（已明示）**：开启后 L0 原文自此改变，重建不可得原文。
- **翻案口**：`false` 一键回明文（逐字节旧行为，差分测试钉住）；改默认值 + 一条测试即完成翻案。

## 决策 ③ 注入确认的回执协议与超时降级（§D）

- **决策**：`dedupe.mark` 从 pre-step 返回瞬间改为"pending → 日志回执"两段式——capture 在 `session/event` 观察到注入消息（`user/message` + `plugin:memory` 署名 + 稳定 id）真实入日志时才标记。
- **顺序约束（审计 P1-3）**：回执匹配置于 `source.kind !== 'user'` 过滤**之前**（注入消息非 user 来源，放过滤后永远到不了匹配且无测试变红）——有正向回归测试钉住。
- **双向 fail-open**：未确认即弃（模型没看到的不抑制，允许重注）；5 分钟超时降级为照旧标记 + 一次性提示（防确认链路自身故障导致 dedupe 永久失效）。

## 决策 ④ 追踪 metadata-only 默认（§F）

- **决策**：`trace.captureContent` 默认 `false`——召回事件只存 `queryChars + querySha`（sha256 前 16 位），`true` 才存 query 原文（≤200 字符）。
- **理由**：追踪价值主要在 id/分数/时延/结局，不在 query 原文；隐私纪律优先（对齐 memorax 的 metadata-only 模式）。
- **配套**：按天 JSONL + 保留期默认 14 天（切日清理）+ 单日 5MB 停写 + marker；写失败静默，追踪绝不影响主链路。

## P2 触发条件登记（§G-§K，不排期）

| 项 | 内容 | 触发条件 |
|----|------|---------|
| §G | workspace 身份源升级：可选 `git-remote` 指纹身份（memorax `repository/scope.ts` 的 remote→repositoryKey + 显式 fallbackReason + 受限升级状态机）；cwd 保留为默认与回退 | 实际发生同仓库多路径/worktree 导致 work 族分裂 |
| §H | `origin: user-stated` 信任维度：显式记忆禁止蒸馏静默 update/merge，必须走冻结/裁决 | 出现真实误合并用户显式指令的案例 |
| §I | Repo Memory 第三记忆面（git commit facets → work 族证据；`.repo_memory` bundle；adaptive 更新策略） | work 族记忆被证实缺仓库侧证据支撑 |
| §J | 检索门控本地实验（每轮注入 vs 强阈值/cadence 混合） | §F 落地后 bench 能量化 token 节省 vs 召回损失 |
| §K | 架构契约测试（import 无环 + docs 链接检查） | src 结构下次大改时顺带 |

## 开放项

- §A 真机端到端验证（真机崩溃 → resume → 尾轮入 L0）：自动化夹具已覆盖，活宿主窗口验证待执行（计划 task_9 登记项）。
