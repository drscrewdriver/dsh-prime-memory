# ADR-0020: Room 注册表与分类管理

日期: 2026-10-01
状态: 已采纳(beta.4 零漂移面 / beta.5 破坏性面分船)
关联: ADR-0009(工作区标识), ADR-0015(repo 软围栏), 治理波 W3(T3.10-T3.11)

## 背景

Room 由 metadata.tags 自生长,tags 标注器刻意不喂词表(wing-backfill.ts「标签从
内容中涌现」)——结果:81 个 Room 大多 1 条,碎片化;且无任何管理面(合并/改名/
导出都没有)。

## 决策

### 1. 注册表 = sidecar 文件,不动 tags 事实源
`rooms-registry.json`(slug/label/description/source/aliases/status,上限 200)。
损坏/不可读 → 只读降级**回退纯自生长目录**(occupancy 读侧分类),绝不阻塞
rooms-get/标注器。tags 权威仍在 l1_records.metadata。

### 2. rooms-get 端点层合并
listRooms()(纯 tags 聚合)∪ 注册表 active 条目(count=0、带 source/label)。
不动 listRooms 的 30s 缓存语义;客户端可选读新字段,零断裂。retired 条目照常
出现在 registry 字段并标示(不隐藏——与 list({tag}) 口径一致)。

### 3. 标注器优先注册表(beta.5)
roomCandidateChunk / tagChunk 的词表换成「注册表条目排前的合并目录」(封顶 120,
附 description);tagChunk 措辞从「不从预定义列表选」改为「优先注册 Room,确无
合适再新建 ≤2」。这是治碎片化的根因一刀(beta.5,与破坏性面同船)。

### 4. merge/rename(破坏性面,beta.5)
游标 200/页重写 tags(写前重读-合并-写回,保全 roomCandidates/roomReview/hall/
cogHall/sourceAnchors);重写面=全部匹配行**含退场**(口径最简);dryRun 默认
true 返回 affected 预览;执行前快照;与 ruminate/wing-backfill 单飞互斥(relabel
整值替换 meta.tags,并发会回潮旧 slug);完成后 invalidateRooms + 注册表
markMerged/renameSlug + recluster 入队(source='room-merge')。

### 5. FTS 与快照声明
- tags 权威在 l1_records:patchL1Metadata 不同步 l1_fts.metadata_json(检索命中
  不读该列;rebuildFts 全量回灌自愈)——刻意不同步,非遗漏。
- canonicalRecords 快照哈希含 metadata → merge 改 tags 会使**旧快照**的哈希与
  当前库不一致(设计使然:快照是时点切片);cleanup-retired 的 verify 对象是
  毫秒前刚拍的快照,不受影响。**快照恢复 = 回到快照时点的分类**(时间旅行由
  restore 语义声明)。
- 孤儿候选/复查键(roomCandidates/roomReview)同属 metadata,同上。

### 6. 权限分层
list/export 无门(本机 loopback;records 类导出 limit 1 万/上限 5 万);
register/retire 吃 memoryMutate 单门;merge/rename 双保险(memoryMutate +
dryRun 默认 true)。register 上限 200 + isTag + 查重含 aliases 防刷。
