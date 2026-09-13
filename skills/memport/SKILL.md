---
name: memport
description: "记忆跨工具搬运(MemPort)。四个模式:导出(把本工具散落的记忆整理成结构化、省 token、可校验的 .mem 包)、总结(只出不写包的记忆体检)、校验(解析已有 .mem)、导入(并入 DSH 记忆库,含去重与冲突裁决)。当用户说「memport」「导出记忆/整理记忆/总结记忆/记忆体检/记忆迁移/合并记忆库/去重记忆/检查记忆冲突/把记忆搬过来」或提到 .mem 记忆包时使用。Use when exporting, summarizing, validating, or importing scattered agent memories (Trae/Qoder/Codex/Claude/WorkBuddy/Golutra memories, AGENTS.md, CLAUDE.md)."
version: 1.1.0
user-invocable: true
---

# MemPort — 记忆跨工具搬运

一套 Skill 四个模式:**导出**与**总结**在别的工具里跑,**校验**随时可用,**导入**在 DSH 里跑。四者共用同一个格式 `MMF v1.1`。

## 〇、模式与触发词

**一句话触发**:`memport <动词> [范围]`。看到这四个动词就直接照下表做,不需要用户再解释。

| 触发 | 做什么 | 产出 | 读哪个参考 |
| --- | --- | --- | --- |
| **导出** / 整理记忆 / 把记忆搬出来 | 读本工具**已存下**的记忆 → 抽成原子记忆 | `memport-out/*.mem` + 报告 | `export.md` |
| **总结** / 体检 | 同上,但**不写包**,只把结果给用户看 | 无文件 | `export.md` §2 |
| **校验** / 看下这个包 | 解析并校验已有 `.mem` | 校验结果 | `format.md` |
| **导入** / 并入记忆库 | 把 `.mem` 写进 DSH 记忆库 | 落库 + 冲突清单 | `import.md` |

能力判定(决定这件事能不能干):

| 当前会话能力 | 能走的路 |
| --- | --- |
| 有 `memory_search` / `memory_add` 等记忆工具(DSH) | 导入 + 导出 |
| 没有上述工具,但能读写文件(其他 IDE / Agent) | **只能导出**——导入必须调 DSH 的记忆工具 |
| 只想看/修一个已有的 `.mem` 包 | 校验 + 编辑(`validate` / `decode`) |

**范围默认值**(提示词没指定就按这个走,**不要反问**):来源 = 本工具的全局记忆 + 本工作目录相关;
时间窗 = 全部;排除 = 凭据/密钥/第三方隐私**永远排除**(占位 `<REDACTED>`)。只有用户明确要求才缩小范围。

**先读对应参考文件再动手**:

- 导出 → `references/export.md`(采集落点、切分、类型映射、产出三件套)
- 导入 → `references/import.md`(三通道选择、六阶段流程、安全边界)
- 冲突 → `references/conflict.md`(判定矩阵、裁决提示词)
- 格式 → `references/format.md`(列定义、书写规范、校验规则)
- **在别的 Agent(Trae/Codex/Claude Code 等)里发什么提示词** → `references/foreign-agent.md`

---

## 一、导出(在 Trae / Qoder / Codex / Claude / WorkBuddy 等工具里)

目标:把散落记忆整理成**一个 `.mem` 包 + 一份报告**。

### 三条铁律(先记住,再看步骤)

1. **落点**:产物只写**当前工作目录的 `memport-out/`**。禁止写进任何工具的存储目录
   (`~/.trae/`、`~/.claude/`、`~/.qoder/`、`~/.codex/`、`~/.workbuddy/`、`~/.agents/skills/`,
   以及工作目录下的 `.workbuddy/`、`.golutra/`、`.cursor/`)——那些正是导出的**读取源**,
   包写进去会被下一轮导出当记忆读回来(**自污染**),写进 skill 目录还会破坏副本一致性。
2. **不伪造时间**:源文件没有时间信息就写 `-`。用今天顶替会污染时效衰减。
3. **校验必须过**:`validate` 退出码 0 才能交付。有 error 就修到 0,不许带 error 交付。

### 步骤

1. **确认范围**:按 §〇 的默认值走;用户明确指定了才缩小。
2. **先出清单,待用户确认再抽取**:逐个探测候选源文件,列成「路径 + 形态 + 条数估计」的表格;
   探不到就写"未找到",**不要编造路径,也不要假设某个路径一定存在**。清单确认后才进入抽取。
3. **采集**:按 `references/export.md` §1 的落点表读取。
4. **抽取**:每条必须是**可独立成立的事实/规则/方法**;丢弃日志、对话原文、过程描述、TODO 流水。
5. **压缩**:按 `format.md` §6 —— 正文不写时间、不写来源、不写过程、去代词、≤100 字。
6. **定时间**:`created`/`updated` 按真实精度写;四轴与 `st` 的判定见 §四与 `export.md` §3。
7. **包内去重**:内容哈希重复即失败,回到上一步合并。
8. **校验**:`python scripts/memport.py validate <bundle>.mem` 必须退出码 0。
9. **交付**:`memport-out/` 下 `.mem` + `.report.md`(扫描范围/条数/丢弃原因/`cf=1` 与 `rw=1` 清单/
   读不到的文件与未知时间)。

只做**总结**不写包时:跳过 6~9,按 `export.md` §2 抽取后直接按类型分组列给用户,并额外回答
「哪些仍在进行 / 哪些互相矛盾 / 哪些已经过期」。

产出示例见 `templates/example.mem` 与 `templates/example.report.md`。

**最小可用包**(手工写也必须是这个形状):

```
#memport 1.1
#src=trae;project=demo;exported=2026-09-12T10:30+08:00;count=2
#cols=type|created|updated|vf|vt|st|cf|rw|tags|content
wm|2026-09-01|2026-09-01|-|-|t|0|0|hall:work;src:~/.trae/memories/rules.md#L2|命令执行优先走 WSL,能在 WSL 完成的构建/测试优先用 wsl-runner
wt|2026-09-01|2026-09-12|2026-09-01|-|o|0|0|hall:work;scope:dsh|dsh-layered-memory 补齐 EmbeddingManager 的 getEff 接线
```

也可继续用 v1 的 7 列形状(`type|created|updated|cf|rw|tags|content`),但**时间定位能力会退化**——所有条目的有效期与持续性都变成"未判定"。

## 二、导入(在 DSH 里)

**铁律:先查冲突,再落库;不静默覆盖,不伪造时间。**

1. `validate` 包(退出码非 0 立即停,把 errors 退回导出侧)。
2. `snapshot` 现存记忆基线(直读 `~/.dsh/memory/memory.db` 的 `l1_records`)。
3. `plan` 预筛:哈希精确去重 + 相似度分档(阈值经真实语料标定),产出 `plan.jsonl` / `pending.jsonl` / 报告。
4. 对 `pending.jsonl` 按 `references/conflict.md` §4 做语义裁决,回写 `final_verdict`/`cf`/`rw`。
5. `emit` 生成写入物料,按 1→2→3 选通道(见 `references/import.md` §0):
   - **1(默认)`memory_import` 工具**:一次调用批量写入,全字段保真、免重启
   - 2 兜底:落 `~/.dsh/memory/l1/records.jsonl` + **重启 DSH**
   - 3 最后:`memory_add` 逐条(仅当插件版本过旧、且无法重启)
6. `verify` 核对条数,再抽 3~5 条 `memory_search` 语义回读。
7. 交付报告:导入/跳过/待裁决条数、通道与批次、**时间轴抽样核对**、**冲突清单(两方原文+依据+建议)**、溯源。

### 硬性安全边界

- **不自动删除或覆盖任何库内既有记忆**;`supersede` 默认只标注,删除需逐条用户确认。
- **用户手工写入的记忆(`scene_name='__manual__'`)优先级最高**,冲突一律 `conflict` 交用户。
- 每批 ≤ 200 条;首次先跑 10 条试跑。
- 永远不要直写 `~/.dsh/memory/records/*.jsonl`(该目录只写不读,重建时会被整体归档丢弃)。

## 三、脚本

```bash
python scripts/memport.py validate   <bundle.mem>
python scripts/memport.py decode     <bundle.mem> [--out records.jsonl]
python scripts/memport.py snapshot   [--db ~/.dsh/memory/memory.db] --out existing.jsonl
python scripts/memport.py plan       --bundle b.mem --existing existing.jsonl \
                                     --out plan.jsonl --pending-out pending.jsonl --report r.md
python scripts/memport.py emit       --plan plan.jsonl --bundle b.mem \
                                     --channel tool|legacy-jsonl [--scene "外部导入/<来源>"] --out out
python scripts/memport.py install-legacy --payload out --memory-dir ~/.dsh/memory --yes   # 仅通道 2
python scripts/memport.py verify     --plan plan.jsonl --after after.jsonl
```

仅依赖 Python 3.9+ 标准库;Windows / macOS / Linux 通用;文件一律 UTF-8。
脚本不可用时(目标工具没有 Python),**按 `format.md` 手工产出包**同样有效——格式是自描述的,不依赖工具。

## 四、字段速查

记录行:`type|created|updated|vf|vt|st|cf|rw|tags|content`(MMF v1.1;v1 包缺 `vf`/`vt`/`st` 列,按 `-`/`-`/`?` 补齐,仍可解析)

- `type`:`pe` persona · `ep` episodic · `in` instruction · `wf` work_fact · `wt` work_task · `wm` work_method · `wa` work_artifact
- 四条时间轴,互不替代:
  - `created`:记录时间——该记忆**入库**的时刻
  - `updated`:变更时间——最后一次被补充/改写的时刻
  - `vf`/`vt`:**有效期**起止——该事实在**真实世界**成立的时间区间(`-` = 未知;`vt` 为 `-` = 尚未结束或无时间性)
  - `st`:**持续性**——`p` 时点事件 · `s` 已结束区间 · `o` 仍在持续 · `t` 无时间性 · `?` 未判定
- `cf`:是否冲突(`0`/`1`/`?`) · `rw`:是否被改写(`0`/`1`/`?`)
- `tags`:`k:v` 以 `;` 分隔(`hall` / `src` / `id` / `ver` / `prio` / `scope` / `key` / `sup`)
- `content`:单行,换行写 `\n`,反斜杠写 `\\`

**最容易犯的错**:把事件发生时间写进 `created`。"2026-03 在 A 项目"这条事实,`created` 是它入库的时间,`2026-03` 是 `vf`。

`st` 只问一件事:**这个事实会不会随时间改变真值?** 会变且现在成立 → `o`;曾经成立、已经结束 → `s`/`p`;不会变 → `t`。

## 五、落库去向(DSH 侧)

**写入一律走插件的工具**(`memory_import` 批量 / `memory_add` 单条)——工具负责落盘、建索引、算嵌入与写事实源;绕过它直接动文件或数据库会破坏这些保证。

| MMF 列 | 落库位置 |
| --- | --- |
| `created` / `updated` | `createdAt`/`updatedAt`(列 `created_time`/`updated_time`) |
| `vf` / `vt` | `validFrom`/`validTo`(列 `valid_from`/`valid_to`,有索引);同时写 `metadata.temporal` 与 `metadata.activity_*` |
| `st` | `persistence` 列;同时写 `metadata.temporal.st` |
| `cf` / `rw` | `metadata.conflict` / `metadata.rewritten`(`memory_import` 的 `conflict`/`rewritten` 入参) |
| `tags.src` | `metadata.origin`(`memory_import` 的 `origin` 入参) |

`metadata.temporal` 与 `metadata.activity_*` 是**兼容层**:列缺失(旧库)时时间锚回落到它们,列存在时以列为准。
