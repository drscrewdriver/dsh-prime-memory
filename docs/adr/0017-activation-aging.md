# ADR-0017: 激活老化——独立轻表、有损观测、clamp 抬升

日期: 2026-10-01
状态: 已采纳(记忆治理升级 Wave 2,T2.1-T2.5/T2.8 / O-2)
关联: ADR-0006(L1 决策凭证), ADR-0014(priority 标度), ADR-0016(分级地板)

## 背景

"高价值老记忆被时效衰减压沉"是治理目标之一。激活信号有两路(O-2 裁决):
**被动** `injectionCount`(召回注入,有损下界)与**人工** `adoptedCount`
(面板/CSV"这条有用",强信号);不做启发式自动推断(不可验证)。

## 决策

### 1. 存储落点:独立轻表 `l1_activation`(B 三层架构)

`l1_activation(record_id PK, injection_count, adopted_count, last_activated_at,
decay_anchor_at, activation_epoch)`:
- **绝不进 metadata_json**(P0-2:高频写会摧毁快照哈希校验 → cleanup-retired
  安全网静默永久失效);
- **绝不走 patchL1Metadata**(P0-3 三重陷阱:盲写整个 metadata + bump
  updated_time 会篡改衰减锚点 + FTS 副本分叉)——`bumpActivation` 是**单条
  `ON CONFLICT DO UPDATE` 原子列自增**,不碰 updated_time/metadata_json/FTS
  (测试钉死 bump 前后 hashRecords 逐字不变);
- **不进快照哈希/FTS**(异表天然排除,I-3/I-4 从根满足);
- 原子自增天然并发安全(P1-10;O-6 已核实 WAL+busy_timeout=5000)。

### 2. 写路径:内存聚合 + 节流 flush(可丢观测,不开事务)

`ActivationTracker`:内存 Map 聚合 → 30s/50 次先到批量 flush → 退出钩子兜底
(T2.2)。**不开事务**,学 recordReceipts 论证:激活计数是**可丢观测数据**,
部分写入无害;崩溃丢未刷盘增量(丢失窗口 ≤30s)与注入信号本身的三重有损
(未确认即弃/5 分钟超时降级/SESSION_CAP)同级。**绝不走 worker**(IPC 税禁令);
聚合把 N 次注入合并为 ≤1 次写(node:sqlite 同步 API,写即阻塞主循环)。

### 3. 读路径:折进 applyDecay 权重,**不加 RRF lane**(P0-9 量纲守卫)

```
decayFactor = min(1, max(floorOf(rec), 0.5^(Δ天/半衰期)) × (1 + boost))
boost       = min(0.3, log1p(inj)×0.05 + log1p(adp)×0.15)   # 常量
anchorAt    = decay_anchor_at ?? updated_at                   # '' 归一 updatedAt
```
- **clamp ≤1**(歧义①解):激活只把衰减掉的权重**恢复**到自然上限 1.0,
  绝不放大 score 标度——scoreThreshold 与 bench 对照不受污染;
- **采用 = 重置锚点**(T2.4/O-2):"这条有用"使记忆从采用时刻重新起算衰减,
  走 bumpActivation 的 anchorAt 分支 + 新事件新凭证,非 UPDATE 旧凭证;
- **存量零漂移**(P1-12):无激活行/计数 0 → boost 0(不奖不罚),锚点归一
  updatedAt——升级后存量记忆的衰减行为与升级前**逐字一致**,绝不"一夜沉底";
  `activation_epoch`(首插时刻)为未来"早于 epoch 且计数 0"豁免判定留基准;
- `missingTimestampPolicy`(静态,默认 exempt):锚点与 updatedAt 皆缺时地板
  接管(现状语义);`oldest` 为显式选沉底位,默认不启用。

### 4. injectionCount 是有损下界(P1-9,如实声明)

它系统性偏低(未确认即弃/超时降级/容量上限),故:系数只给 0.05、log1p 饱和、
boost 上限 0.3;**"未激活"判定永不单独成立**——不存在"计数 0 就惩罚"的路径。
自动推断采用须先解锁 ADR-0013 §J(bench 量化),本波不做。

## 后果

- 默认关:全部机制不创建聚合器、不写表、不读表(结构性零开销)。
- 端到端证据:tests/activation-decay.test.ts(并发无丢增/锚点不被篡改/
  clamp/存量等价/采用回升)。
