# unified/15rc 参考件索引

> 分支基线：main @ 0cc3475（0.21.0）。行号锚点=main；参考件行号见各条目。
> 铁律：参考件**按 task 取实现移植**，不整支 merge（各线裁剪面不同，整支 merge 会带入 0.2.0-only 删除面）。

| 参考分支 | 参考什么 | 用在哪个 task |
|---|---|---|
| compat/0.1.7 @ 1ed1163（含 wip 快照） | settings 代际回退实现（0.1.5 settingsScope 臂）；9-peer 多段 `\|\|` 枚举模板；src 行号=审计 v2 旧锚（settings.ts :134/:171/:179、stats.ts :329） | task_1（peers 模板）、task_5（settings 三代腰） |
| compat/0.1.7 @ 84fe871 | agent/session-start 并入 agent/created + 去重重置修复（改 capture.ts/recall.ts） | task_0.6 等效性对照、task_7 |
| compat/0.1.5 @ b7cffdb | 0.1.5 特有裁剪面（0.16.3） | task_5 老臂核对 |
| backport/012-memorax-absorb @ 560a071 | 0.1.2 线面（0.12.5） | task_4/7 老格核对 |
| port/015-hallroom @ 698ae92、port/02-hallroom @ fb40af1 | hallroom 在 0.1.5/0.1.7 线的移植形态（hallroom 功能若在 main 已重构，老线形态仅作行为参考） | task_8（席位/槽行为） |
| wip 快照 1ed1163（本轮不并入） | governance-service / activation / priority / recluster / l1-gate / repo-scope + ADR 0014-0019 | 后续移植批（不在本计划） |

## 宿主 rc 全集（peers 枚举目标，task_0.5 实查校准）
0.1.0-rc.2 ~ rc.8、0.1.1-rc.1/rc.2、0.1.2-rc.1、0.1.5-rc.1/rc.2/rc.3、0.1.7-rc.1/rc.2、0.2.0-rc.1/rc.2

## farm 六格（验收面）
0.1.0-rc.8@3081 / 0.1.1-rc.2@3082 / 0.1.2-rc.1@3083 / 0.1.5-rc.3@3085 / 0.1.7-rc.2@3087 / 0.2.0-rc.2@3090(desktop)
