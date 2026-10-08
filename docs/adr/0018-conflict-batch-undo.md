# ADR-0018: 批量裁决 resolution='batch' 可撤销,终局动词不可撤销

日期: 2026-10-01
状态: 已采纳(记忆治理升级 Wave 3,T3.5-T3.8/T3.15 / O-4 / P0-11)
关联: ADR-0010(冲突冻结默认关与超时,条 6 审计可辨认 / 条 8 一次性裁决)

## 背景

CSV 批量裁决(P0-11)打破了 ADR-0010 条 8 的"二次裁决不覆盖"字面:批量是**粗筛**,
人会看错;若 batch 与终局动词同样不可逆,误批的损失不可回收。

## 决策

1. **独立词表值 `resolution='batch'`**,绝不复用 auto/winner/loser/both——
   审计必须一眼辨认"这行是人批量拍的板"(条 6 同源)。词表同步点:
   ConflictResolution 类型 + conflict-service 渲染 + schema 测试(精确列集合)。
2. **batch 可撤销**:`conflict-batch-undo`(显式端点,非静默)——
   - 只对 `resolution='batch'` 的行生效(终局动词不可撤销);
   - 清 resolved_at/resolution(**写回空哨兵,不 DELETE 行**),batch_id 留在行上
     ——"这批曾被裁决过"审计可见(留痕不静默清列);
   - 恢复败方回召回面(restore 补向量)。
3. **终局动词(winner/loser/both/auto)不可撤销**不变——它们是人对单条的终局
   判断;反悔走 records-restore 恢复记录,而非重开裁决。
4. **乐观并发逐行校验**(T3.7):created_at/resolved_at 快照不符 → 该行
   skippedStale,不整批作废;defer_count≥DEFER_MAX 的钉子户**硬排除**批量外
   (T3.8,它们只能人工单条收口);超限**显式回报 truncated**(P1-6)。
5. **破坏性动作纪律**(I-14):干跑默认(省略 dryRun=零写,变异探针测试)、
   执行前落快照(requireSnapshot 常量 true,失败拒绝执行)、高影响项
   (instruction/persona≥80)二次确认。

## 后果

- "二次裁决不覆盖"不变量的修订面 = 仅 batch 值;其余路径逐字不变。
- 撤销是显式动作且有留痕,误用可追溯。
