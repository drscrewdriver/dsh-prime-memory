# 在别的 Agent 里用 —— 提示词集

给 **Trae / Codex / Claude Code / Qoder / Cursor / WorkBuddy 等工具**用的现成提示词。

## 0. 原则:提示词只放 skill 不知道的东西

**短提示词成立的前提是 skill 里写清了"怎么做"。** 提示词里只该出现三类信息:

1. **触发词**(`memport 导出` 等)——告诉它去读哪个 skill;
2. **范围**(来源/时间窗/排除)——skill 猜不到你的意图;
3. **输出目录偏好**(可选)——不改就用默认的 `memport-out/`。

其余一律**不写进提示词**。反过来说:**如果你发现必须把某条约束写进提示词才能让它照做,
说明那条约束在 `SKILL.md` 里缺失或不够显眼——去补 `SKILL.md`,不要加长提示词。**
(本文 §5 就是这条原则的核对表。)

**唯一的例外是 §3**:对方**没有安装 skill** 时,没有地方承载知识,格式必须内联进提示词——那一份长是对的。

## 1. 先搞清楚边界

| 方向 | 能在哪跑 | 为什么 |
| --- | --- | --- |
| **导出 / 总结**(记忆 → 结构化) | **任何有文件读写能力的 Agent** | 只读源文件,不依赖宿主 |
| **导入**(结构化 → 记忆库) | **只在 DSH 侧** | 必须调用插件的 `memory_import`/`memory_add`;其他工具没有这套工具 |

## 2. 提示词(就这么短)

```
memport 导出
```

```
memport 总结
```

```
memport 校验 memport-out/trae-demo-20260912.mem
```

```
memport 导入 memport-out/trae-demo-20260912.mem      # 只在 DSH 里
```

四种模式的语义、默认范围、产出落点,全在 `SKILL.md` §〇 与 §一。**不需要在提示词里重复**。

### 需要收窄范围时,追加一句就够

```
memport 导出 —— 只要本项目的,最近 90 天,别导 .env 里那些
```

```
memport 导出 —— 输出到 .memport/ 而不是 memport-out/
```

```
memport 总结 —— 只列"目前仍在进行"和"已经过期"的
```

### 如果这个工具不会自动发现 skill

把它指到 skill 位置即可,仍然是一行:

```
读 ~/.agents/skills/memport/SKILL.md,然后执行:导出
```

## 3. 对方没装 skill 时的兜底(这份必须长)

没有 skill 就没有地方放格式,只能内联。用这段:

```
把你存下的记忆整理成一个纯文本记忆包,严格按下面的行格式。

第 1 行:  #memport 1.1
第 2 行:  #src=<工具名>;project=<项目名>;exported=<YYYY-MM-DDTHH:mm+08:00>;count=<条数>;sha256=<12位>
第 3 行:  #cols=type|created|updated|vf|vt|st|cf|rw|tags|content
之后每行: 固定 10 列,顺序不能变
          type|created|updated|vf|vt|st|cf|rw|tags|content

字段取值:
- type:pe 画像 / ep 事件 / in 规则 / wf 事实 / wt 待办 / wm 方法 / wa 产物
- created / updated:YYYY-MM-DD;不知道写 `-`(不要用今天顶替)
- vf / vt:事实在真实世界成立的时间区间;`-` 表示尚未结束或无时间性
- st:p 时点 / s 已结束的区间 / o 仍在持续 / t 无时间性 / ? 拿不准
- cf / rw:0 或 1(是否冲突 / 是否已被后续取代)
- tags:key:value,多条用 `;` 连接,至少要有 src:<文件#行号>
- content:一句话、≤100 字、可独立成立的事实或规则

sha256:所有记录行以 \n 连接后取 SHA-256,写前 12 位十六进制。
内容要求:丢弃日志流水、对话原文、命令输出、过程描述;同一结论只留一条。
保存:写到当前工作目录的 memport-out/ 下(不存在就创建),文件名 <工具名>-<项目名>-<YYYYMMDD>.mem。
不要写进任何工具的存储目录(~/.trae/ ~/.claude/ ~/.qoder/ ~/.codex/ ~/.workbuddy/ ~/.agents/skills/
以及工作目录下的 .workbuddy/ .golutra/ .cursor/)——那是读取源,写进去会自污染。
```

算 sha256 的一行命令(本机实测:对 `templates/example.mem` 输出 `af1247329ce5`,与头部声明一致):

```powershell
$lines = (Get-Content pack.mem -Encoding UTF8)[3..((Get-Content pack.mem).Count-1)]
$sha = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash(
  [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n")))).Replace('-','').ToLower()
$sha.Substring(0,12)
```

## 4. 按需追加的一两句(仅在对应场景)

| 场景 | 追加这一句 |
| --- | --- |
| 只要某个项目 | `只要 <项目名> 的,全局记忆不要` |
| 只要近期 | `时间窗:最近 N 天`(按源文件写入日算) |
| 有不该外流的文件 | `排除 <路径>,里面的凭据一律不导` |
| 只要看一下不落盘 | 用 `总结` 模式 |
| 想换输出目录 | `输出到 <目录>/` |

## 5. 核对表:那些约束现在住在哪

我最初把这些写进了提示词(太长了,是错的)。现在它们都在 skill 里:

| 约束 | 位置 |
| --- | --- |
| 探不到的源路径写"未找到",不许编造 | `SKILL.md` §一 步骤 2 |
| 先出候选清单、等确认再抽取 | `SKILL.md` §一 步骤 2 |
| 四轴时间不可互相顶替 | `SKILL.md` §四 + `format.md` §4 + `export.md` §3 |
| 禁止用今天伪造 `created` | `SKILL.md` §一 铁律 2 + `export.md` §3 |
| `st` 五值判定与"拿不准写 `?`" | `SKILL.md` §四 + `export.md` §3 |
| 落点 `memport-out/`、禁写工具存储目录 | `SKILL.md` §一 铁律 1 + `export.md` §5 |
| 包内去重(内容哈希) | `SKILL.md` §一 步骤 7 + `export.md` §4 |
| `validate` 必须退出码 0 | `SKILL.md` §一 铁律 3 + `export.md` §4 |
| 报告必须写清扫描范围/丢弃原因/未知项 | `SKILL.md` §一 步骤 9 + `templates/example.report.md` |
| 什么样的条目要丢弃 | `export.md` §2 |
| 厂商分类 → 类型码映射 | `export.md` §2 |
| 正文压缩规范(≤100 字/去代词/去过程) | `format.md` §6 |

## 6. 拿到包之后(DSH 侧)

```bash
python scripts/memport.py validate <bundle>.mem          # 先复验,别信对方自报
python scripts/memport.py snapshot --out existing.jsonl
python scripts/memport.py plan --bundle <bundle>.mem --existing existing.jsonl --out plan.jsonl
# 冲突逐条给用户拍板 → emit --channel tool → 逐个 memory_import
```

导入侧**必须自己再跑一次 `validate`**:对方的"校验通过"不是证据。
