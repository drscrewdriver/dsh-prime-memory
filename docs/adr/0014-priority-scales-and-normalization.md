# ADR-0014: priority 三套标度并存与单一收敛点

日期: 2026-10-01
状态: 已采纳(记忆治理升级 Wave 0, T0.7 / O-9)
关联: ADR-0006(L1 决策凭证), ADR-0008(scope×family 四象限)

## 背景

仓库现存三套 priority 默认标度,且**解析语义各不相同**:

| 调用点 | 默认 | 既有解析语义 |
|---|---|---|
| SQLite `l1_records.priority` DDL 列默认 + 读回兜底(sqlite.ts / graph-store.ts) | **50** | `Number(r.priority ?? 50)` —— 仅 nullish 回落,0/NaN 透传 |
| 抽取管线未打分兜底(pipeline/l1.ts `toStoreRecord` / merge 分支) | **60** | `Number(m.priority) \|\| 60` —— 0/NaN/缺失一律回落 |
| 导入/工具缺省(tools/index.ts memory_add / memport) | **80** | `isFinite && >=0 ? min(100) : 80` —— 非有限或负数回落并 clamp [0,100] |

## 决策

1. **本波不统一三套标度**。统一默认值会改写存量数据的落库语义(破坏零漂移),
   统一解析语义会在至少一处产生行为漂移;三套标度各自服务不同入口
   (存储中性 / 抽取"未打分=中下" / 导入"显式动作=高置信"),语义差异是历史
   契约而非缺陷。
2. 引入 **`src/store/priority.ts` 单一收敛点**,三个具名函数逐字复刻三种语义:
   - `normalizePriority(raw, type, fallback=60)` —— 管线语义(`Number \|\| fb`),
     0 值回落是现状;**写入门(l1-gate)在强转之前判原始值**,不受此回落掩盖;
   - `normalizeStoredPriority(raw, fallback=50)` —— 存储语义(`Number(raw ?? fb)`),
     0 与 NaN 原样透传(读回 fail-open);
   - `normalizeImportPriority(raw, fallback=80)` —— 导入语义(有限非负 clamp 100)。
   全部调用点禁止散落裸写数字默认;`-1` 死命令哨兵提升为具名常量
   `PRIORITY_ABSOLUTE_INSTRUCTION`。
3. **判定轴约定(O-9)**:写入门只作用抽取入口、判原始值;召回侧按 priority 的
   判定(Wave 2 分级地板 floorOf)一律读**收敛后落库**的 `rec.priority`,不重复
   猜测原始值。`type` 参数是判定轴扩展位,解析本身不按 type 分支。

## 后果

- 三处调用点行为**逐字不变**(等价性由既有测试与新增 priority 单测共同钉住)。
- 后续若要统一标度,只动本文件 + 新 ADR;改动面从"散落全库"收敛为"一处"。
- 写入门阈值表(Wave 1)与 floorOf 档位表(Wave 2)都以本模块的常量为基准,
  不再各自硬编码。
