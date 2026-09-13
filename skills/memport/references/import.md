# MemPort 导入 — 把 `.mem` 包并入 DSH 记忆库

在 **DSH** 里执行(需要该会话具备记忆工具)。核心要求:**先查冲突,再落库;不静默覆盖,不伪造时间**。

---

## 0. 写入通道(先选通道,再动手)

**首选是工具刷写**:由模型调用插件的写入工具把记忆灌进库,而不是绕过插件直接动文件或数据库。工具是插件对外的正式契约,它负责落盘、建索引、算嵌入与写事实源;绕过它就等于绕过了这些保证。

| 次序 | 通道 | 落库方式 | 保真度 | 需重启 |
| --- | --- | --- | --- | --- |
| **1(默认)** | **`memory_import` 工具** | 一次调用批量写入(数组入参) | **全字段**:`created_at`/`updated_at`/`valid_from`/`valid_to`/`persistence`/`origin`/`conflict`/`rewritten` 全保留 | 否 |
| 2(兜底) | 遗留 JSONL 批量 | 落 `~/.dsh/memory/l1/records.jsonl`,插件启动时导入(`src/store/l1.ts:66-97`) | 全字段 | **是** |
| 3(最后) | `memory_add` 逐条 | N 次工具调用 | 全字段(但逐条调用成本高) | 否 |

**决策顺序**:探测会话里是否注册了 `memory_import` → 有就用通道 1;没有(插件版本早于本次增强)则看能否重启 → 能就用通道 2;都不行才用通道 3 逐条 `memory_add`。

三者在**能力**上已无差别(都能带时间轴与溯源),差别只在一次调用能写几条、是否需要重启。所以"降级"不再意味着数据失真——这是本次改造与初版最重要的区别。

### 已被证伪的路径(不要走)

- ❌ **直接写 `~/.dsh/memory/records/YYYY-MM-DD.jsonl`**:该目录是**只写不读**的审计侧车(`src/store/l1.ts:2-8`、`:113`)。不重启则永不被读;一旦跑「重建记忆」,`records/` 会被整体改名成 `records.bak.<ts>`(`src/pipeline/rebuild.ts:307-327`)并清空 L1 表,注入内容既不入库也被移走。
- ❌ **直接改 `memory.db`**:绕过嵌入、索引与一致性,且 SQLite 是**唯一可检索事实**(重建只从 L0 重导,`rebuild.ts:169`,不消费 L1 JSONL)。

### 共同前置

- `dsh-memory.memoryMutate: true`(高权限写入)必须开启,否则写入工具直接返回拒绝提示。
- **每批上限 200 条**(`memory_import` 的硬上限,超出会拒绝整批)。`emit --batch-size` 默认已按 200 切批。
- 首次导入先跑 10 条试跑,核对无误再全量。

## 1. 六阶段流程

### 阶段 0 · 读包与校验

```bash
python scripts/memport.py validate <bundle>.mem
```

- 退出码 0 → 继续;2 → **停止**,把 errors 回给导出侧修包。warning 要带进最终报告。
- 同时读 `<bundle>.report.md`,记录导出侧声明的可信度与已标记的 `cf=1`/`rw=1` 条目。

### 阶段 1 · 归一化

```bash
python scripts/memport.py decode <bundle>.mem --out records.jsonl
```

类型码 → DSH 类型;时间 → epoch ms(`day` 精度按当日 00:00 本地时区,`unknown` 用导入时刻);`tags` → `metadata.memport`。四条时间轴分别落到 `createdAt`/`updatedAt`、`validFrom`/`validTo`、`persistence`,**合并或复用任意两条都会破坏时间定位**。

### 阶段 2 · 基线快照(去重与冲突的比对基准)

```bash
python scripts/memport.py snapshot --db ~/.dsh/memory/memory.db --out existing.jsonl
```

- 直读 `l1_records`(只读打开,不影响运行中的 DSH),得到**当前可检索的全量记忆**。这比逐条 `memory_search` 便宜且完整。
- 若 `memory.db` 被占用/损坏,脚本自动降级读 `records/*.jsonl`;此时要意识到该来源**包含已被取代的历史行**,近重复判定会更保守(可能把已删除的旧条判成冲突),需在裁决时人工留意。

### 阶段 3 · 确定性预筛

```bash
python scripts/memport.py plan --bundle <b>.mem --existing existing.jsonl \
  --out plan.jsonl --pending-out pending.jsonl --report plan-report.md
```

产出每条一个判定:

| verdict | 含义 | 是否需 LLM 裁决 |
| --- | --- | --- |
| `dup` | 内容哈希与基线完全一致 | 否,直接跳过 |
| `near-dup` | 综合相似度 ≥ 0.62,疑似同一事实的不同表述(含包内近重复) | 是 |
| `conflict-candidate` | 0.30 ≤ 相似度 < 0.62,主题相关,需判互补还是矛盾 | 是 |
| `new` | 基线中无相关内容 | 否,直接写入 |

> 相似度 = `max(3-gram Jaccard, 2-gram Dice)`。阈值用真实语料标定过:**中文改写对落在 0.49~0.51,主题相关但不同的落在 0.16~0.28**,所以取 0.62 / 0.30。宁可多判(代价是几次 LLM 判定),不可漏判(代价是冲突静默入库)。基线为空时全部为 `new`,此时至少包内近重复仍会被拦截。

### 阶段 4 · 语义裁决(由 Agent 完成)

对 `pending.jsonl` 里每条,把它与 `matched` 的现存记忆摆在一起,按 `references/conflict.md` 的矩阵判四选一,**回写 `plan.jsonl`** 的 `final_verdict` / `cf` / `rw` 三个字段:

- `dup` → 跳过(库内已有等价记忆,不改任何东西)
- `merge` → 互补:合成一条信息更完整的记录写入;旧条默认**不删**(只记 `rw=1` 与 `rewrites:[旧id]`),删旧需用户显式确认
- `supersede` → 新条时间更新且与旧条矛盾:写入新条(`rw=0`),旧条应标 `rw=1`
- `conflict` → 时间不可比或无法判定:两条并存,新条 `cf=1` 进待裁决队列

> 批量裁决时**不要一次丢给 LLM 几百条**:按 `matched` 的 id 分组,同主题的候选放一起判,一次 ≤ 20 组。

### 阶段 5 · 写入

```bash
# 通道 1(默认):生成 memory_import 调用清单
python scripts/memport.py emit --plan plan.jsonl --bundle b.mem \
  --channel tool --scene "外部导入/<来源>" --batch-size 200 --out import-calls.json
# → 按 batches[].args 逐个调用 memory_import(每个 batch 一次工具调用)

# 通道 2(兜底):生成文件物料 + 重启 DSH
python scripts/memport.py emit --plan plan.jsonl --bundle b.mem \
  --channel legacy-jsonl --out records.dsh.jsonl
python scripts/memport.py install-legacy --payload records.dsh.jsonl \
  --memory-dir ~/.dsh/memory --yes     # 会备份已存在的同名文件
```

调用 `memory_import` 时逐批核对返回值:`written` + `skipped.length` 应等于本批条数,`skipped` 里每条的 `reason` 必须记进报告(常见:`content 为空`、`与本批前面的记录内容重复`)。

### 阶段 6 · 验证与报告

```bash
# 通道 1 写完最后一批后 / 通道 2 重启后
python scripts/memport.py snapshot --db ~/.dsh/memory/memory.db --out after.jsonl
python scripts/memport.py verify --plan plan.jsonl --after after.jsonl
```

再抽 3~5 条用 `memory_search` 做语义回读(确认**可检索**,不只是"在库里"),然后向用户交付报告:

- 导入条数 / 跳过条数 / 待裁决条数
- 通道与批次(本次用了几次工具调用)
- **时间轴核对**:抽样确认 `created`(记录时间)与 `vf`(有效期起)没有互相顶替——这是最容易出错的地方
- 冲突清单:**每条冲突的两方原文 + 判定依据 + 建议动作**,请用户拍板
- 溯源:每条导入记录都能沿 `metadata.origin` 回到原始文件

## 2. 安全边界(硬性)

| 动作 | 默认 | 说明 |
| --- | --- | --- |
| 新增无冲突记忆 | 自动执行 | 可逆(可删) |
| 跳过已存在记忆 | 自动执行 | 无副作用 |
| **删除/覆盖库内已有记忆** | **禁止自动执行** | `supersede` 场景下默认只标注,删除必须逐条取得用户确认 |
| 修改用户手工写入的记忆(`scene_name='__manual__'`) | 禁止自动执行 | 用户显式写下的内容优先级最高,冲突时保留两者 |
| 写入超过 200 条 | 拒绝 | 拆批 |

## 3. 落库字段对照

导入后每条记录的形状(工具通道全字段保真):

```json
{
  "id": "mem-mf3k2a-9f2c1a",
  "content": "官方 DSH LOCALE_IDS 只有 zh/en,ja/ko 字典随包发布但无法选中",
  "type": "work_fact",
  "priority": 80,
  "scene_name": "外部导入/trae",
  "timestamps": [1788192000000],
  "createdAt": 1788192000000,
  "updatedAt": 1788192000000,
  "validFrom": 1788192000000,
  "persistence": "o",
  "version": 0,
  "family": "work",
  "metadata": {
    "hall": "work",
    "origin": "~/.trae/memories/rules.md#L2",
    "activity_start_time": "2026-09-01T00:00:00.000Z",
    "temporal": { "st": "o", "vf": "2026-09-01T00:00:00.000Z", "vt": null }
  }
}
```

**时间轴四条,各归其位**(这是本次 schema 增强的核心):

| MMF 列 | DSH 字段 | 列名 | 谁在用 |
| --- | --- | --- | --- |
| `created` | `createdAt` | `created_time` | 时效衰减、列表排序 |
| `updated` | `updatedAt` | `updated_time` | 衰减、`idx_l1_updated` |
| `vf` / `vt` | `validFrom` / `validTo` | `valid_from` / `valid_to`(`idx_l1_valid_from`) | 图谱时间锚(优先)、时间窗检索 |
| `st` | `persistence` | `persistence` | 取代判定:只有 `o` 可被闭合 |

兼容层(与列**并存**,不是替代):

| 位置 | 谁在用 |
| --- | --- |
| `metadata.temporal.{st,vf,vt}` | 不依赖列迁移的显式时间块,面板/Skill 直接读 |
| `metadata.activity_start_time/end`(ISO) | 图谱时间锚的**存量兜底**(列缺失时回落) |
| `metadata.origin` | 溯源:回到原始文件 |
| `metadata.conflict` / `metadata.rewritten` | `cf` / `rw` 标记 |

- `scene_name` 统一为 `外部导入/<来源>`:与蒸馏产出的记忆区分开,便于回溯与按需清理。
- 注意:DB 的 `l1_records` 表**没有** `source_message_ids` 列(只在 JSONL 侧车保留),溯源走 `metadata.origin`。
- 工具通道的记录 id 由插件生成(`mem-*`),**不是**确定性 id;重复导入同一条会产生重复记录。因此 `verify` 的哈希核对与 `dup` 跳过必须在导入**之前**由 `plan` 完成——这是选择工具通道的代价,也是阶段 3/4 不可跳过的原因。
