/**
 * §E 工作区标识解析:从会话上下文取"当前工作区",供存储作用域过滤使用。
 *
 * ## 为什么是 cwd,而不是 `ctx.workspaceRegistry` 的 `WorkspaceId`
 *
 * DSH 宿主**已有**工作区实体(`@deepseek-ai/dsh-workspace`):`Workspace.id` 是
 * 一个 uuid,文档明确写着 *"A generated uuid, never the path: path normalization
 * rewrites paths, and a reference anchor must stay stable."* 看似该用它。但四条理由
 * 决定我们用 **canonical cwd**:
 *
 * 1. **同步可得**。`session.header.cwd` 与 §A 用的 `session.header.parentSession`
 *    是**同一条通路**(`dsh-session` 的 `SessionHeader`,两个字段相邻),
 *    §A 的 spike 已经把这条通路实测过了——零新增风险。而 `WorkspaceId` 要经
 *    `workspaceRegistry.resolveByPath()`,是 **async**。
 * 2. **不能声明 inject**。`workspaceRegistry` 若是硬依赖,宿主缺该服务时**整棵插件树
 *    加载失败**——违反 ADR-0008 条 4。走 `ctx.get()` 宽容路径虽可行,但那就不是
 *    "同步可得"了,退化成异步 + 服务缺失分支。
 * 3. **宿主自己就拿 cwd 当工作区身份**。`Workspace` 的成员判据原文:
 *    *"Membership requires both an id in that account and a session header whose
 *    canonical cwd equals the workspace path."* —— cwd 是宿主认可的身份来源,
 *    不是我们另造的标尺。
 * 4. **uuid 需要一个"已注册"的工作区记录**。消费者不该为了记忆隔离,先要求用户
 *    去宿主里注册工作区。未注册目录在 uuid 方案下**没有 id**,只能整片回落 global,
 *    等于隔离静默失效。
 *
 * ## 已知边界(如实标注,非"待办"而是"选择的代价")
 *
 * 本实现用**字符串归一**(`path.resolve` + Windows 小写),**不解析符号链接**;
 * 宿主 `realpathNormalize()` 走 `fs.realpath`,两者对符号链接拼写不同的同一目录
 * 会给出不同标识。后果是**过度隔离**(同一目录的两种拼写互相看不见),而非泄漏。
 * 取这个方向是因为:拼写差异在实践中罕见(同一会话的 cwd 来自同一来源),
 * 而"过度隔离"至少是安全方向;且 `ctr.realpath` 会**在路径不存在时 reject**,
 * 把一次 fs 失败带进写入与召回主链路,代价高于收益。
 *
 * **另注**:`realpathNormalize` 是 async 且会抛,若要接它必须包 try/catch 并回落——
 * 这属可选精化,已登记为开放项,不在本波做。
 */
import * as path from 'node:path';
import { normScope } from './types.js';
/**
 * 把 cwd 归一成工作区标识。**纯字符串操作**——不碰文件系统、不抛、无 I/O。
 *
 * 三条归一:① `path.resolve` 吃掉 `..` 与尾分隔符;② Windows 大小写不敏感 →
 * 转小写(否则 `E:\proj` 与 `e:\proj` 会被当成两个工作区,记忆凭空分成两份);
 * ③ 空/非字符串 → `undefined`(= 不做隔离,由调用方回落)。
 *
 * @returns 归一后的绝对路径;无法归一时 `undefined`。
 */
export function normalizeWorkspacePath(raw, platform = process.platform) {
    if (typeof raw !== 'string')
        return undefined;
    const trimmed = raw.trim();
    if (!trimmed)
        return undefined;
    try {
        const resolved = path.resolve(trimmed);
        return platform === 'win32' ? resolved.toLowerCase() : resolved;
    }
    catch {
        // 理论上不会走到(纯字符串解析),但宁可回落也不让一次路径解析炸掉蒸馏
        return undefined;
    }
}
/**
 * 从工具执行上下文取当前工作区标识。取不到 → `undefined`(**不隔离**)。
 *
 * 这是 §E 唯一从宿主读工作区的入口——所有调用点共用它,免得某处自己拼
 * `exec.agent.session.header.cwd` 而漏掉归一(那会让两个拼写不同的同一目录
 * 各写各的归属)。
 */
export function workspaceIdOf(exec) {
    const cwd = exec?.agent?.session?.header?.cwd;
    return normalizeWorkspacePath(cwd);
}
/**
 * §E 统一的「要不要过滤」判据:配置归一后**不是** `workspace` 时返回 `undefined`,
 * 调用方把它原样传给 `L1SearchOptions.workspaceId` → 走"不过滤"分支。
 *
 * 把判断收在这**一个**函数里,是为了让**零漂移成为结构性保证**:
 * 既有部署(`scope='global'`)在任何调用点都**不可能**意外传进一个工作区标识。
 * 若让每个调用点自己去读 `cfg.scope`,迟早有一处漏判——而漏判的表现是
 * "某条路径悄悄不做隔离",不会有任何报错。
 */
export function scopeFilterOf(cfgScope, exec) {
    if (normScope(cfgScope) !== 'workspace')
        return undefined;
    return workspaceIdOf(exec);
}
/**
 * 按会话 id 解析工作区标识(**写入侧**用:后台蒸馏手上只有 `sessionId`,没有 `exec`)。
 *
 * 走 `ctx.get('agents')` 的**宽容路径**——与 §A 的多级父链解析同一招,
 * 刻意不把它写进 `inject`(声明成硬依赖会让宿主缺该服务时整棵插件树加载失败)。
 * 任何一步拿不到(服务缺失 / agent 不在 / header 无 cwd)→ `undefined` = 不隔离。
 */
export function sessionWorkspaceIdOf(ctx, sessionId) {
    try {
        const agents = ctx?.get?.('agents');
        const cwd = agents?.get?.(sessionId)?.session?.header?.cwd;
        return normalizeWorkspacePath(cwd);
    }
    catch {
        return undefined;
    }
}
