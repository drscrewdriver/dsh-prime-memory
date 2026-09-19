# HallWheel Spec — 八边形域轮（hall 主题轴门面）

> 组件组：`client/src/pill/HallWheel.tsx`（新增）+ `MemoryModePill.tsx`（面文与浮层壳）+
> `ModeSlider.tsx`（降级为覆写滑轨本体）。档位词表：`client/src/pill/modes.ts`。
> 状态：已落地（Phase 1b，feat/hall-octagon）。单选；多选升级归 task_13。

## 结构（图形内 / 图形外）

| 区 | 内容 | 交互 |
|---|---|---|
| 图形内 · 中心 | 圆形「智能」按钮 | 点击 = 回中心 = 全域（清除会话级域锁定，智能档软门禁） |
| 图形内 · 8 角 | 角按钮（域名 + 该域 N 条），正八边形顶点，词表序从正上顺时针 | 点击 = 会话级锁定该域（召回硬过滤，手动挡）；再点 = 解锁 |
| 图形外 · 边界开关 | 仅锁角时出现：`含未打标/不含` ×2（未打标默认包含；跨域 general 默认不含） | 切换即提交 session-mode-set |
| 图形外 · 会话闸 | `启用/关闭` 二态（关闭 = 会话隐身：不捕获/不蒸馏/不注入，数据保留，**不改全局**） | 关闭时八边形、边界开关、覆写滑轨、注入行整体置灰（关闭闸本身保持可达） |
| 图形外 · 注入三态 | 复用既有会话注入覆盖：跟随全局 / 开 / 关（只写） | off 档禁用 |
| 图形外 · 强制单族 | ModeSlider 降级后的覆写滑轨（日常 → 智能 → 工作） | off 档禁用 |
| 图形外 · 回填行 | 未打标 M 条 + `一键回填`（task_15：后台批量补打标签，单飞） | M=0 时禁用；启动后轮询 hall-overview 渐进更新 |
| 图形外 · 会话信息区 | SessionInfoArea（session-stats 热路径端点） | 宿主不支持时整体不渲染 |

层级：**设置页全局闸 ⊃ 会话闸（图形外）⊃ 域范围（图形内）**。不新建控件/RPC 语义：
会话闸与注入三态复用既有 `session-modes.json` 的 `mode`/`recall` 覆盖，仅调整挂载位置。

## 几何

- 容器 `SIZE=236px`（正方形）；角点轨道半径 `R_CORNER=86`，八边形外框半径 `R_POLY=66`。
- 角序 = `HALL_CATALOG` 词表序（服务端下发的 `hall-overview.corners` 顺序），i=0 从正上开始顺时针。
- 连线（中心→角）与外框八边形是纯装饰 SVG 层，`pointer-events: none`。
- 窄栏（约 215px 视口）：浮层经 `useViewportClamp` 水平贴边平移（边距 8px），8 角标签
  `white-space: nowrap` + 11px 字号下无重叠。

## 数据通道

| 数据 | 来源 | 说明 |
|---|---|---|
| 角计数 / 词表 label | `dsh-memory/hall-overview`（打开时拉取一次） | 词表单一事实源（R8）随角计数下发；未送达时角按钮降级为内置兜底名并禁点 |
| 域锁定 / 边界开关 | `session-mode-get/set` 的 `hall` / `hallIncludeUnlabeled` / `hallIncludeGeneral` | 与 `mode`/`recall` 正交、写穿持久化、跨切档保留 |
| 面文 | pill 侧 `hall-overview` 缓存 label | 锁角时面文显示 `记忆 · <域名>`（label 未送达则原样角 id） |

## 令牌（引用 global-spec，Light/Dark 双组）

- `--dsh-mem-hall-line` 连线与外框
- `--dsh-mem-hall-corner` 角默认文字
- `--dsh-mem-hall-corner-on` 选中角/中心文字与描边
- `--dsh-mem-hall-empty` 空角（0 条）文字

选中角附加 `--dsh-mem-accent-weak` 底色。无裸 hex。

## 无障碍与动效

- 全部角/中心为真实 `<button>`，`title` 说明语义（"锁定 X 域：本会话只召回该域"）。
- 八边形无动画（reduced-motion 天然静帧）；置灰用 opacity 0.45 + pointer-events none。
- 键盘：按钮原生焦点；浮层 Esc 收起、外点收起（与 pill 既有行为一致）。

## 已知限制

- Phase 1 单选；多选查询（`halls[]`）归 task_13（含 HallWheel 升级）。
- 角计数含 retired 行（口径与迁移一致：主表全量）；不区分工作区。
- 回填为后台任务（单飞、单次上限 300 条），计数渐进更新，非同步完成。
