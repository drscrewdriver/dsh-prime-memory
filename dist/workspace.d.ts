/** 会话上下文的最小形状(与 `tools/index.ts` 的 `ToolExecLike` 同源,只取 cwd)。 */
export interface WorkspaceExecLike {
    agent?: {
        session?: {
            header?: {
                cwd?: string;
            };
        };
    };
}
/**
 * 把 cwd 归一成工作区标识。**纯字符串操作**——不碰文件系统、不抛、无 I/O。
 *
 * 三条归一:① `path.resolve` 吃掉 `..` 与尾分隔符;② Windows 大小写不敏感 →
 * 转小写(否则 `E:\proj` 与 `e:\proj` 会被当成两个工作区,记忆凭空分成两份);
 * ③ 空/非字符串 → `undefined`(= 不做隔离,由调用方回落)。
 *
 * @returns 归一后的绝对路径;无法归一时 `undefined`。
 */
export declare function normalizeWorkspacePath(raw: unknown, platform?: NodeJS.Platform): string | undefined;
/**
 * 从工具执行上下文取当前工作区标识。取不到 → `undefined`(**不隔离**)。
 *
 * 这是 §E 唯一从宿主读工作区的入口——所有调用点共用它,免得某处自己拼
 * `exec.agent.session.header.cwd` 而漏掉归一(那会让两个拼写不同的同一目录
 * 各写各的归属)。
 */
export declare function workspaceIdOf(exec: unknown): string | undefined;
/**
 * §E 统一的「要不要过滤」判据:配置归一后**不是** `workspace` 时返回 `undefined`,
 * 调用方把它原样传给 `L1SearchOptions.workspaceId` → 走"不过滤"分支。
 *
 * 把判断收在这**一个**函数里,是为了让**零漂移成为结构性保证**:
 * 既有部署(`scope='global'`)在任何调用点都**不可能**意外传进一个工作区标识。
 * 若让每个调用点自己去读 `cfg.scope`,迟早有一处漏判——而漏判的表现是
 * "某条路径悄悄不做隔离",不会有任何报错。
 */
export declare function scopeFilterOf(cfgScope: unknown, exec: unknown): string | undefined;
/**
 * 按会话 id 解析工作区标识(**写入侧**用:后台蒸馏手上只有 `sessionId`,没有 `exec`)。
 *
 * 走 `ctx.get('agents')` 的**宽容路径**——与 §A 的多级父链解析同一招,
 * 刻意不把它写进 `inject`(声明成硬依赖会让宿主缺该服务时整棵插件树加载失败)。
 * 任何一步拿不到(服务缺失 / agent 不在 / header 无 cwd)→ `undefined` = 不隔离。
 */
export declare function sessionWorkspaceIdOf(ctx: unknown, sessionId: string): string | undefined;
