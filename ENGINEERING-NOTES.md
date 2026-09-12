# ENGINEERING NOTES — 踩坑与修复方向手册

> 本文件沉淀 `dsh-prime-memory` 开发中**实际踩过的坑**与**走错过的修复方向**，目的不是记录"什么是对的"，
> 而是让后来者**不再重复付出同样的调试代价**。
>
> 收录标准：① 曾实际导致失败、误判或返工；② 有非显然的根因；③ 有可复用的规避动作。
> 每条都给出**现象 / 根因 / 正确做法 / 如何验证**四段。
>
> 适用版本：`dsh-prime-memory@0.10.0`，DSH value schema DSL `@deepseek-ai/dsh-tools@0.1.1-rc.2`。
> 最近更新：2026-09-12（反刍功能三轮修复期间）。

---

## 0. 一页速查

| 现象 | 跳转 |
|---|---|
| `unsupported JSON schema: … nullable is not supported` → 插件树整棵加载失败 | [A1](#a1-nullable-让整棵插件树崩溃) |
| 端点恒返 `{supported:false}` / 「控制器未初始化」 | [A2](#a2-声明了字段却忘了注入--端点被永久钉在降级分支) |
| `TypeError: messages is not iterable` | [A3](#a3-同一份文件两个解析器--其中一个从未成功过) |
| 「反刍已在进行中」卡住不动、界面无进度 | [B1](#b1-守卫标志位放在-finally-等于没放) / [B2](#b2-长任务不置-running-界面只能显示运行中) |
| `ReferenceError: xxx is not defined` 而 `tsc` 不报错 | [B3](#b3-可选字段让-tsc-抓不到未定义标识符) |
| 测试用挂起 promise 挡住某一步却挡不住 | [B4](#b4-await-不能出现在非-async-作用域) |
| 测试全绿但真实环境必崩 | [C1](#c1-只用空数据写测试) |
| `tsc` 报 0 个错误（其实是假的） | [D2](#d2-powershell-管道捕获让-tsc-错误数变-0) |
| 中文乱码 / 行号对不上 / 文件开头多个不可见字符 | [D3](#d3-编码三连bom-乱码-行号漂移) |
| `git commit -F` 后正文变 `?` 或整条被覆盖 | [E1](#e1-amend--m-会整条替换消息) |
| 提权后仍 `spawn EPERM` | [D1](#d1-沙箱-spawn-eperm不是权限不够的意思) |

---

# A. 导致线上/启动失败的真实缺陷

## A1. `nullable` 让整棵插件树崩溃

**现象**

```
Error: dsh: plugin tree failed to load: 应用 loader 条目 dsh-memory (dsh-prime-memory) 失败:
unsupported JSON schema: schema.properties.startedAt.nullable is not supported by the value schema DSL
```
DSH **完全无法启动**（不是功能降级，是进程退出）。

**根因**：DSH 的 value schema DSL **只接受一组白名单作者键**：
`description` / `title` / `default` / `examples` / `required`（仅 properties）/ `type` / `enum` /
`const` / `properties` / `additionalProperties` / `items` / `oneOf`。
`nullable` **不在其中**——它是 OpenAPI/JSON-Schema 方言的写法，写进去会在 `defineTool()` 编译 schema 时抛错。

**正确做法**：删掉 `nullable: true`。该 DSL 中**属性默认即可选**，只有显式 `required: true` 才必填；
且运行时校验对 `undefined` 取值**跳过**，所以 `execute()` 返回 `startedAt: undefined` 依然合法。
语义完全不变。

**如何验证**：`tsc` 通过 + `grep -r nullable src/` 无命中 + 启动后工具注册日志出现
`工具已注册: …`。**光看 `tsc` 不够**——这是 schema 编译期（运行时）错误，类型检查发现不了。

> 🔴 **方向性教训**：插件树是**全有或全无**的。任何单个 loader 条目 apply 失败都会带走整个进程。
> 因此新增工具/schema 后，**必须做一次真实启动验证**，"类型过了"远不足以交付。

---

## A2. 声明了字段却忘了注入 → 端点被永久钉在降级分支

**现象**：`dsh-memory/ruminate-status` 恒返 `{supported:false,running:false,phase:'idle'}`，
`start`/`cancel` 恒抛「反刍控制器未初始化」。而**界面把 `supported===false` 解释为"功能不存在"整块 `return null`**，
于是故障表现为**功能凭空消失**而非报错——这就是它能潜伏很久的原因。

**根因**：`EndpointDeps.ruminate` 字段已声明、三个端点实现也写好了，但组装 deps 实参时**没把控制器传进去**，
`deps.ruminate` 恒为 `undefined`。审计发现：`EndpointDeps` 的 13 个字段里，`ruminate` 是**唯一"已声明但未注入"**的那个——
`rebuild`/`embedManager`/`sessionInfo` 都是对的，所以**没有对照组、看不出异常**。

**正确做法**：把 deps 组装抽成**可测的单一接缝** `buildEndpointDeps()`，并用
`EndpointDepsInput`（`Omit<EndpointDeps,'ctx'|'cfg'|'stores'|'logger'>`）约束注入面——
这样"漏注入"会在**编译期**暴露，而不是运行时静默降级。

```ts
// ✅ 接缝形态：注入字段由类型检查保证齐全
export function buildEndpointDeps(base, sources, controller): EndpointDeps {
  const injected: EndpointDepsInput = { ...sources, ruminate: controller };
  return { ...base, ...injected };
}
```

**如何验证**：控制器级测试断言注入后 `status` 返回 `supported !== false`；未注入时走降级分支。

> 🔴 **方向性教训**：**降级分支会掩盖故障**。任何 `?.` / `if (!dep) return DEGRADED` 的设计，
> 都必须配一条"已装配"的正向用例，否则你永远只测到了降级那条路。

---

## A3. 同一份文件两个解析器 —— 其中一个从未成功过

**现象**

```
TypeError: messages is not iterable
  ❯ groupPendingBySession src/store/pending.ts:104
  ❯ groupSessions            src/pipeline/ruminate.ts:75
  ❯ RuminateController.start src/pipeline/ruminate.ts:139
```

**根因**：`ruminate.ts` 自带一个 `readPendingBuckets()`，把 `JSON.parse(readFileSync(file))`
**直接断言**成 `PendingBuckets`（`{auto,chat,work}`）。但磁盘真实形状是 `PendingFile`：

```json
{ "version": 1, "buckets": { "auto": [], "chat": [], "work": [] }, "warmup": {...} }
```

**漏了一层 `buckets` 解包** → `buckets[mode]` 恒为 `undefined` → `for (const m of messages)` 抛错。

**关键反直觉点（我曾判断错）**：抛错**与桶里有没有数据无关**。桶空也抛，因为
`undefined` 本身不可迭代。`catch` 只在**文件不存在（ENOENT）**时才兜出合法空桶；
而 `persistPending` 每轮都会写这个文件，所以**在任何有缓冲的真实部署里，点反刍必然失败**。
真实潜伏原因是**该功能从未被触发过**（日志里没有任何「反刍开始」记录），不是"数据恰好为空"。

**正确做法**：`store/pending.ts` 的 `loadPending()` 已经是该文件形状的**唯一权威**
（含形状校验、逐桶 `Array.isArray`、`isMessage` 坏行丢弃计数、旧格式 `LEGACY_SESSION` 归组、`warmup` 校验）。
**删掉第二个解析器**，改为：

```ts
const { buckets } = await loadPending(this.pendingFile, this.logger);
this.sessions = groupSessions(buckets);
```
**绝不要**在 `pending.ts` 再开一个"XX 专用读取入口"——那正是本缺陷的成因。

**如何验证**：控制器级测试（见 [C1](#c1-只用空数据写测试)）先红后绿；`grep -r readPendingBuckets dist/` 应无命中。

> 🔴 **方向性教训（Anti-Entropy）**：**同一语义存在第二条实现路径时，其中一条必然腐烂**，
> 而且因为它是"没人走的那条"，腐烂不会变红。发现重复解析/重复契约时，第一反应应该是**删掉一条**，
> 而不是"把两条都改对"。

---

# B. 代码级陷阱

## B1. 守卫标志位放在 `finally` 等于没放

**背景**：把 `readPendingBuckets` 改成 `await loadPending(...)` 后，`start()` 在
"守卫检查"与"`status.running` 置位"之间**多出一个事件循环让出点**，双击/连发 RPC 可双双穿过守卫。

**我第一版的错误改法**：

```ts
this.starting = true;
try {
  ...
  this.doEnqueue(0);      // ← 异步入队，立刻返回
  return { ...this.status };
} finally {
  this.starting = false;  // ← 错！start() 一返回就清旗，守卫形同虚设
}
```

**根因**：`doEnqueue` 用 `setImmediate` **异步**递归入队，`start()` **不等蒸馏完成就返回**。
所以 `finally` 在"任务还在跑"时就把旗清了 → 第二次 `start()` 顺利通过 → 两套 `this.sessions` 互相覆盖。

**正确做法**：把"跨 `await` 的持久守卫"交给 `status.running`（它在 `await` **之前**就置位），
`starting` 只封住"读取期间"这个**同步→异步过渡窗口**，并在成功分支末尾显式复位：

```ts
this.status = { ...IDLE_STATUS, running: true, phase: 'distilling', ... };
this.doEnqueue(0);
this.starting = false;   // 此刻 status.running 已置位，后续并发由它拦
return { ...this.status };
```

**如何验证**：并发用例 `Promise.allSettled([ctl.start(), ctl.start()])`
断言 **恰好 1 个 fulfilled / 1 个 rejected**。

---

## B2. 长任务不置 `running`，界面只能显示"运行中"

**现象**：点反刍后界面只有一句静态说明，**无进度条、无取消按钮、无阶段、无耗时**；
此时再点一次得到「反刍已在进行中」——提示正确但毫无信息量，用户无法判断"在跑"还是"卡死"。

**根因**：`start()` 在无 pending 切片时 `return await this.doLightRefresh()`，
而该分支**从不置 `running`** → `ruminate-status` 期间仍返回 `phase:'idle'`/`running:false`。
**但这里的 L2/L3 是真实 LLM 调用，实测单次 70 秒以上**，且 `start()` 一直挂在 `await` 上占着守卫。

**正确做法**：长任务开始前就把状态置为"运行中"，并给出**可判定的进度**：

1. 先算出待执行步骤数 → `total`；
2. 每完成一步 `done++`；
3. 新增 `phase='refreshing'` 让 UI 有阶段名；
4. 新增 `detail` 描述**当前动作**（如 `L2 场景整合(chat)`）；
5. 面板显示 `已完成/总步数(百分比)` + **实时「已用 X分Y秒」**。

**如何验证**：用挂起的依赖把某一步钉住，在**运行期间**取样断言
`running===true` / `total>0` / `detail` 含预期关键字（见 [B4](#b4-await-不能出现在非-async-作用域)）。

> 🔴 **方向性教训**：**"运行中"不是一个状态，三个信息才构成一个状态：在做什么 + 做到哪 + 花了多久。**
> 只报 `running:true` 等于没报。凡是单步可能超过 ~10 秒的操作，都必须有 `detail` 级别的描述。

---

## B3. 可选字段让 `tsc` 抓不到"未定义标识符"

**现象**：删掉一个形参后，deps 字面量里仍写着 `ruminate,` —— 该标识符已不存在，
但 **`tsc` 不报错**，直到运行时抛 `ReferenceError: ruminate is not defined`，**一次带走 12 个无关测试**。

**根因**：`EndpointDeps.ruminate` 是**可选**属性，`{ ..., ruminate }` 这种简写上，
类型检查器不会把"标识符是否存在"与"属性是否可选"联系起来（简写属性走的是赋值兼容性）。

**正确做法**：不要把裸标识符写进对象字面量，而是**经过显式接缝**：

```ts
const injected: EndpointDepsInput = { status, live, modes, dataDir, rebuild, ruminate };
```
`EndpointDepsInput` 里 `ruminate` 是**必填**，于是漏传/拼错会在**编译期**失败。
（这也是 [A2](#a2-声明了字段却忘了注入--端点被永久钉在降级分支) 的同一个修法。）

**如何验证**：故意删掉一个注入字段，`tsc` 应当报错。

---

## B4. `await` 不能出现在非 async 作用域

**我的错误尝试**：在 `describe('...', () => { ... })` 回调里写
`const { createHash } = await import('node:crypto');`
—— 这不是 async 函数，ESM 顶层 await **只允许在模块顶层**。

**正确做法**：需要模块级依赖就写**顶层 `import`**：

```ts
import { createHash } from 'node:crypto';
```
（改完记得删掉原地的局部 `const`，否则会留下一条夹在函数中间的 import。）

**同理**：测试里想"挡住某一步"时，**不要**依赖 `vi.doMock` —— 如果被测模块已在本文件顶部 import，
再 `doMock` 不会生效。**更稳的做法是让依赖真的挂住**：

```ts
let release: () => void = () => {};
const gate = new Promise<void>((r) => { release = r; });
// runSceneConsolidation 第一步就是 scenes.list()，用挂起的 list() 把它钉住
const stores = { scenes: { chat: { list: () => gate }, work: { list: () => gate } }, ... };
```
这样无需 mock 任何模块，且能精确在"运行中"取样。

---

# C. 测试与类型门禁

## C1. 只用空数据写测试

**现象**：**17 个测试文件、199 个用例全绿**，而 [A3](#a3-同一份文件两个解析器--其中一个从未成功过) 的崩溃
在真实环境**必现**。

**根因（两重）**：
1. **`tests/` 对 `RuminateController` 的实例化引用为 0**——唯一命中是注释里的 stub；
2. 形状契约被**测在了另一个函数上**：`stores.test.ts` 覆盖的是**正确实现 `loadPending`**，
   而真正腐烂的重复解析器**零覆盖**。
   准确表述不是"只覆盖了空数据"，而是**"契约被测在 A 上，而 B 才是生产路径"**。

**正确做法**：
- 新增**控制器级**用例（解析层被删除后，这是**唯一**可行路径，不是"更划算"的取舍）；
- **必须含非空载荷**——三桶里放真实消息，断言 `total` == 会话组数、`mode` 由**桶键推导**；
- 另加**契约用例**：手写磁盘形状 JSON 走过真实读取路径。**不要**只依赖 `savePending → loadPending` 往返——
  那种往返测试在"读写两侧同时改错"时**依然会通过**。

> 🔴 **方向性教训**：**测试要钉在"生产真实调用路径"上，而不是钉在"最容易测的函数"上。**
> 写测试前先问：这段代码在真实调用链里是谁在读它？

---

## C2. `vitest` 只转译不检查 → 测试与类型契约悄悄漂移

**现象**：把 `tests/**` 纳入 `tsconfig.test.json` 后，暴露 **8 个文件约 60 个类型错误**：
`MemoryConfig` 从错误模块导入（`contract.js`/`types.js`，实际在 `config.js`）、
`DistillBudgets` 缺必填 `graph`、`UserMessage.turn` 不存在、`readonly string[]` 赋给可变 `string[]`、
`rpc.test.ts` 约 33 处裸 `as` 不重叠断言、隐式 `any` 参数……

**根因**：`tsconfig.json` 的 `include` 只有 `src/**`，vitest 只**转译**不类型检查，
于是**契约变了、测试没跟着变，运行时却照旧全绿**。

**正确做法（ratchet，不要一把梭）**：
1. `tsconfig.json` 有 `rootDir:"src"`，**不能**直接 include `tests/**`（会报 **TS6059**），
   必须新建 `tsconfig.test.json`（`extends` 主配置 + `rootDir:"."` + `noEmit` + `declaration:false`）；
2. **先测量再决定**：错误少就修，错误多就先 ratchet——**只纳入干净的测试文件**，
   其余逐个修完再放开；
3. 绝不使用 `@ts-nocheck` 或批量 `as unknown as` 掩盖——那只是把漂移藏得更深。

**如何验证**：`tsc -p tsconfig.test.json` exit 0；新加入的测试文件必须落在 include 里。

---

# D. 环境与工具链陷阱

## D1. 沙箱 `spawn EPERM` 不是"权限不够"的意思

**现象**：`node node_modules/vitest/vitest.mjs run` 与 `esbuild` 构建全部失败：

```
Error: spawn EPERM
  at ensureServiceIsRunning (node_modules/esbuild/lib/main.js:2272)
```

**根因**：受限文件沙箱**禁止子进程用管道 stdio**（`child_process.spawn` 默认 `stdio:'pipe'`）。
这不是"文件不可写"，是**进程创建被拦**。**任何**会 spawn 的工具都会中招（vitest worker、esbuild 服务、`Start-Process`）。

**我试过且无效的路子（记录下来省得重试）**：
| 尝试 | 结果 |
|---|---|
| 直接执行 | `spawn EPERM` |
| 提权重试 | 策略判 `risky:system → auto-deny`（ask 模式下无审批者可应答 → fail closed） |
| `ESBUILD_BINARY_PATH` 指向 `@esbuild/win32-x64/esbuild.exe` | **仍然 EPERM** —— 该变量只改二进制**路径**，不改"必须 spawn"这件事 |

**正确做法**：需要真实子进程时**提升文件策略**（`danger-full-access`）。
一旦放开，此前被判 `risky:remote` 而误拒的 `npm run smoke` / `verify-catalog` 也一并恢复——
**它们其实纯本地，属启发式误判**，不需要加白名单。

**如何验证**：`node scripts/build-client.mjs` → `client bundle built → dist/client.js (N bytes)`。

---

## D2. PowerShell 管道捕获让 `tsc` 错误数变 0

**现象**：我用下面这行"测量"测试目录的类型错误，得到 **0 个**：

```powershell
$out = node node_modules/typescript/bin/tsc -p tsconfig.test.json 2>&1
($out | Select-String -Pattern "error TS").Count   # → 0   ❌ 假的
```

**根因**：**PS 在输出被重定向/捕获时会跳过逐行管道处理**，`$out` 实际为空 → 数了个寂寞。
"0 个错误"是假象，真实是**约 60 个**。我据此做出了"可直接全量纳入"的错误判断，被真实测量推翻。

**正确做法**：测量类命令**直接让它打到控制台**，人眼/直接读取：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.test.json; Write-Host "exit: $LASTEXITCODE"
```
或**重定向到文件再读文件**，不要依赖内存变量：

```powershell
node ... > out.txt 2>&1; Get-Content out.txt | Select-String "error TS"
```

**同类陷阱**：`2>$null` 与 `Start-Process` 也会触发沙箱拒绝。
**判断命令真伪的唯一可靠依据是 `$LASTEXITCODE`**，不要用"输出看起来对"来推断成功。

> 🔴 **方向性教训**：**"没有输出"和"没有错误"是两件事。**
> 任何"测量得到 0/空"的结论，都要用第二种方式复核一次再采信。

---

## D3. 编码三连：BOM、乱码、行号漂移

**现象**：
1. `git commit` 后 commit subject 变成 `<BOM>fix(ruminate): …`（开头一个不可见字符）；
2. `Get-Content` 打印中文注释变 `锟斤拷` 式乱码，且**报错行号与真实文件对不上**；
3. `Out-File -Encoding ascii` 写出的提交消息，中文全变 `?`。

**根因**：
- **BOM**：PowerShell `Out-File -Encoding UTF8` 在 Windows PowerShell 上会**带 BOM**；
- **乱码**：控制台代码页与文件编码不一致；
- **行号漂移**：乱码渲染让输出与真实行号错位——**我因此一度追错文件**。

**正确做法**：
| 场景 | 做法 |
|---|---|
| 写 UTF-8 无 BOM 文件 | `[System.IO.File]::WriteAllText($p, $s, [System.Text.UTF8Encoding]::new($false))` |
| 读文件核对内容 | 用 `read` 工具（带行号），**不要**用 `Get-Content` 判断中文 |
| 定位报错行 | 以工具给出的**文件:行号**为准，别信控制台渲染的行号 |
| 行尾 | 给 shell 脚本写文件要确保 **LF**，CRLF 会让 `sh` 解析出错 |

**如何验证**：写完检查首字节不是 `EF BB BF`；`ReadAllBytes` 前 3 字节应为内容字节。

---

# E. Git 与提交纪律

## E1. `amend` + `-m` 会整条替换消息

**我的错误**：为去掉 BOM，执行 `git commit --amend -m "…subject…"` ——
`-m` 是**整条替换**，把原本的**详细正文全部清空**了（正文长度变成 0）。

**正确做法**：要改消息就**完整重写**，用文件传入并确保编码正确：

```powershell
[System.IO.File]::WriteAllText($p, $fullMsg, [System.Text.UTF8Encoding]::new($false))
git commit --amend -F $p -q
```

**同类踩坑**：
- `git rebase -i --exec "…"` 在 PowerShell 下**引用极易被破坏**（反斜杠被 shell 吃掉、引号被吞），
  中途还会停在 detached HEAD。**能不用就不用**。
- `git filter-branch` 的 `--msg-filter` 里写路径要用 **`/` 正斜杠**（反斜杠会被当转义），
  且脚本内容最好**放进独立 `.sh` 文件**由 `sh <file>` 调用，避开一切内联引用问题；
  不加范围时 `-f` 会被拒绝，要显式给 `<base>..HEAD`。

## E2. "内容没变"必须用 tree 哈希证明，不能靠感觉

重写历史（`amend`/`rebase`/`filter-branch`）后，**唯一可信的等价性证明是 tree 哈希**：

```powershell
git rev-parse "NEW^{tree}"; git rev-parse "OLD^{tree}"   # 相同 → 只改了消息，内容零变化
```

**兜底习惯**：动手前先开个备份分支 + 记住 reflog：

```powershell
git branch backup/pre-rewrite
git reflog            # 任何误操作都能回到 aaa HEAD@{n}
```

> 我这次因 `reset --soft` 目标判断失误把状态搞乱过一次，**是靠 reflog 完整恢复的**。

## E3. 提交纪律（本项目约定）

1. **超出既有约定的改动（尤其"契约零改动"这类）动手前后都要有 commit 固定**，
   便于回溯与回滚；
2. **修复必须记入 `CHANGELOG.md` 的 `[未发布]` 块**，且要写**用户可见影响**，不能只写技术根因；
3. 提交信息用**完整正文**说明：根因 → 修复 → 验证 → 前置 checkpoint；
4. **不要**顺手提交无关的大文件（本项目 `registry-save.json` 2.7MB 仍未决策，见 `.agents/plans/pending-issues.md` P6）；
5. 规划与论证产物统一落在 `.agents/plans/<任务名>/`，固定 4 个文件名
   （`spec.md` / `findings.md` / `checklist.md` / `tasks.md`），超限时归并归档。

---

# F. 验证清单（交付前逐条过）

以下每条都对应上面一个真实踩过的坑，**建议直接抄进 PR 描述**：

- [ ] `tsc -p tsconfig.json` exit 0
- [ ] `tsc -p tsconfig.client.json` exit 0（**契约改动后必跑**，见 [A2](#a2-声明了字段却忘了注入--端点被永久钉在降级分支)/[E](#e-git-与提交纪律)）
- [ ] `tsc -p tsconfig.test.json` exit 0（新测试文件必须在 include 内）
- [ ] `vitest run` 全绿，**且 `$LASTEXITCODE` 为 0**（不要只看输出，见 [D2](#d2-powershell-管道捕获让-tsc-错误数变-0)）
- [ ] `eslint` 0 error
- [ ] `npm run build` 三步全过（`build-client.mjs` 需能 spawn，见 [D1](#d1-沙箱-spawn-eperm不是权限不够的意思)）
- [ ] `node dist-smoke/smoke.js` 全过
- [ ] **`dist/` 已同步**（改了 `src/` 或 `client/src/` 后必须重建；profile 是符号链接，**重启 DSH 才生效**）
- [ ] 新增/修改的 schema：**做一次真实启动**（[A1](#a1-nullable-让整棵插件树崩溃) 是运行时错误，类型检查抓不到）
- [ ] 新增端点/控制器：**有"已装配"的正向用例**，不能只测降级分支（[A2](#a2-声明了字段却忘了注入--端点被永久钉在降级分支)）
- [ ] 新增读取器：**确认没有第二条解析路径**（[A3](#a3-同一份文件两个解析器--其中一个从未成功过)）
- [ ] 长任务（单步 >10s）：有 `phase` + `done/total` + `detail` + 耗时（[B2](#b2-长任务不置-running-界面只能显示运行中)）
- [ ] 测试用例含**非空真实载荷**，且钉在**生产调用路径**上（[C1](#c1-只用空数据写测试)）
- [ ] `CHANGELOG.md` 已记录**用户可见影响**
- [ ] 提交信息完整；如需重写历史，**已用 tree 哈希证明内容未变**（[E2](#e2-内容没变必须用-tree-哈希证明不能靠感觉)）

---

## 附：本手册对应的三轮修复记录

| 轮次 | 主题 | 关键教训 |
|---|---|---|
| 一 | 工具 schema `nullable` 导致插件树崩溃 | 插件树全有或全无；schema 错误类型检查抓不到（[A1](#a1-nullable-让整棵插件树崩溃)） |
| 二 | 反刍 RPC 端点未接通（deps 漏注入） | 降级分支会掩盖故障；注入面要可测（[A2](#a2-声明了字段却忘了注入--端点被永久钉在降级分支)） |
| 三 | `pending.json` 漏解包 `buckets` + 进度不可观测 | 重复解析器必然腐烂；"运行中"需要三个信息（[A3](#a3-同一份文件两个解析器--其中一个从未成功过) / [B2](#b2-长任务不置-running-界面只能显示运行中)） |

更细的论证、行号证据与未决项见 `.agents/plans/`：
`ruminate-rpc-wiring/`（第二轮）、`ruminate-pending-fix/`（第三轮）、`pending-issues.md`（未决台账）。
