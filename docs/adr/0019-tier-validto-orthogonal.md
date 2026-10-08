# ADR-0019: tier 与 validTo 正交——无 archived tier,退场只由 validTo 表示

日期: 2026-10-01
状态: 已采纳(记忆治理升级 Wave 3,T3.9/T3.12/T3.15 / O-7,修订计划 v2 Issue 5)
关联: ADR-0007(图谱可重建性,本文增补其条 2), ADR-0015(repo 围栏术语表)

## 背景

初版设计 tier='archived' 复用 retire(),但那让"治理归属"与"退场事实"成为
同一状态的两份表示,且 promote-to-active 只 setTier 不清 validTo 会让记录
回不到召回面(计划评审 Issue 5)。

## 决策

1. **tier ∈ {active, wiki},没有 archived 值**:
   - `active`(默认):正常参与召回;
   - `wiki`:检索面降权(WIKI_MULT=0.05)但**保留 FTS/向量索引**,
     `memory_search includeWiki` 显式可查;不闭合 validTo,不被
     cleanup-retired 选中(复核判据同时检查 tier,数据不丢)。
2. **退场只由 validTo 表示**(复用 retire()/records-restore(),不引入第二份状态):
   - retire **不改 tier**;restore **不改 tier**;setTier **不改 validTo**
     (三向正交性测试钉死,tests/governance-service.test.ts);
   - verdict 路由:retire→retire();restore→restore();demote-to-wiki→
     setTier('wiki')+入队 L2 重聚类;promote-to-active→**仅对未退场记录**
     (已退场 no-op+提示改用 restore)。
3. **tier 是治理归属非事实**(ADR-0007 条 2 增补):重建(rebuild)按
   record_id/contentHash 对账时**保留 tier 而非从 L0 重算**——被降级记录不得
   以 active 态复活;行随 JSONL/DB 往返自然携带 tier 列。
4. tier 列 DEFAULT 'active'(缺列/非法读回 active,fail-open,I-23);不进
   快照哈希、不进 FTS(I-3/I-4)。

## 后果

- 无双表示、无状态机断裂;cleanup-retired 对 wiki 的物理删除被结构性排除。
- wiki 的"近乎退出召回"(×0.05,与域门禁叠乘后更低)是刻意降级,不属于
  软下界保护范围(ADR-0017 的 SOFT_FLOOR 只护软因子)。
