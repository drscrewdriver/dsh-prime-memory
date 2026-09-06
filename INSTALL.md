# 安装指南（dsh-layered-memory）

本插件以 **DSH 官方 bundle 组合包**形式分发：安装后由 `cordis.patch.yml` 的 `dsh.bundle` 层自动挂载插件行，无需手改任何 profile 配置。

## 环境要求

- Node.js ≥ 22.16（DSH 0.1.1-rc.2 及以上）
- 已安装 DeepSeek Harness（以下简称 DSH），且 `--profile web` 可用

## 安装

任选一种调用方式（`npx` 前缀可替换下面任何 `dsh` 命令）：

```bash
# 方式一：npx 直接跑官方 CLI（无需预装 dsh；可 pin 版本，如 dsh-layered-memory@0.8.4）
npx -y @deepseek-ai/dsh plugin --profile web add dsh-layered-memory

# 方式二：已装 dsh CLI（dsh 是 pnpm 转发器，未装 pnpm 时先 npm i -g pnpm）
dsh plugin --profile web add dsh-layered-memory

# 包源备选：GitHub 仓库 / 本地路径（开发调试，link: 指向仓库，npm run build + 重启 dsh 即生效）
dsh plugin --profile web add https://github.com/JunNanLYS/dsh-layered-memory
dsh plugin --profile web add /path/to/dsh-layered-memory
```

### 让 Agent 安装（推荐）

把下面这段话完整发送给当前 Agent（只要它能执行终端命令）：

```text
请为 DeepSeek Harness 的 web Profile 安装 dsh-layered-memory 插件。

只执行下面两条命令，不要修改其他 Profile：
dsh plugin --profile web add dsh-layered-memory
dsh --profile web --dump-config

确认输出中出现 dsh-layered-memory 后告诉我安装结果。
不要替我关闭或重启正在运行的 DSH；安装完成后提醒我手动重启 DSH Web Host。
```

## 升级

```bash
# 升级到最新版
dsh plugin --profile web update dsh-layered-memory

# 升级到指定版本
dsh plugin --profile web update dsh-layered-memory@0.8.11
```

升级只替换插件代码与 `dist/` 产物，数据目录 `~/.dsh/memory/` 不受影响。

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
- **回退到旧版**：`dsh plugin --profile web remove dsh-layered-memory` 后按旧版文档重装；数据目录保留，但旧版不识别新结构，建议一并清理。

## 卸载

```bash
dsh plugin --profile web remove dsh-layered-memory
```

数据保留在 `~/.dsh/memory/`，不需要时手动删除整个目录即可。

## 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 安装后设置页无「记忆」页 | 未重启 DSH / bundle 未挂载 | 重启 DSH Web Host；`dsh --profile web --dump-config` 确认含 `dsh-layered-memory` |
| 重启报 `duplicate loader entry id` | patch 里同时用了 `insert:` 与 bundle 同 id 追加 | 删除手动加的 `insert:` 条目，本包已自带 bundle 层 |
| 无「上下文注入 · memory」行 | 蒸馏未跑 / 召回关闭 | 检查档位非 off、recall.enabled=true；看 `memory.log` 的 `L1 阶段完成` |
| 本地嵌入档下载卡住 | 镜像直连不可达 | 设 `embedding.proxy` 走代理；或换 `embedding.mirror` 为官方 `huggingface.co` |
| 远程嵌入报错 401 | apiKey 错 / 免 key 服务不应传 key | 检查 `embedding.apiKey`；自托管免 key 服务保持 apiKey 为空 |

更多见 [README.md](./README.md) 与 [CHANGELOG.md](./CHANGELOG.md)。
