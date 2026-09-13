# skills/ — 随仓库保存的 Skill 副本

本目录存放与 `dsh-prime-memory` 配套的 **MemPort** Skill 副本:把其他 AI 工具/IDE 里分散的
记忆整理成 `.mem` 包(导出),再并入本插件的记忆库(导入,含去重与冲突裁决)。

四个模式:**导出**(写包)/ **总结**(只出不写包)/ **校验**(解析已有包)/ **导入**(落库)。
触发方式是一句话:`memport 导出`、`memport 总结`……其余规则全在 `SKILL.md`,提示词只带范围。

## 副本关系(改之前先看这里)

| 角色 | 位置 |
| --- | --- |
| **权威源(唯一可改的地方)** | 工作区 `E:\test\rewrite-agently\memport\` |
| 随仓库副本(本目录) | `skills/memport/` |
| 运行时安装位置(DSH/其他 agent 实际加载) | `~/.agents/skills/memport/` |

本目录是**副本,不是源**。三处内容必须一致,不一致时以工作区源为准。

## 同步

```powershell
$src = "E:\test\rewrite-agently\memport"
$dst = "E:\test\rewrite-agently\mine-dsh-plugins\dsh-prime-memory\skills\memport"
Copy-Item "$src\SKILL.md" $dst -Force
Copy-Item "$src\references\*.md" "$dst\references" -Force
Copy-Item "$src\scripts\memport.py" "$dst\scripts" -Force
Copy-Item "$src\templates\*" "$dst\templates" -Force
```

同步后校验包格式与脚本可跑:

```powershell
python skills\memport\scripts\memport.py validate skills\memport\templates\example.mem
```

## 与插件的关系

Skill 的**写入一律走插件的工具**,不直接动文件或 SQLite——工具负责落盘、建索引、算嵌入与写事实源:

- `memory_import`(批量,单次上限 200 条)/ `memory_add`(单条),均需 `memoryMutate: true`。
- `.mem` 的时间列落到插件的 `l1_records`:

| `.mem` 列 | 记录字段 | 列名 |
| --- | --- | --- |
| `created` / `updated` | `createdAt` / `updatedAt` | `created_time` / `updated_time` |
| `vf` / `vt` | `validFrom` / `validTo` | `valid_from` / `valid_to`(索引 `idx_l1_valid_from`) |
| `st` | `persistence`(`p`/`s`/`o`/`t`/`?`) | `persistence` |
| `cf` / `rw` | `metadata.conflict` / `metadata.rewritten` | —(metadata) |
| `tags.src` | `metadata.origin` | —(metadata) |

`metadata.temporal` 与 `metadata.activity_*` 是兼容层:库未经列迁移时时间锚回落到它们。

## 用的时候的两个要点

- **导出产物的落点**:统一写到当前工作目录的 `memport-out/`。**不要写进工具的存储目录**
  (`~/.trae/`、`~/.claude/`、`~/.qoder/`、`~/.codex/`、`~/.workbuddy/`、`~/.agents/skills/`,
  以及工作目录下的 `.workbuddy/`、`.golutra/`、`.cursor/`)——那些正是导出的**读取源**,包写进去会被
  下一轮导出当成记忆读回来(自污染),写进 skill 目录还会破坏前面那份三处一致性。`.mem` 是产物不是记忆。
- **在别的 Agent 里怎么发提示词**:见 `references/foreign-agent.md`(完整导出提示词 / 只做总结不写包的
  "记忆体检"提示词 / 无 Python 的降级自包含版)。

## 发布边界

`package.json` 的 `files` 白名单**不含 `skills/`**,故本目录随仓库分发、**不随 npm 包发布**——
与既有的 `design/`、`docs/`、`bench/` 同例。`npm run smoke` 只做单向核验(白名单列出的项必须存在),
新增本目录不会影响它。

## 注意

- 副本漂移是真实风险:改完工作区源后**必须**同步本目录与安装位置,否则三处行为不一致。
- `scripts/__pycache__/` 属运行期产物,不要提交。
