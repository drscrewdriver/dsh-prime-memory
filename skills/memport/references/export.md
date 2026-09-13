# MemPort 导出 — 把分散在各工具里的记忆整理成 `.mem` 包

在**任意** AI IDE / Agent 工具里执行(不依赖 DSH)。目标:把该工具散落的记忆整理成一个结构化、省 token、可校验的包,交给 `导入` 侧。

---

## 0. 先确认范围(不要跳过)

向用户确认三件事,没确认就不要开始写包:

1. **来源工具与项目**:只导这个项目的,还是该工具的全局记忆?
2. **时间窗**:全部,还是最近 N 天?
3. **排除项**:是否有不应外流的条目(密钥、私人信息、他人隐私)?

以下内容**永远不导出**(即使出现在记忆文件里):

- API key / token / 密码 / 私钥 / 连接串中的凭据段(占位化:`<REDACTED>`)
- 第三方个人隐私信息
- 与本机/本项目无关的闲聊

## 1. 采集:各工具的落点(已实测)

| 工具 | 路径 | 形态 | 切分单位 |
| --- | --- | --- | --- |
| Trae | `~/.trae/memories/{rules,decisions,project}.md` | Markdown | 每个 `- ` 列表项 = 1 条 |
| Trae(项目) | `~/.trae/memories/projects/<projectId>/{rules,decisions,project}.md` | 同上 | 同上;`audit.jsonl` 只做溯源,不产记忆 |
| Qoder | `~/.qoder/memories/<uid>/{global,projects/<proj>}/<category>/` | 目录即分类 | 分类下每个文件 = 1 条(或按段落切) |
| Codex | `~/.codex/AGENTS.md`、`~/.codex/rules/*.rules`、`~/.codex/memories*`、`~/.codex/memories_1.sqlite` | Markdown / sqlite | 显式规则行 = 1 条 |
| Claude Code | `~/.claude/CLAUDE.md`、项目 `CLAUDE.md`、`~/.claude/history.jsonl` | Markdown / jsonl | 列表项或小节 |
| WorkBuddy | `<project>/.workbuddy/memory/YYYY-MM-DD.md`、`~/.workbuddy/memory/*.md` | 日志式 Markdown | `## 小节` 下的 `- ` 项 = 1 条 |
| Golutra | `<project>/.golutra/agents/{history,agent-issue-log,agent-guidelines,AGENTS}.md` | 表格 / Markdown | 表格行 = 1 条 |
| 通用 | 项目内 `AGENTS.md` / `CLAUDE.md` / `.cursor/rules/*` / `.github/copilot-instructions.md` | Markdown | 规则项 = 1 条 |
| DSH(自用) | `~/.dsh/memory/records/*.jsonl`(L1)、`scenes/<family>/*.md`(L2)、`persona-<family>.md`(L3) | jsonl / Markdown | 一条 jsonl = 1 条 |

> 落点是"本机实测"的默认值;换机器先用文件搜索确认(如 `Get-ChildItem ~ -Directory -Filter .trae`),不要假设路径存在。

## 2. 抽取:把素材切成原子记忆

1. **逐文件读**,按上表"切分单位"切。
2. 每切出的一段,先问三个问题,答不上就**丢弃**:
   - 它是不是一个**可独立成立**的事实/规则/方法?
   - 脱开这份文件,还看得懂吗?
   - 三个月后它还有效吗?(一次性过程描述 → 丢弃;`ep` 仅在事件本身有长期意义时保留)
3. 合并同类项:同一结论在多处出现,只留一条,**把多处来源都写进一个 `tags.src`**(用 `,` 连接)或留最权威的一处。
4. 逐条判定类型码(`format.md` §3),厂商分类按下表映射:

| 厂商信号 | → 类型码 |
| --- | --- |
| Qoder `user_info` / `user_hobby` / `user_behavior` / `user_communication` | `pe` |
| Qoder `project_rule`、`development_*_specification`、`development_practice_specification`;Trae `rules.md` | `wm`(规范/约定);若是用户显式禁令则 `in` |
| Qoder `*_experience`(common_pitfalls / important_decision / expert / skill / mcp / tool / task_*) | `wm` |
| Qoder `project_introduction` / `project_tech_stack` / `project_*_configuration` | `wf` |
| Qoder `history_task_reference_files`、Trae `decisions.md` | `wa` / `wm` |
| Trae `project.md`、Codex `AGENTS.md`、Claude `CLAUDE.md` | `wf`(事实)/ `in`(用户规则) |
| WorkBuddy 日志小节 | `wf`(结论)/ `wm`(方法)/ `wa`(产物落点) |
| Golutra `history.md` 表格行 | `wa`(产物)/ `wt`(未完成事项) |

5. 逐条应用 `format.md` §6 的书写规范(去时间、去来源、去过程、去代词、≤100 字)。

## 3. 定时间列(四条轴,别混)

**先分清四件事**,再动手填:

| 列 | 填什么 | 不要把什么填进来 |
| --- | --- | --- |
| `created` | 这条记忆**入库**的时间。外部工具通常就是源文件的写入日/该条首次出现日 | ❌ 事件发生时间 |
| `updated` | 源侧最后一次修改该条的时间(有 git 就用 `git log -1 --format=%cI -- <file>`) | ❌ 今天 |
| `vf`/`vt` | 该事实在**真实世界**成立的时间区间 | ❌ 入库时间 |
| `st` | 持续性(见下) | — |

填法:

- 素材有明确日期 → 写日期;同日多条同一 `created`。
- 完全无时间信息 → `created`/`updated` 写 `-`,**不要用今天伪造**(伪造会污染时效衰减)。
- `vf`/`vt` 只在**能确定**时填:`vt` 留 `-` 表示"尚未结束或无时间性",不要用 `-` 表示"已结束"——已结束必须给得出具体时刻。

`st` 的判定只问一句话:**这个事实会不会随时间改变真值?**

| 信号 | st |
| --- | --- |
| 规则、偏好、身份、工具行为、架构约定、"X 的接口是 Y" | `t` |
| "目前/正在进行/待办/未解决/尚未" | `o` |
| 一次性的完成/发布/提交/会议 | `p` |
| "从…到…""期间""当时在做" | `s` |
| 拿不准 | `?`(**不要猜**;猜错会让系统错误地闭合或永久保留一条记忆) |

各来源的常见形态:

- Trae `rules.md` / Qoder `project_rule` / Codex `AGENTS.md` → 基本都是 `t`
- WorkBuddy 日志里的"已完成/重建了/提交了" → `p`(并在 `vf`/`vt` 填当天)
- WorkBuddy 日志里的"已知缺口/待补齐/目前未接线" → `o`(留空 `vt`)
- Golutra `history.md` 表格行 → `p`(日期来自表格的 Date Time 列)
- 任何"目前状态"类描述 → `o`,并在 `updated` 反映其最后变化时间

源侧明确知道某条已被后续覆盖 → `rw=1` 且 `sup:` 填取代者的 id;源侧自己标记过冲突 → `cf=1`;两者都无 → `0`。

## 4. 包内自检(关键)

写出 `.mem` 前,做三件事:

1. **去重**:对 `content` 做 NFKC + 空白折叠 + 大小写折叠后的 SHA-256,包内出现相同哈希即为失败——回上一步合并。
2. **查空/查短**:`content` 少于 4 个字符、或只有"待补充""TBD"之类占位符 → 删除该条。
3. **自查"这不是记忆"**:日志、对话原文、临时命令输出、TODO 勾选记录、纯时间流水 → 删除。

然后计算头部 `count` 与 `sha256`(所有记录行以 `\n` 连接后取 SHA-256,写前 12 位),并运行:

```bash
python scripts/memport.py validate <bundle>.mem
```

退出码 0 = 可交付;2 = 有 error,**必须修到 0 再交付**(warning 可带出,但要在报告里列明)。

## 5. 产出三件套

**写到当前工作目录的 `memport-out/` 子目录**(不存在就创建)。

⚠️ **不要写进任何工具的存储目录**(`~/.trae/`、`~/.claude/`、`~/.qoder/`、`~/.codex/`、`~/.workbuddy/`、`~/.agents/skills/`,以及工作目录下的 `.workbuddy/`、`.golutra/`、`.cursor/`)——
那些正是本步骤的**读取源**。Qoder 的落点是"目录即分类,分类下每个文件 = 1 条"、WorkBuddy 是 `<project>/.workbuddy/memory/*.md`,
包写进去会被下一轮导出当成记忆读回来,**越导越脏**;写进 skill 目录还会破坏多副本一致性。

| 文件 | 内容 |
| --- | --- |
| `memport-out/<tool>-<project>-<YYYYMMDD>.mem` | 记忆包本体 |
| `memport-out/<tool>-<project>-<YYYYMMDD>.report.md` | 导出报告:扫描范围、各来源条数、丢弃条数与原因、分类型统计、未决问题 |
| `memport-out/<tool>-<project>-<YYYYMMDD>.src.md`(可选) | 被丢弃/合并条目的原文留档,便于回溯 |

报告模板见 `templates/example.report.md`。报告不是可选项——**导入侧要靠它判断可信度**(哪些是原文照搬、哪些是二次归纳)。

## 6. 交付话术

把 `.mem` 与 `.report.md` 一起交给用户/导入侧,并明确说明:

- 来源工具与项目、时间窗;
- 条数、分类型统计;
- 导出侧已知的 `cf=1` / `rw=1` 条目清单(这些是导入侧的重点检查对象);
- 任何降级说明(比如某文件读不到、某类时间未知)。
