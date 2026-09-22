# 三轴时间：只作辅助判据、关闭态门控与机械护栏

背景：`MemoryRecord` 早已把时间拆成三条**互不替代**的轴——记录时刻（`createdAt` /
`updatedAt`）、事实有效期（`validFrom` / `validTo`）、持续性（`persistence` ∈
`t` 无时间性 / `o` 仍在持续 / `s` 已结束 / `p` 时点事件）。但 §C 矛盾冻结的检测侧只用到了
**记录时刻**：`formatBatchConflictPrompt` 构造「统一候选记忆池」时只传 `timestamps`，
于是 LLM 判 `conflict` vs `update`/`merge` 时**看不到有效期与持续性**，无法区分
「内容矛盾但事实有先后 / 一方已过期」；裁决侧 `ConflictPairView` 只暴露双方正文，
人在面板上看不到有效期对比，只能盲判。

本次把三轴接进冻结的**检测**与**裁决**两端（`src/prompts/l1-dedup.ts`、
`src/contract.ts`、`src/conflict-service.ts`、`tests/conflict-3axis.test.ts`）。
实施中暴露出一处判据缺口（详见条 2、条 4），本 ADR 同时记录该缺口的处置。

前置：ADR-0010 已定下 §C 的四条基调——opt-in、默认关闭、不自动裁决、以及
**「零漂移是构造性的，不是比对出来的」**。本条是那套基调在三轴上的落地与**判据扩容**。

决定：

1. **三轴只作辅助事实，不进入 `ConflictResolution` 取值**。承 ADR-0010 条 2 与条 6：
   机器**仍不自动裁决**，最终结论仍由人工（或安全阀超时 / 满队列自动了结）写入。
   机械判据：`ConflictResolution = 'winner' | 'loser' | 'both' | 'auto'` **一字未改**；
   三轴**不新增数据库列**、不写入任何表，只读 `MemoryRecord` 已建模的字段。
   三轴是"把明显有时间先后的伪矛盾从队列里筛掉"，不是"替人下结论"。

2. **零漂移必须落到"每一路真实送进模型的 prompt"，不是"某一个常量没动"**。§C 有两条
   prompt：**system**（`getConflictDetectionSystemPrompt`，调用点已按开关传参）与
   **user**（`formatBatchConflictPrompt` 渲染的候选池）。首版把三键加进候选池时
   **无条件**注入，而该 LLM 调用只对 system prompt 读了开关 ⇒ `conflictFreeze=false`
   （部署默认）下模型每条候选多看 3 个键，且没有任何条款解释它们——**判据却全绿**，
   因为当时的"零漂移"只被读成"system prompt 的 off 分支没动"。
   故：**开关作为显式参数传进 `formatBatchConflictPrompt(matches, { conflictFreeze })`**，
   由函数自己决定候选池内容，而**不依赖调用点"记得"门控**——唯一调用点无门控正是首版漏判的成因。

3. **门控写在函数签名上，不写在文案里**。三键以条件展开追加；关闭态候选池对象的字段集合与
   键序与升级前**逐字段同形同序**（`record_id` / `content` / `type` / `priority` /
   `scene_name` / `timestamps`）。理由是 ADR-0010 条 1 的同款口径：零漂移要能**被构造**出来，
   而不是靠人比对 diff 看出来。

4. **零漂移用 sha1 golden 锚守，不用"不含某子串"守；且锚必须反向验证过**。
   负式子串断言只证明"没多出某个词"，证明不了"逐字未变"——本处连续两轮漏判（先漏 user 一路、
   再漏候选池扩字段）都发生在这种"看起来有断言"的护栏下。锚值取自**升级前**实现
   （`445c89f:src/prompts/l1-dedup.ts`）在**固定夹具**上的实跑输出：关闭态 user prompt
   长度 513 / sha1 `249236e4…`；system 三 mode 长度 2735 / 2009 / 2372。
   夹具的时间字段一律用固定字面量，**禁用 `new Date()`**（否则常量每次不同、护栏失效）。
   **采信前提是反向验证**：把门控强制为真、或把某一档 base 常量换成另一档，对应用例
   **必须变红**；不变红说明覆盖不到位，锚不得采信。（两处均已实测变红后还原。）

5. **裁决侧只做"让人看得见"，不做"替人判"**。`ConflictPairView` 新增
   **可选**的 `winner_valid_from_ms` / `winner_valid_to_ms` / `winner_persistence` 与
   `loser_*` 同款字段（可选 ⇒ 旧客户端忽略新字段不报错，无需版本协商）；
   列表与 `renderConflicts` 为每条对附上「有效期起 / 止、持续性」对比。
   渲染口径与正文渲染一致地**不糊弄**：`null` 不渲染成字面 `"null"`，三轴全缺时
   **不产生多余空行**——把"没有数据"渲染成一行空壳，与把两种缺失糊成一句话是同一类错误。

6. **未定档项（如实标注）**：三轴的"过期 / 更晚"判据由 LLM 在 prompt 内完成，
   **没有机械阈值**（`valid_to_ms < now` 之类的比较不在代码里执行，只是给模型的线索）；
   `persistence='p'`（时点事件）"永不被取代"属**语义约定**，无代码强制。
   即：三轴的效果**依赖模型遵守条款**，这是判据强度的诚实边界，属参数/提示词调优空间，
   不是设计返工。（与 ADR-0010 条 12 同款如实标注。）

7. **遗留（不在本条范围内）**：只读普查（Phase 0，`scripts/census-conflicts.mjs`）与
   `conflict_type` / `claim_key` 键体系（Phase 3）**尚未启动**；三轴的"辅助判据版"
   **不**替代它们——本 ADR 只覆盖已交付的三轴注入与门控。

---

## Phase 3 补充：三类冲突 + claim_key + 丢弃留痕（2026-09-22）

Phase 0 普查暴露一个缺口：LLM 判定的 `conflict` / `update` / `merge` 三分类
**只在蒸馏管线内流转**，读取面与裁决侧完全看不到——人无法区分"硬矛盾"
与"条件冲突"，额度计数也把所有类型混在一起。

决定：

8. **新增 `conflict_type` 列（hard / conditional / supersession）**。
   - `conflict_pending` 表新增 `conflict_type TEXT NOT NULL DEFAULT 'hard'`，通过
     `PRAGMA table_info` 存在性检查 + `ALTER TABLE` 幂等迁移。
   - 额度计数 **只计 hard**：`pendingHardTotal` 按 `conflict_type = 'hard'` 过滤；
     conditional / supersession 不占额度，但仍在队列中等待人工裁决。
   - `occupiesConflictQuota(type)` 纯函数决定是否占额度（当前 hard = 占，其余 = 不占）。

9. **新增 `claim_key` 列（自由标识符，空串 = 未分组）**。
   - 同一张表新增 `claim_key TEXT NOT NULL DEFAULT ''`，同样幂等迁移。
   - `claim_key` 是任意字符串（不做 enum 门控），用于标记"同一 claim 的多对冲突"
     以便面板分组显示。
   - 读取面通过 `listConflictGroupedByClaim` 按 claim_key 排序分组。

10. **投影哈希冻结**：快照兼容通过 7 字段列投影 `projectConflictsForHash` 实现，
    新增的 `conflict_type` / `claim_key` **不进入哈希输入**——冻结旧哈希不变，
    防止存量快照校验失败。

11. **`defer` 机制（R1 复看）**：`ConflictResolution` 新增 `defer` 取值
    （仅作入参，不写 `resolved_at`），写 `reviewed_at` / `defer_count`。
    - `defer` 不是结论——该对**留在待裁决队列**，重置超时计时。
    - `defer_count >= DEFER_MAX`（当前 3）后不再被超时自动了结，只能人工收口。
    - 面板通过 `review_state`（`unseen` / `deferred`）区分"没人看过"与"看过未决"。

12. **丢弃留痕表 `conflict_rejected`**：LLM 输出不满足 pair 格式时记入此表
    （`INSERT OR IGNORE`），可通过 `memory_conflicts_rejected` 工具与
    `dsh-memory/conflicts-rejected` RPC 端点查询。

组合关系更新：

- 与 ADR-0010 的关系：本条是 0010 条 1「零漂移是构造性的」的**判据扩容**——
  0010 把它落在 system prompt 一路；本条补上 **user prompt 一路**，并把"构造性"从
  "常量没动"收紧为"**函数签名门控 + sha1 golden 锚 + 反向验证**"。
  Phase 3 进一步把判据从"三轴时间"扩容到"三类冲突 + claim 分组 + 丢弃留痕"。
  0010 的其余结论（opt-in、默认关闭、安全阀、"不自动裁决"、裁决出口）**全部不变**。
- 与 ADR-0006（§B 凭证链）无关：三轴与三类不进 `l1_receipts`，凭证形状不变。
- 数据布局：`conflict_pending` 新增 2 列（`conflict_type` / `claim_key`），通过
  `ALTER TABLE` 幂等迁移；`conflict_rejected` 为新建表。`CONFLICT_FORMAT` 不 bump。
- `maxPending` / `timeoutDays` / `conflictFreeze.enabled` 默认值不变。

组合关系：

- 与 ADR-0010 的关系：本条是 0010 条 1「零漂移是构造性的」的**判据扩容**——
  0010 把它落在 system prompt 一路；本条补上 **user prompt 一路**，并把"构造性"从
  "常量没动"收紧为"**函数签名门控 + sha1 golden 锚 + 反向验证**"。
  0010 的其余结论（opt-in、默认关闭、安全阀、"不自动裁决"、裁决出口）**全部不变**。
- 与 ADR-0006（§B 凭证链）无关：三轴不进 `l1_receipts`，凭证形状不变。
- 与数据布局无关：**不新增列**、不改 `<dataDir>` 布局、不改 `pair_id` 构造输入、
  **不 bump `CONFLICT_FORMAT`**、不动 `maxPending` / `timeoutDays` / `conflictFreeze.enabled` 默认值。
- 与 §E（存储作用域）、§F（图谱向量列）无关。
