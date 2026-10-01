# ADR-0015: repo 软围栏与 scope 术语表

日期: 2026-10-01
状态: 已采纳(记忆治理升级 Wave 1,T1.7-T1.11 / O-3)
关联: ADR-0008(scope×family 四象限), ADR-0009(工作区标识三铁律), ADR-0014(priority 标度)

## 背景

跨 repo 污染是治理升级的目标之一:项目 A 的对话里,项目 B 的专属配置/路径/约定
不该被召回注入。但"repo"这个概念在仓库里已有多个近亲,且 repo 身份识别极易
违反 ADR-0009 的纯字符串纪律(P0-6)。

## 决策

### 1. repo 身份:basename(归一 cwd),纯字符串

`repoKey = basename(normalizeWorkspacePath(cwd))`(`src/repo-scope.ts::resolveRepoScope`):
- 与 workspaceId **同一归一入口**(ADR-0009 单一入口纪律),纯字符串/同步/不碰
  fs/不抛/无 I/O;
- 识别失败(无 cwd/空串)→ `''` = **不围栏**(fail-open,宁可漏围栏不可阻断写入);
- **不用 git**(P0-6:git remote 是子进程+async+抛,正面违反 ADR-0009,且属 P2
  未解锁项)。同名不同仓的两 clone 共享 repoKey 是已知代价,由 `repo_key_owner`
  人工标注消歧(首版仅人工写)。

### 2. scope 术语表(四义钉死,P1-4)

| 术语 | 载体 | 语义 | 取值 |
|---|---|---|---|
| **MemoryRecord.scope** | `l1_records.scope` 列 | **可见范围**(工作区轴):对哪些工作区可见 | `global` / `workspace`(配 `workspace_id`) |
| **metadata.scope** | `metadata_json.scope` | 内容语义标签(work_method 的项目/团队/模块维度),**与归属无关** | `project` / `team` / `module` 等 |
| **repoKey** | `l1_records.repo_key_name` 列 | **repo 归属**(治理轴):记录产自哪个 repo | basename 字符串 / `''`=未归属 |
| **applicability** | `l1_records.applicability` 列 | **适用范围声明**(治理轴):知识本身是否绑定单 repo | `this-repo` / `cross-project` / `''`=未声明 |

CSV/MMF 导出侧不得使用裸词 `scope` 作表头/键名(计划 P1-4),MMF 走 `tags.repo`
子键(W3,T3.14)。

### 3. 软围栏语义(P0-7:绝不塌缩四象限)

- repo 围栏**只作用于 work 族召回面**(chat 族是个人记忆,本就跨项目);
- `applicability='cross-project'` **绝不围栏**——跨项目 SOP/编码规范被单 repo
  限死与"减污染非取消复用"的目标相反;
- repo 不匹配 → 乘 `crossRepoMultiplier`(默认 0.2,**软减权非硬排除**,照
  `WING_GATE_WEIGHT_FLOOR=0.4` 范式;与域门禁叠乘 ≥0.08);
- 实现为召回出口纯函数 `applyGovernanceWeights`(**严禁进 MemoryDb/searchCandidates**,
  P0-1/I-1;score 字段不改写,照 sortByDomainWeight 只换序范式);
- **效果边界如实声明(P1-2)**:召回层软减权只能重排已召回的 top-K,救不回被
  挤出 top-K 的同 repo 记忆;检索层下沉排到 bench 改造(已完成,T0.3-T0.5)之后另议。

### 4. 归属写入时机(I-21/P1-14)

repo_key/applicability 在抽取管线 `toStoreRecord` **之前一次算定**(T1.9),
写 store 行 + JSONL 事实源;**绝不事后回填**——存量 `repo_key=''`(不围栏,
合 ADR-0008"存量归 global 不搬不删")。applicability 由抽取 prompt 显式产出,
**绝不从 family 推导**;未声明/非法 → `''`(宁可漏围栏不可误围栏)。

## 后果

- 既有部署默认零漂移(`recall.scopeFence.enabled=false` → 治理函数不被调用)。
- `deleteL1Batch` 单一调用方不受影响(围栏只减权,从不删行)。
- 召回集差分指标(bench `--diff`)可量化围栏的召回代价(观察态判据)。
