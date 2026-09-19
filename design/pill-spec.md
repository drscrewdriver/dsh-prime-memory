# pill-spec — 输入栏记忆 pill + 侧边栏 icon 补丁

组件：`MemoryModePill`（`conversation.input.left` 槽位的会话记忆按钮）及其驱动的
侧边栏书本 icon 补丁。点击展开**八边形域轮**（`hall-wheel-spec.md`）。
全局令牌与守则见 `global-spec.md`。

> v5（hall 八边形，2026-09-19）：档位退居后台、hall 主题轴成为唯一门面（R1/R4）。
> pill 面文随**域锁定**切换；浮层由 ModeSlider 悬浮板改为 HallWheel 域轮
> （档位滑轨降级为浮层内"强制单族"覆写，见 `slider-spec.md`）。

## 面文

pill 文本格式：`记忆 · <值>`。取值优先序：

1. **关闭**（off 档，完全隐身）；
2. **只写**（非 off 且会话注入生效值为否——host 下发 `recallResolved=false`；
   解析权威在 host，client 不另知全局开关）；
3. **域名**（会话级域锁定，Phase 2 起多选：单选显词表下发显示名，多选显「N 域」）；
4. **档位名**（智能 / 日常 / 工作——覆写族显示）。

`--dsh-mem-mode-*` 档位色令牌与文字对比度依据（≥4.6:1，按 pill 真实底色复算）不变；
pill 半透明衍生色一律 `color-mix(in srgb, <档位色> N%, transparent)`——
**var() 引用不能拼 hex alpha 后缀**。

| 令牌 | 浅色 | 暗色 | 语义 |
|---|---|---|---|
| `--dsh-mem-mode-chat` | `#5a69b0` | `#97a4ff` | 日常（过渡蓝一档） |
| `--dsh-mem-mode-work` | `#5263ca` | `#8295ff` | 工作（过渡蓝二档） |
| `--dsh-mem-mode-auto` | `#3d5be0` | `#7b90ff` | 智能（默认档，品牌蓝） |

文字对比度按 **pill 真实底色**（流光内底 = bg-card 97% + 档位色 3%）复算，全部 ≥4.6:1
（浅 4.94/4.99/5.36；暗 5.71/4.88/4.63——最紧的暗色智能档余量 0.13）。
pill 半透明衍生色一律 `color-mix(in srgb, <档位色> N%, transparent)`——
**var() 引用不能拼 hex alpha 后缀**。

## 形态二分

pill 文本格式：`记忆 · 档位名`（全角间隔两侧各一空格）。

**关闭 / 未加载（`mode === null`）= dsh 透明按钮**：

- `.dsh-mem-pill-off`：`border: none; background: transparent`——裸 `<button>` 会露出
  浏览器 UA 默认灰底+描边（实测事故），必须显式压掉；
- hover 才出 `--dsh-mem-bg-hover` 淡底（dsh 透明按钮同款交互）；
- `:focus-visible` 品牌蓝 2px 环；文字 text-2，无光晕无流光。

**日常 / 工作 / 智能 / 锁域 = 同款流光 + 光晕**（`isFlow = loaded && !isOff`；锁域时
文字色仍随底层档位，域状态由面文词承载）：

- `.dsh-mem-flow`：border 区画品牌蓝族 conic 旋转光带（`rgba(61,91,224,0.9)` /
  `rgba(77,107,254,0.95)` / `rgba(147,168,255,1)` / `rgba(110,133,255,0.9)`，
  `dshMemFlow 3s linear infinite`，`@property --dsh-mem-angle` 注册角度插值）；
- 内层必须**不透明**底色盖住光带（半透明内层会让 conic 透进按钮内部，文字被光斑
  干扰——实测事故）：`color-mix(in srgb, var(--dsh-mem-bg-card) 97%, var(--dsh-mem-pill-tint) 3%)`，
  `--dsh-mem-pill-tint` 由 pill inline 按档位给定；
- 光晕：`box-shadow: 0 0 12px color-mix(in srgb, <档位色> 30%, transparent)`；
- 档位区分靠蓝阶文字色（inline `color: var(--dsh-mem-mode-*)`）与流光内底混色深度；
- `.dsh-mem-flow:focus-visible` 焦点环与 off 态对称（同一物理按钮的两态反馈一致）；
- 不支持 `@property` 的浏览器整条 background 退化（2023 起常青浏览器均已支持）。

## 行为

- 点击 pill 开/关 `HallWheel` 域轮浮层（见 `hall-wheel-spec.md`）；读取失败时点击重试
  （title 提示 + `⚠` 占位）。
- 档位/注入/域锁定提交乐观更新：RPC 失败回滚 + 错误行（域锁定经 `session-mode-set`
  的 `halls` 数组,与 `recall` 覆盖正交）。
- 快速切换会话时用请求序列号丢弃过期响应。
- 浮层壳定位与水平视口夹持（`useViewportClamp`）在 pill 内完成,域轮只管内容。

## 侧边栏书本 icon 补丁（受控 DOM 补丁）

宿主 `navIcon()` 按 section id 硬编码白名单（models/agent-presets/plugins）+ 齿轮回退，
settings.section slot 注册对象**没有 icon 字段**——书本 icon 只能靠 DOM 替换：

- `BOOK_ICON_SVG`：书本线稿（stroke currentColor），带 `data-mem-icon="1"` 标记；
- `patchSidebarIcon()` 扫描设置导航按钮（`[svg 或 span 文本 === "记忆"]`）替换 svg；
- 由常驻输入栏 pill 的 `watchSidebarIcon()` 驱动一个 body 级 childList 观察器
  （250ms 尾随防抖、body 属性标记全局单例、应用生命周期存续）——
  `MemoryPanel` 只在记忆分节激活时挂载，覆盖不了"打开设置第一眼"的场景；
- 宿主 DOM 结构变化时静默回退齿轮（best-effort）。

**边界**：上游若开放 icon 字段应立即切换为官方机制。
