# 安装指南（dsh-prime-memory）

本插件以 **DSH 官方 bundle 组合包**形式分发：安装后由 `cordis.patch.yml` 的 `dsh.bundle` 层自动挂载插件行，无需手改任何 profile 配置。

## 环境要求

- Node.js ≥ 22.16（DSH 0.2.0-rc.1 及以上）
- 已安装 DeepSeek Harness（以下简称 DSH），且 `--profile web` 可用

## 安装

任选一种调用方式（`npx` 前缀可替换下面任何 `dsh` 命令）：

> 以下命令仅适用于 DSH CLI 宿主与 `--profile web`；**DSH Desktop（Electron 桌面端）用户无需安装 pnpm/npm**——桌面 profile 由应用独占管理，请在应用内插件页安装本插件。

```bash
# 方式一：npx 直接跑官方 CLI（无需预装 dsh；可 pin 版本，如 dsh-prime-memory@0.8.4）
npx -y @deepseek-ai/dsh plugin --profile web add dsh-prime-memory

# 方式二：已装 dsh CLI（dsh 是 pnpm 转发器，未装 pnpm 时先 npm i -g pnpm）
dsh plugin --profile web add dsh-prime-memory

# 包源备选：GitHub 仓库 / 本地路径（开发调试，link: 指向仓库，npm run build + 重启 dsh 即生效）
dsh plugin --profile web add https://github.com/drscrewdriver/dsh-prime-memory
dsh plugin --profile web add /path/to/dsh-prime-memory
```

### 让 Agent 安装（推荐）

把下面这段话完整发送给当前 Agent（只要它能执行终端命令）：

```text
请为 DeepSeek Harness 的 web Profile 安装 dsh-prime-memory 插件。

只执行下面两条命令，不要修改其他 Profile：
dsh plugin --profile web add dsh-prime-memory
dsh --profile web --dump-config

确认输出中出现 dsh-prime-memory 后告诉我安装结果。
不要替我关闭或重启正在运行的 DSH；安装完成后提醒我手动重启 DSH Web Host。
```

## 升级

```bash
# 升级到最新版
dsh plugin --profile web update dsh-prime-memory

# 升级到指定版本
dsh plugin --profile web update dsh-prime-memory@0.8.11
```

升级只替换插件代码与 `dist/` 产物，数据目录 `~/.dsh/memory/` 不受影响。

## Windows：安装 / 更新前先关闭 DSH 运行时

Windows 上只要 DSH 桌面宿主在运行，从插件页安装 / 更新**任意**插件都可能让 pnpm（hoisted 布局）重链整棵顶层 `node_modules`，把本插件的原生依赖 `@node-rs/jieba` / `sqlite-vec` 的目录改名换入新副本；而宿主进程正持有 `jieba.*.node` / `vec0.dll`，Windows 对已加载镜像加独占锁，于是重命名失败并回滚（EPERM，报 `previous build is incomplete`）。

处理：**跑 pnpm / `dsh plugin add|update` 之前先完全退出 DSH**，确认无残留进程再装，装完重启：

```powershell
# 必须返回空，再执行安装 / 更新
Get-Process | Where-Object { $_.ProcessName -match 'dsh|deepseek|electron' }
```

这与插件本身无关——触发源是宿主的插件更新流程 + Windows 文件锁；关掉运行时即可避开锁，对任何插件的更新都成立。

## 验证

安装并重启 DSH Web Host 后检查：

1. **数据目录出现**即插件 apply 成功：`~/.dsh/memory/` 下出现 `conversations/` `records/` `scenes/` 目录与 `memory.db`；
2. **设置页出现「记忆」页面**、输入栏出现档位 pill 即 client 半边就绪；
3. 发一条带个人信息的消息，稍等蒸馏完成后，在另一轮对话里问到相关信息，应能在上下文看到「上下文注入 · memory」行。

可选冒烟测试（开发/排障用）：

```bash
npm run build
npx tsc src/smoke.ts --outDir dist-smoke --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --esModuleInterop
node dist-smoke/smoke.js
```

## 迁移 / 降级

- **从旧版（0.5.0 前名为 `dsh-memory-plugin`）迁移**：旧数据目录与新包不兼容，请备份后删除 `~/.dsh/memory/`，由新插件首次运行重建；历史记忆不可直接升级，需重新蒸馏。
- **回退到旧版**：`dsh plugin --profile web remove dsh-prime-memory` 后按旧版文档重装；数据目录保留，但旧版不识别新结构，建议一并清理。

## 卸载

```bash
dsh plugin --profile web remove dsh-prime-memory
```

数据保留在 `~/.dsh/memory/`，不需要时手动删除整个目录即可。

## 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 安装后设置页无「记忆」页 | 未重启 DSH / bundle 未挂载 | 重启 DSH Web Host；`dsh --profile web --dump-config` 确认含 `dsh-prime-memory` |
| 重启报 `duplicate loader entry id` | patch 里同时用了 `insert:` 与 bundle 同 id 追加 | 删除手动加的 `insert:` 条目，本包已自带 bundle 层 |
| 无「上下文注入 · memory」行 | 蒸馏未跑 / 召回关闭 | 检查档位非 off、recall.enabled=true；看 `memory.log` 的 `L1 阶段完成` |
| 本地嵌入档下载卡住 | 镜像直连不可达 | 设 `embedding.proxy` 走代理；或换 `embedding.mirror` 为官方 `huggingface.co` |
| 远程嵌入报错 401 | apiKey 错 / 免 key 服务不应传 key | 检查 `embedding.apiKey`；自托管免 key 服务保持 apiKey 为空 |
| Windows 更新任一插件报 EPERM / `previous build is incomplete` | 宿主运行中持有 `jieba.*.node` / `vec0.dll`，pnpm 重链原生依赖被文件锁挡下 | 先完全退出 DSH（`Get-Process ... -match 'dsh|deepseek|electron'` 为空）再安装 / 更新，装完重启 |

更多见 [README.md](./README.md) 与 [CHANGELOG.md](./CHANGELOG.md)。
