# ADR-0016: 分级地板——flat 保 0.5 基线,graded 为可选观察路径

日期: 2026-10-01
状态: 已采纳(记忆治理升级 Wave 2,T2.6/T2.7 / O-1)
关联: ADR-0014(priority 标度), #29 时效衰减(原始决策)

## 背景

`DECAY_FLOOR=0.5` 的原始决策(search-utils.ts)是"内部常量不进配置——它是安全
机制不是调参旋钮",并被 `tests/memory-db.test.ts` 钉死。地板 0.5 下衰减最多腰斩,
只在"相关度相近的候选之间轮转名次",半衰期不敏感——这是 95.2% bench 基线的
定义域(P0-8:C3 证明该基线是衰减开启态测得,bench 原结构无法重校准)。

用户裁决(O-1):分级地板**实现到 0.2 档但默认关**——低价值记忆(priority<50)
允许衰减沉到 0.2,开启即观察态,由 bench flat 对照臂量化其召回损失。

## 决策

1. **flat 档(默认)逐字保现状**:`DECAY_FLOOR=0.5` 常量不动、钉死测试不改;
   `recall.decayFloorByType=false`(布尔,`Schema.boolean()`)时 `floorOf ≡ 0.5`,
   衰减公式与升级前逐字等价(I-6/I-10)。
2. **graded 档(显式开启)**:`floorOf(rec)` 按 normalizePriority 收敛后的
   `rec.priority` 分档(O-9,不猜原始值),档位表(spec §二):
   - `instruction` 且 `priority=-1`(死命令哨兵,**先于 <50** 判定)→ **0.9**
   - `priority<50`(任何类型)→ **0.2**(用户裁决的观察档,突破 0.5 下界)
   - `instruction`(其余)→ 0.9;`persona`≥80 → 0.9,其余 0.5
   - `work_fact`/`work_method` → 0.5;`work_task`/`work_artifact`/`episodic` → 0.3
   - 未登记类型 → 兜底 0.5(fail-open)
   (代码库无 `safety` 类型——评审纠正的幻影类型,档位以实际类型为准。)
3. **本 ADR 显式修订原始决策的"不进配置"**:修订面仅限 graded 布尔开关;
   flat 的 0.5 常量仍然不进配置、不被改写。
4. graded 开启 = **观察态**:行为悬崖(低相关新鲜记录压过高相关陈旧记录)是
   O-1 已知代价;量化手段=bench `patch-arm-flat.yml` 对照臂 + 召回集差分
   (`retrieval-metrics.mjs --diff`)。真沉底(彻底退出召回)不归地板管——
   交由 W3 tier='wiki' 降权 / retire 退场。

## 后果

- 既有部署零漂移(默认关)。
- `expect(DECAY_FLOOR).toBe(0.5)` 钉死测试保持有效(它钉的是 flat 常量)。
- 开启后 bench flat 对照臂的差分即"分级地板的召回代价"证据,回填本 ADR 的
  观察记录。
