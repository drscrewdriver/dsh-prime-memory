# 3D 记忆海「闪一下变暗」修复记录（0.26.33-local.5）

> 一句话根因：**不是掉帧**。给 `canvas.width` 赋值这个动作本身会清空整张位图（规范行为），
> 而 `ResizeObserver` 回调落在渲染步骤的 **layout 之后、paint 之前**——此刻清空、本帧就 paint，
> 擦白的那一帧必然上屏，下一 rAF 才补画回来。观感即「闪一下变暗」，且只在外部尺寸事件触发时出现，与单帧耗时无关。

## 一、取证方法（多模态观察不可信，改像素级实测）

前三轮视觉模型抽帧描述互相矛盾（有说 t=7s 黑屏、有说全片无黑屏），全部作废。
改用 `ffmpeg signalstats` 拉全片客观统计：

```bash
ffmpeg -i <rec> -vf "signalstats,metadata=print:file=signalstats.txt" -f null NUL
```

| 证据 | 数值 | 判读 |
|---|---|---|
| 全片 324 帧（30fps/10.8s）YAVG | 只有两个离散值 `49.20` / `40.46` | 不是渐进掉元素，是两种状态切换 |
| 22 张暗帧参数 | **完全同参**（YAVG=40.46 / SATAVG=7.29 / SATMAX=75） | 同一张图反复出现 = 同一张擦白帧 |
| 暗帧下画布三区亮度 | 黄簇/青簇/空白区全塌到同一纯色 `≈22`，饱和 `≈4` | 元素不是"缺一层"，是**整张位图透明**露出 CSS 底色 |
| CSS 底色核算 | `#04070f` limited-range luma ≈ 6.99 ↔ 实测 Y=22（≈全范围 7） | 对上：看到的是 canvas 自己的背景色透出来 |
| 同帧左侧栏/顶部图例条 | `-0.2%` / **像素零差异** | 排除窗体重排、resize 抖动、合成器/GPU/掉驱动 |

关键推理链：**"只丢前景不丢背景"若成立应是分层不同步；实测是连背景星点一起塌成纯色 → 位图被清空**，
与"RO 回调里 `canvas.width=` 擦白 → 本帧 paint"完全吻合。context lost 也被否掉——那会永久黑屏且需手动 restore，本例 200ms 内自恢复。

## 二、修复三件套（`client/src/explorer/Scene3D.tsx`）

1. **幂等 resize**：`resize()` 改为返回布尔——尺寸与 DPR 都未变时整段跳过，**不碰 `canvas.width`**。
   RO 在布局抖动/滚动条出现时的重复触发从此零成本，不再反复擦白。
2. **RO 内同步出帧**：新增 `presentNow()`，RO 回调里 `if (resize()) presentNow()`——真擦了就**当场画完上屏**，
   把「清空 → paint 空帧 → 下一 rAF 补画」压成同一渲染步骤内的原子操作。
   （原来那句 `wake()` 只排下一帧 rAF，本帧照旧 paint 空位图——这正是闪烁的直接成因。）
3. **帧句柄自清**：`frame()` 入口 `raf = 0`。`frame` 现在会被 `presentNow()` 同步调用，
   留着旧句柄会让后续 `wake()` 误以为还有链在跑而漏排帧。

**附带（非闪烁，每帧税）**：`getComputedStyle` 解色从"每帧 4 次"改为脏标记缓存（`refreshColors()`，
仅 resize 与本 effect 重建时置脏）。原实现每帧强制同步样式重算是白交开销；语义不变——令牌解析时机仍是"主题/尺寸变化"。

## 三、为什么"分层缓存"没能治这个病（方向对了一半）

local.1→4 的迭代轨迹：proximity 场（太敏感，撤）→ 只呼吸激活元素 → 撤 hover 遮罩 → 三层缓存（edgeCv/nodeCv/buffer）+ 空闲停摆。
这些改动**只降低单帧重绘成本、减少 rAF 次数**，但闪烁发生在"可见 canvas 被清空"这条**独立通路**上——
三层缓存再快也救不了本帧已经 paint 出去的空位图。反过来说分层缓存本身是有效的性能优化，**保留**。

教训提炼：
- 「闪烁」有两种机制——**追不上**（长帧掉帧）与**擦白了**（清空时序）。前者看单帧耗时，后者看谁在 paint 前动了 `canvas.width`。混治无效。
- `canvas.width/height` 赋值 = 清空位图，是规范行为不是 bug；任何"看起来没改尺寸"的重复赋值也要防（幂等判据）。
- `ResizeObserver` 回调时机在 layout 后、paint 前——在里面清 canvas 等于自杀式擦除。
- 多模态逐帧观察不可信，**亮度/饱和统计量 + 与 CSS 色值的算术核对**才是可复现口径。

## 四、验证口径（可复现）

重录 30s 后跑同一条 signalstats 命令，**暗帧计数必须为 0**（修复前同一口径 22/324）。

```powershell
ffmpeg -i <rec> -vf "signalstats,metadata=print:file=signalstats.txt" -f null NUL
Select-String signalstats.txt -Pattern 'YAVG:40\.' | Measure-Object   # 期望 Count = 0
```

门禁：全量 vitest 2048 passed / client typecheck 0 / eslint 0；
`dist/client.js` 哈希与装入 desktop profile 的副本逐字节一致（V6a）。

## 五、对外契约影响

**无**：零新配置键、零端点变化、零默认值变化；仅 `Scene3D.tsx` 内部渲染调度 + `projection.ts` 两个常量。
