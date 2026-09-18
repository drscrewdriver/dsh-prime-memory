import { defineTool } from '@deepseek-ai/dsh-tools';
import { RECEIPTS_QUERY_LIMIT_MAX, dimensionOf, toReceiptView } from '../store/receipts.js';
import { listConflictPairs, renderConflictResolution, renderConflicts, resolveConflictPair } from '../conflict-service.js';
import { normPersistence, normScope, resolveRecordScope } from '../types.js';
import { scopeFilterOf, workspaceIdOf } from '../workspace.js';
import { GRAPH_STATUS_LABELS } from '../prompts/graph-projection.js';
const OFF_NOTICE = '本会话的记忆档位为"关闭":该会话对记忆系统完全隐身,不读取也不写入记忆。';
const WRITE_ONLY_NOTICE = '本会话为只写模式:记忆照常沉淀,但不读取。';
const GLOBAL_OFF_NOTICE = '记忆注入已全局停用:本会话不读取记忆(沉淀照常)。';
export function registerMemoryTools(ctx, cfg, stores, logger, modes, live, 
/** 反刍控制器(可选:未装配时 ruminate 工具返回未启用提示)。 */
ruminate) {
    if (!cfg.tools)
        return;
    /**
     * 沿父链解析**有效档位归属会话**(§A 修复)。
     *
     * 子代理以新 session id 调用工具时,其自身通常不在档位表里——原实现直接回落
     * 全局默认档(auto),于是父会话被用户显式设为 `off`/只写时,**子代理仍能读到
     * 用户明确关闭的记忆**,构成"用户显式指令被绕过"(P0)。
     *
     * 现改为沿 `session.header.parentSession` 上溯至**首个有显式档位的祖先**。
     * 同步通路由 task_4 spike 实测确认(`findings.md §8`):子代理会话的 header
     * **无条件**携带父会话 id(`dsh-subagent/.../child-agent.js:111-125`)。
     *
     * 多级链(孙代理等)需要按 id 取某个会话的 header → 走 `ctx.get('agents')`
     * 的**宽容路径**(cordis 属性访问对未 inject 的服务会抛 "without inject";
     * 同款先例见 `src/hooks/recall.ts:402-407,461`)。
     *
     * 降级(全部不抛错、不新增拒绝路径):
     * - `exec.agent` 缺失 → 返回 undefined(保持既有 fail-open);
     * - 服务缺失 / 链断 → 停止上溯,用自身 id(= 默认档,与修复前一致);
     * - 链上做环检测,自环或成环都能终止。
     */
    const resolveModeOwner = (exec) => {
        const agent = exec.agent;
        const selfId = agent?.id;
        if (selfId === undefined)
            return undefined;
        // 自身有显式档位 → 自己说了算(子代理会话也可被单独设置)
        if (modes.hasEntry(selfId))
            return selfId;
        const seen = new Set([selfId]);
        let cur = agent?.session?.header?.parentSession;
        while (cur !== undefined && !seen.has(cur)) {
            if (modes.hasEntry(cur))
                return cur;
            seen.add(cur);
            // 继续上溯:取该会话的 header(服务缺失时返回 undefined → 循环自然结束)
            const upstream = ctx.get?.('agents');
            cur = upstream?.get?.(cur)?.session?.header?.parentSession;
        }
        return selfId; // 无祖先设过 → 自身(= 默认档,行为与修复前一致)
    };
    /**
     * 调用会话的检索族(auto → undefined 不过滤;off/只写 → null 表示整体禁用)。
     * fail-open:exec.agent 缺失(宿主调用路径未带 agent 标识)按全族检索放行——
     * 档位隔离依赖宿主正确传递 exec.agent.id,缺失只告警一次不拒绝工具调用。
     */
    let warnedNoAgent = false;
    const familyOfCaller = (exec) => {
        const owner = resolveModeOwner(exec);
        if (owner === undefined) {
            if (!warnedNoAgent) {
                warnedNoAgent = true;
                logger.warn('[memory] 工具调用缺少 agent 标识(exec.agent 未传递),档位过滤退化为全族检索');
            }
            return undefined;
        }
        const mode = modes.get(owner);
        if (mode === 'off')
            return null;
        // 只写会话拒读:与注入同属读维度,不拒则"不注入"从工具路径漏风
        if (!modes.resolvedRecall(owner, live.get().recall))
            return null;
        return mode === 'auto' ? undefined : mode;
    };
    /** 拒读时的归因文案(familyOfCaller 判 null 后重查内存 Map,成本可忽略):
     *  off 完全隐身 / 会话只写覆盖 / 全局召回关——三种停用各说各话,不谎报只写。
     *  **注意按"有效档位归属会话"归因**:子代理拒读时文案取的是其祖先的档位,
     *  而非子代理自身(后者未设置,会谎报成 off)。 */
    const blockNoticeOf = (exec) => {
        const owner = resolveModeOwner(exec);
        if (owner !== undefined) {
            if (modes.get(owner) === 'off')
                return OFF_NOTICE;
            if (modes.getRecall(owner) === false)
                return WRITE_ONLY_NOTICE;
            if (!modes.resolvedRecall(owner, live.get().recall))
                return GLOBAL_OFF_NOTICE;
        }
        return OFF_NOTICE;
    };
    // ── memory_search: L1 结构化记忆 ──
    ctx.tools.register(defineTool({
        name: 'memory_search',
        description: '搜索结构化记忆(L1 原子记忆)。返回与查询相关的记忆片段:用户偏好、历史事件、项目事实、任务、规则、工作方法等。',
        parameters: {
            query: { type: 'string', required: true, description: '搜索查询文本(自然语言)' },
            limit: { type: 'number', description: '最大返回条数(默认 5)' },
            type: { type: 'string', description: '按记忆类型过滤(如 persona/episodic/instruction/work_fact/work_task/work_method/work_artifact)' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                content: { type: 'string' },
                                type: { type: 'string' },
                                scene_name: { type: 'string' },
                                score: { type: 'number' },
                            },
                            additionalProperties: false,
                        },
                    },
                    notice: { type: 'string', description: '非搜索结果的状态提示(如本会话记忆已关闭)' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                { type: 'text', text: value.notice ?? renderMemoryItems(value.items ?? []) },
            ],
        },
        execute: async (args, exec) => {
            const family = familyOfCaller(exec);
            if (family === null)
                return { items: [], notice: blockNoticeOf(exec) };
            const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
            const hits = await stores.l1.search(args.query, limit, {
                type: args.type || undefined,
                family: family ?? undefined,
                // §E 可见范围:`cfg.scope` 非 workspace 时恒为 undefined(= 不过滤)，
                // 零漂移由 `scopeFilterOf` 一处收口保证，不靠各调用点各自判断。
                workspaceId: scopeFilterOf(cfg.scope, exec),
            });
            return {
                items: hits.map((h) => ({
                    content: h.content,
                    type: h.type,
                    scene_name: h.scene_name,
                    score: Math.round(h.score * 100) / 100,
                })),
            };
        },
    }));
    // ── conversation_search: L0 原始对话 ──
    ctx.tools.register(defineTool({
        name: 'conversation_search',
        description: '搜索原始对话历史(L0)。返回带时间戳的原始消息,适用于查找具体消息原文、时间线、上下文细节。',
        parameters: {
            query: { type: 'string', required: true, description: '搜索查询文本' },
            limit: { type: 'number', description: '最大返回条数(默认 5)' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                session_id: { type: 'string' },
                                role: { type: 'string' },
                                content: { type: 'string' },
                                timestamp: { type: 'number' },
                            },
                            additionalProperties: false,
                        },
                    },
                    notice: { type: 'string', description: '非搜索结果的状态提示(如本会话记忆已关闭)' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                { type: 'text', text: value.notice ?? renderConversationItems(value.items ?? []) },
            ],
        },
        execute: async (args, exec) => {
            if (familyOfCaller(exec) === null)
                return { items: [], notice: blockNoticeOf(exec) };
            const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
            const records = await stores.l0.search(args.query, limit);
            return {
                items: records.map((r) => ({
                    session_id: r.sessionId,
                    role: r.role,
                    content: r.content,
                    timestamp: r.timestamp,
                })),
            };
        },
    }));
    // ── memory_read_scene: 读取 L2 场景块 / L3 画像 ──
    ctx.tools.register(defineTool({
        name: 'memory_read_scene',
        description: '读取记忆文件详情:L2 场景块(场景目录下的 .md 文件)或 L3 画像(persona-chat.md / persona-work.md)。返回文件完整内容。',
        parameters: {
            path: { type: 'string', required: true, description: '场景文件名,或 persona-chat.md / persona-work.md' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: '文件内容(不存在则为空字符串)' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                { type: 'text', text: value.content ? `\`\`\`markdown\n${value.content}\n\`\`\`` : '(文件不存在或为空)' },
            ],
        },
        execute: async (args, exec) => {
            if (familyOfCaller(exec) === null)
                return { content: blockNoticeOf(exec) };
            const p = args.path.trim();
            let content;
            if (p === 'persona.md' || p === 'persona-chat.md' || p === 'persona' || p === 'persona-chat') {
                content = await stores.persona.chat.read();
            }
            else if (p === 'persona-work.md' || p === 'persona-work') {
                content = await stores.persona.work.read();
            }
            else {
                // 场景文件在两族目录里按名查找(先本族后另一族)
                const primary = familyOfCaller(exec) ?? 'chat';
                const other = primary === 'chat' ? 'work' : 'chat';
                content =
                    (await stores.scenes[primary].read(p)) ?? (await stores.scenes[other].read(p));
            }
            return { content: content ?? '' };
        },
    }));
    // ── 写删工具(高权限门控):memory_add / memory_delete ──
    const MUTATE_OFF_NOTICE = '记忆写删未开放:请在记忆库面板开启「高权限模式」后,模型才能写入/删除记忆。';
    const ADD_TYPES = ['persona', 'episodic', 'instruction', 'work_fact', 'work_task', 'work_method', 'work_artifact'];
    const newMemId = () => 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    // ── 工具刷写的公共装配(时间轴 + 溯源 + 冲突标记) ──
    //
    // 时间被拆成三条**互不替代**的轴:created_at/updated_at(进库/变更时刻)、
    // valid_from/valid_to(事实在真实世界成立的时间区间)、persistence(是否会随时间失效)。
    // 把事件发生时间填进 created_at 是最常见的误用——那会让时效衰减与"目前是否成立"
    // 同时失准,所以两者在入参层面就分开。
    const MAX_IMPORT = 200;
    const DEFAULT_IMPORT_SCENE = '外部导入';
    /** ISO/epoch → epoch ms;非法或非正一律 undefined(不猜测时间)。 */
    const parseTime = (raw) => {
        if (typeof raw !== 'string' && typeof raw !== 'number')
            return undefined;
        const t = typeof raw === 'number' ? raw : Date.parse(raw);
        return Number.isFinite(t) && t > 0 ? t : undefined;
    };
    const toIsoOrNull = (ms) => ms === undefined ? null : new Date(ms).toISOString();
    /**
     * 入参 → L1 记录。
     *
     * 时间轴同时写顶层字段(时间增强列)与 metadata(列迁移前的兼容层,
     * 也是面板与图谱时间锚的读取点);`cf`/`rw` 落在 metadata.conflict/rewritten。
     */
    function buildRecord(item, sceneName, now, workspaceId) {
        const content = String(item.content ?? '').trim();
        const type = ADD_TYPES.includes(String(item.type ?? '')) ? String(item.type) : 'episodic';
        const family = type.startsWith('work') ? 'work' : 'chat';
        const validFrom = parseTime(item.valid_from);
        const validTo = parseTime(item.valid_to);
        const persistence = normPersistence(item.persistence);
        const createdAt = parseTime(item.created_at) ?? now;
        const updatedAt = parseTime(item.updated_at) ?? createdAt;
        const hall = typeof item.hall === 'string' && item.hall.trim() ? item.hall.trim().slice(0, 40) : undefined;
        const origin = typeof item.origin === 'string' && item.origin.trim() ? item.origin.trim().slice(0, 200) : undefined;
        const metadata = {
            temporal: { st: persistence ?? '?', vf: toIsoOrNull(validFrom), vt: toIsoOrNull(validTo) },
        };
        if (hall)
            metadata.hall = hall;
        if (origin)
            metadata.origin = origin;
        if (validFrom !== undefined)
            metadata.activity_start_time = toIsoOrNull(validFrom);
        if (validTo !== undefined)
            metadata.activity_end_time = toIsoOrNull(validTo);
        if (item.conflict === true)
            metadata.conflict = true;
        if (item.rewritten === true)
            metadata.rewritten = true;
        const priority = Number(item.priority);
        return {
            id: newMemId(),
            content,
            type,
            priority: Number.isFinite(priority) && priority >= 0 ? Math.min(priority, 100) : 80,
            scene_name: sceneName,
            timestamps: Array.from(new Set([validFrom ?? createdAt, createdAt, updatedAt])).sort((a, b) => a - b),
            createdAt,
            updatedAt,
            version: 0,
            metadata,
            family,
            // §E 归属：与抽取管线**同一判据**（`resolveRecordScope`）。写入路径不止一条
            // （pipeline / 本工具 / 批量导入），共用同一函数才不会有"某条路径忘了标归属"。
            ...resolveRecordScope(normScope(cfg.scope), family, workspaceId),
            ...(validFrom !== undefined ? { validFrom } : {}),
            ...(validTo !== undefined ? { validTo } : {}),
            ...(persistence !== undefined ? { persistence } : {}),
        };
    }
    /** 时间轴/溯源字段的可选入参(两个写工具共用同一形状)。 */
    const writeFields = {
        type: {
            type: 'string',
            description: '记忆类型(persona/episodic/instruction/work_fact/work_task/work_method/work_artifact;缺省 episodic)',
        },
        hall: { type: 'string', description: '可选的粗分类 Hall(work/relationships/general/finance/journey)' },
        persistence: {
            type: 'string',
            description: '持续性:t 无时间性(规则/偏好/恒真事实)、o 仍在持续、s 已结束的区间、p 时点事件;缺省=未判定',
        },
        valid_from: { type: 'string', description: '有效期起(ISO 8601):该事实在真实世界开始成立的时间' },
        valid_to: { type: 'string', description: '有效期止(ISO 8601):留空表示尚未结束或无时间性' },
        created_at: { type: 'string', description: '记录时间(ISO 8601):缺省为当前时刻' },
        updated_at: { type: 'string', description: '变更时间(ISO 8601):缺省等于记录时间' },
        origin: { type: 'string', description: '溯源:这条记忆来自哪里(文件路径/工具名/会话)' },
        conflict: { type: 'boolean', description: '是否与库内既有记忆存在未裁决的冲突' },
        rewritten: { type: 'boolean', description: '是否已被后续条目改写/取代' },
    };
    // memory_add:显式"记得X"直接落库一条 L1 记忆(绕过抽取管线,需高权限)。
    ctx.tools.register(defineTool({
        name: 'memory_add',
        description: '直接写入一条结构化记忆(L1)。仅当用户显式要求"记住/记下 X"时用;需高权限模式开启。内容须是待记忆的事实/偏好/任务/规则,不应包含对话过程。',
        parameters: {
            content: { type: 'string', required: true, description: '要记忆的完整内容(一句话事实,语义完整)' },
            ...writeFields,
            scene: {
                type: 'string',
                description: '归属场景名(缺省 __manual__;导入外部记忆建议填"外部导入/<来源>")',
            },
            priority: { type: 'number', description: '优先级 0-100(缺省 80)' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    notice: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: value.notice ?? ('已记录记忆 ' + (value.id ?? '')) }],
        },
        execute: async (args, exec) => {
            if (!live.get().memoryMutate)
                return { notice: MUTATE_OFF_NOTICE };
            const content = String(args.content ?? '').trim();
            if (!content)
                return { notice: 'content 为空,未写入' };
            const scene = typeof args.scene === 'string' && args.scene.trim() ? args.scene.trim().slice(0, 120) : '__manual__';
            const record = buildRecord(args, scene, Date.now(), workspaceIdOf(exec));
            await stores.l1.appendNew([record]);
            logger.info(`[memory] 高权限写入记忆(${record.type}${record.metadata?.hall ? '/' + String(record.metadata.hall) : ''},时间轴 ${record.persistence ?? '?'}):${record.content.slice(0, 120)}`);
            return { id: record.id };
        },
    }));
    // memory_import:批量写入(工具刷写通道——外部记忆包导入/迁移,免逐条调用)。
    ctx.tools.register(defineTool({
        name: 'memory_import',
        description: '批量写入多条记忆(L1)。用于把已整理好的外部记忆(其他 AI 工具导出的记忆包)一次性导入;需高权限模式开启。去重与冲突判定由调用方先行完成(见 memport Skill):本工具只做结构校验与批内重复拦截,不替调用方裁决语义冲突。单次上限 200 条。',
        parameters: {
            records: {
                type: 'array',
                required: true,
                description: '待写入的记录数组(content 必填,其余字段语义同 memory_add)',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        content: {
                            type: 'string',
                            required: true,
                            description: '要记忆的完整内容(一句话事实,语义完整)',
                        },
                        ...writeFields,
                        priority: { type: 'number', description: '优先级 0-100(缺省 80)' },
                    },
                },
            },
            scene: {
                type: 'string',
                description: `归属场景名(缺省 ${DEFAULT_IMPORT_SCENE};建议用"${DEFAULT_IMPORT_SCENE}/<来源>")`,
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    written: { type: 'number' },
                    ids: { type: 'array', items: { type: 'string' } },
                    skipped: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                index: { type: 'number' },
                                reason: { type: 'string' },
                            },
                            additionalProperties: false,
                        },
                    },
                    notice: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                { type: 'text', text: value.notice ?? `已导入 ${value.written ?? 0} 条记忆` },
            ],
        },
        execute: async (args, exec) => {
            if (!live.get().memoryMutate) {
                return { written: 0, ids: [], skipped: [], notice: MUTATE_OFF_NOTICE };
            }
            const raw = Array.isArray(args.records) ? args.records : [];
            if (raw.length === 0) {
                return { written: 0, ids: [], skipped: [], notice: 'records 为空,未写入' };
            }
            if (raw.length > MAX_IMPORT) {
                return {
                    written: 0,
                    ids: [],
                    skipped: [],
                    notice: `单次上限 ${MAX_IMPORT} 条(收到 ${raw.length} 条),请拆批导入`,
                };
            }
            const scene = typeof args.scene === 'string' && args.scene.trim()
                ? args.scene.trim().slice(0, 120)
                : DEFAULT_IMPORT_SCENE;
            const now = Date.now();
            const seen = new Set();
            const records = [];
            const skipped = [];
            raw.forEach((item, index) => {
                const content = String(item?.content ?? '').trim();
                if (!content) {
                    skipped.push({ index, reason: 'content 为空' });
                    return;
                }
                const key = content.replace(/\s+/g, ' ').toLowerCase();
                if (seen.has(key)) {
                    skipped.push({ index, reason: '与本批前面的记录内容重复' });
                    return;
                }
                seen.add(key);
                records.push(buildRecord(item, scene, now, workspaceIdOf(exec)));
            });
            if (records.length > 0)
                await stores.l1.appendNew(records);
            logger.info(`[memory] 批量导入 ${records.length} 条(跳过 ${skipped.length} 条,场景 ${scene})`);
            return { written: records.length, ids: records.map((r) => r.id), skipped };
        },
    }));
    // memory_delete:显式"忘了 X"——按语义检索命中后删除(高权限门控)。
    ctx.tools.register(defineTool({
        name: 'memory_delete',
        description: '删除与查询相关的记忆(L1)。仅当用户显式要求"忘记/删除某条记忆"时用;需高权限模式开启。按语义检索命中后删除(最多若干条),无法精确匹配时返回 zero。',
        parameters: {
            query: { type: 'string', required: true, description: '要删除的记忆描述(自然语言,匹配最贴近的现存记忆)' },
            limit: { type: 'number', description: '最多删除条数(默认 3,上限 10)' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    deleted: { type: 'number' },
                    ids: { type: 'array', items: { type: 'string' } },
                    notice: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                { type: 'text', text: value.notice ?? `已删除 ${value.deleted ?? 0} 条记忆` },
            ],
        },
        execute: async (args, exec) => {
            if (!live.get().memoryMutate)
                return { deleted: 0, ids: [], notice: MUTATE_OFF_NOTICE };
            const query = String(args.query ?? '').trim();
            if (!query)
                return { deleted: 0, ids: [], notice: 'query 为空,未删除' };
            const family = familyOfCaller(exec);
            const limit = Math.min(Math.max(args.limit ?? 3, 1), 10);
            const hits = await stores.l1.search(query, limit, {
                family: family && family !== null ? family : undefined,
                workspaceId: scopeFilterOf(cfg.scope, exec),
            });
            const ids = hits.map((h) => h.id);
            if (ids.length === 0)
                return { deleted: 0, ids: [], notice: '未找到匹配的记忆,未删除' };
            await stores.l1.deleteBatch(ids);
            logger.info(`[memory] 高权限删除记忆 ${ids.length} 条(${ids.join('，')})`);
            return { deleted: ids.length, ids };
        },
    }));
    // ── 图谱工具(读;受与 memory_search 同款的档位/注入拒读门 + 族过滤) ──
    const GRAPH_OFF_NOTICE = '图谱功能未启用:部署配置 graph.enabled 未开启,当前没有可用的知识图谱。';
    // memory_search_graph: 图谱节点检索(紧凑节点卡)
    ctx.tools.register(defineTool({
        name: 'memory_search_graph',
        description: '搜索知识图谱(实体节点:人物/项目/组织/工具/地点)。返回实体的当前状态摘要与匹配说明,适用于查"某人/某项目现在什么状态"这类问题;需要完整属性与关系时再用 memory_expand_graph_node 展开。',
        parameters: {
            query: { type: 'string', required: true, description: '搜索查询文本(实体名、别名、标签或状态关键词)' },
            limit: { type: 'number', description: '最大返回条数(默认 8,上限 20)' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                name: { type: 'string' },
                                type: { type: 'string' },
                                status: { type: 'string' },
                                current_state: { type: 'string' },
                                score: { type: 'number' },
                                match_reason: { type: 'string' },
                            },
                            additionalProperties: false,
                        },
                    },
                    notice: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: value.notice ?? renderGraphCards(value.items ?? []) }],
        },
        execute: async (args, exec) => {
            const family = familyOfCaller(exec);
            if (family === null)
                return { items: [], notice: blockNoticeOf(exec) };
            const graph = stores.graph;
            if (!graph)
                return { items: [], notice: GRAPH_OFF_NOTICE };
            const query = String(args.query ?? '').trim();
            if (!query)
                return { items: [], notice: 'query 为空' };
            const limit = Math.min(Math.max(args.limit ?? 8, 1), 20);
            // 族过滤:纯档会话只见本族衍生节点(auto/fail-open 不过滤)
            const hits = graph.searchNodes(query, limit, family ? [family] : undefined);
            return {
                items: hits.map((h) => ({
                    id: h.node.id,
                    name: h.node.name,
                    type: h.node.type,
                    status: h.node.status,
                    current_state: h.node.currentState,
                    score: Math.round(h.score * 100) / 100,
                    match_reason: h.matchReason,
                })),
            };
        },
    }));
    // memory_expand_graph_node: 展开单个节点(facts 全量含历史 + 关系边)
    ctx.tools.register(defineTool({
        name: 'memory_expand_graph_node',
        description: '展开一个图谱节点的完整详情:全部属性(facts,含已被更新的历史值与生效区间)、关联关系边与来源记忆 id。先用 memory_search_graph 拿到节点 id。',
        parameters: {
            id: { type: 'string', required: true, description: '节点 id(memory_search_graph 返回的 id)' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    node: { type: 'string', description: '节点详情文本(不存在为空串)' },
                    notice: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: value.notice ?? (value.node || '(节点不存在)') }],
        },
        execute: async (args, exec) => {
            const family = familyOfCaller(exec);
            if (family === null)
                return { notice: blockNoticeOf(exec) };
            const graph = stores.graph;
            if (!graph)
                return { notice: GRAPH_OFF_NOTICE };
            const id = String(args.id ?? '').trim();
            if (!id || id.length > 200)
                return { notice: 'id 缺失或过长' };
            const node = graph.getNode(id);
            // 悬挂 id 与跨族节点一律"不解析":纯档会话探测不到他族节点的存在
            if (!node || (family && !node.families.includes(family)))
                return { notice: '(节点不存在)' };
            const lines = [
                `[${node.name}](类型 ${node.type},${GRAPH_STATUS_LABELS[node.status]})`,
                ...(node.aliases.length > 0 ? [`别名: ${node.aliases.join('、')}`] : []),
                ...(node.tags?.length ? [`标签: ${node.tags.join('、')}`] : []),
                ...(node.currentState ? [`当前状态:\n${node.currentState}`] : []),
                '',
                '属性(含历史):',
            ];
            for (const f of node.facts) {
                const value = Array.isArray(f.value) ? f.value.join('、') : f.value;
                const span = [f.validFrom ? `自 ${f.validFrom}` : '', f.validTo ? `至 ${f.validTo}` : ''].filter(Boolean).join(' ');
                lines.push(`- ${f.key}: ${value}(${GRAPH_STATUS_LABELS[f.status]}${span ? `,${span}` : ''})`);
            }
            const edges = graph.edgesOf(id);
            if (edges.length > 0) {
                lines.push('', '关系:');
                for (const e of edges) {
                    const other = e.fromNodeId === id ? e.toNodeId : e.fromNodeId;
                    const arrow = e.fromNodeId === id ? '→' : '←';
                    lines.push(`- ${arrow} ${other}(${e.relation},${GRAPH_STATUS_LABELS[e.status]})`);
                }
            }
            lines.push('', `来源记忆: ${node.sourceRecordIds.join('、') || '(无)'}`);
            return { node: lines.join('\n') };
        },
    }));
    // ── 反刍工具(按需触发 L1→L2→L3 消化,受蒸馏开关门控) ──
    const RUMINATE_OFF_NOTICE = '反刍功能未开放:请在记忆库面板开启「蒸馏」开关后使用。';
    const RUMINATE_UNAVAIL_NOTICE = '反刍未初始化:存储处于降级态,无法反刍。';
    const RUMINATE_RUNNING_NOTICE = '反刍已在进行中,请稍后再试。';
    ctx.tools.register(defineTool({
        name: 'memory_ruminate',
        description: '触发记忆反刍:把未蒸馏的对话缓冲冲刷出来,跑一轮 L1 抽取 → L2 场景整合 → L3 画像更新。与重建不同,不清库不改 L0,仅消化攒而未蒸馏的切片;无缓冲时做轻量 L2/L3 刷新。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                properties: {
                    running: { type: 'boolean' },
                    phase: { type: 'string' },
                    done: { type: 'number' },
                    total: { type: 'number' },
                    recordsBuilt: { type: 'number' },
                    startedAt: { type: 'string' },
                    notice: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                { type: 'text', text: value.notice ?? renderRuminateStatus(value) },
            ],
        },
        execute: async () => {
            if (!ruminate)
                return { notice: RUMINATE_UNAVAIL_NOTICE, running: false, phase: 'idle', done: 0, total: 0, recordsBuilt: 0, startedAt: undefined };
            const s = live.get();
            if (!s.enabled || !s.distill)
                return { notice: RUMINATE_OFF_NOTICE, running: false, phase: 'idle', done: 0, total: 0, recordsBuilt: 0, startedAt: undefined };
            try {
                const result = await ruminate.start();
                return {
                    running: result.running,
                    phase: result.phase,
                    done: result.done,
                    total: result.total,
                    recordsBuilt: result.recordsBuilt,
                    startedAt: result.startedAt ? new Date(result.startedAt).toISOString() : undefined,
                };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('已在进行中'))
                    return { notice: RUMINATE_RUNNING_NOTICE, running: true, phase: err.phase ?? 'distilling', done: 0, total: 0, recordsBuilt: 0, startedAt: undefined };
                return { notice: `反刍启动失败: ${msg}`, running: false, phase: 'failed', done: 0, total: 0, recordsBuilt: 0, startedAt: undefined };
            }
        },
    }));
    // ── 取消反刍(按需取消正在进行的反刍) ──
    ctx.tools.register(defineTool({
        name: 'memory_ruminate_cancel',
        description: '取消正在进行的记忆反刍。已蒸馏部分保留,pending 切片中未被消费的部分维持原状。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                properties: {
                    notice: { type: 'string' },
                    phase: { type: 'string' },
                    running: { type: 'boolean' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: value.notice ?? `反刍已取消(当前阶段:${value.phase})` }],
        },
        execute: async () => {
            if (!ruminate)
                return { notice: RUMINATE_UNAVAIL_NOTICE, phase: 'idle', running: false };
            try {
                const result = ruminate.requestCancel();
                return {
                    notice: result.phase === 'cancelled' ? '反刍已取消' : '取消请求已发送',
                    phase: result.phase,
                    running: result.running,
                };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { notice: msg, phase: 'idle', running: false };
            }
        },
    }));
    // ── 反刍状态查询(查看当前反刍进度) ──
    ctx.tools.register(defineTool({
        name: 'memory_ruminate_status',
        description: '查询当前记忆反刍的状态与进度(是否运行中、当前阶段、已完成/总会话数等)。\n\n注意:在 DSH Web GUI 的对话中无法直接调用此工具,因为模型可调用工具列表不包含 ruminate_status。如需查询进度,请在记忆库面板的蒸馏面板查看。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                properties: {
                    running: { type: 'boolean' },
                    phase: { type: 'string' },
                    done: { type: 'number' },
                    total: { type: 'number' },
                    recordsBuilt: { type: 'number' },
                    cancelRequested: { type: 'boolean' },
                    startedAt: { type: 'string' },
                    finishedAt: { type: 'string' },
                    error: { type: 'string' },
                    notice: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                { type: 'text', text: value.notice ?? renderRuminateStatus(value) },
            ],
        },
        execute: async () => {
            if (!ruminate)
                return { notice: RUMINATE_UNAVAIL_NOTICE, running: false, phase: 'idle', done: 0, total: 0, recordsBuilt: 0, cancelRequested: false, startedAt: undefined, finishedAt: undefined, error: undefined };
            const result = ruminate.getStatus();
            return {
                running: result.running,
                phase: result.phase,
                done: result.done,
                total: result.total,
                recordsBuilt: result.recordsBuilt,
                cancelRequested: result.cancelRequested,
                startedAt: result.startedAt ? new Date(result.startedAt).toISOString() : undefined,
                finishedAt: result.finishedAt ? new Date(result.finishedAt).toISOString() : undefined,
                error: result.error ?? undefined,
            };
        },
    }));
    // ── memory_receipts: §B 决策凭证回溯(读;受与 memory_search 同款档位门) ──
    // 为什么给它一个模型可见的工具:凭证链的价值全在"事后能问"。若只有 RPC 端点,
    // 用户得自己去浏览器/curl 才能回溯,而真正会问「这条记忆怎么来的」的场合
    // 恰恰是在对话里。工具是这条链唯一的**用户可见出口**。
    ctx.tools.register(defineTool({
        name: 'memory_receipts',
        description: '回溯 L1 记忆的**去重决策出处**(决策凭证链)。按 record_id 问"这条记忆出自哪一轮蒸馏、当时看到什么候选池、被判定成了什么";按 run_id 问"那一轮蒸馏都判了什么"(跨多条记录)。两者同给即问"这条记录在那一轮里被判成了什么"。返回决策当时的结论与输入指纹,**不含记忆正文**。注意:由于记录 id 每轮新铸,按 record_id 查询目前通常只返回一条——它回答的是"出自哪",不是"历次变更"。',
        parameters: {
            record_id: { type: 'string', description: '按记忆记录 id 回溯(与 run_id 至少给一个)' },
            run_id: { type: 'string', description: '按某轮蒸馏的 run id 回溯(与 record_id 至少给一个)' },
            limit: { type: 'number', description: `最大返回条数(默认 20,上限 ${RECEIPTS_QUERY_LIMIT_MAX})` },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    dimension: { type: 'string', description: '命中的维度:record / run / both / none' },
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                receipt_id: { type: 'string' },
                                run_id: { type: 'string' },
                                record_id: { type: 'string' },
                                kind: { type: 'string', description: 'store / update / merge / skip / conflict / skip_missing' },
                                input_digest: { type: 'string' },
                                decided_at: { type: 'string' },
                            },
                            additionalProperties: false,
                        },
                    },
                    total: { type: 'number' },
                    notice: { type: 'string', description: '非结果的状态提示(如本会话记忆已关闭)' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                { type: 'text', text: value.notice ?? renderReceipts(value.dimension, value.items ?? [], value.total ?? 0) },
            ],
        },
        execute: async (args, exec) => {
            // 档位拒读门与 memory_search 同款:off 会话对记忆系统完全隐身,不该反过来
            // 能内省记忆系统的判定史(凭证虽不含正文,但泄漏"存在哪些记录/判了什么")。
            const family = familyOfCaller(exec);
            if (family === null)
                return { dimension: 'none', items: [], total: 0, notice: blockNoticeOf(exec) };
            const query = {
                recordId: typeof args.record_id === 'string' && args.record_id.trim() ? args.record_id.trim() : undefined,
                runId: typeof args.run_id === 'string' && args.run_id.trim() ? args.run_id.trim() : undefined,
            };
            const dimension = dimensionOf(query);
            if (dimension === 'none') {
                return {
                    dimension,
                    items: [],
                    total: 0,
                    notice: '需要至少一个维度:record_id(这条记忆出自哪一轮、当时候选池是什么)或 run_id(某一轮蒸馏的全部决策)。' +
                        '不提供"查全部凭证"——那等于把整库判定史一次性导出。',
                };
            }
            const limit = Math.min(Math.max(args.limit ?? 20, 1), RECEIPTS_QUERY_LIMIT_MAX);
            const rows = stores.l1.listReceipts({ ...query, limit });
            return { dimension, items: rows.map(toReceiptView), total: stores.l1.countReceipts(query) };
        },
    }));
    // ── memory_conflicts: §C 待裁决队列的**读**出口 ──
    // `memory_resolve_conflict` 的描述里早就写着"待裁决对可用 memory_conflicts 查看",
    // 但那个工具**一直不存在** —— 模型照着描述调用只会拿到"工具不存在"。
    // 裁决端点在、读端点与读工具两端都缺,队列于是成了只进不出的黑洞
    // (安全阀超时自动了结会成为唯一出路,那正是 §C 想避免的)。
    ctx.tools.register(defineTool({
        name: 'memory_conflicts',
        description: '列出**矛盾冻结**的待裁决对(§C)。冻结不自动裁决:新记忆照常入库,与它冲突的旧记忆作为**一对**停在队列里,双方内容都不被改写,直到人给出结论。返回每对的 pair_id、**双方正文**与 LLM 建议的胜负方(id 只是进入队列时的排序位,不代表结论)。看完用 memory_resolve_conflict 给出结论:winner / loser / both。',
        parameters: {
            limit: { type: 'number', description: '最多返回多少对(默认 50,上限 200)' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean', description: '矛盾冻结是否开启;关闭时队列恒空,与"开启但没有待裁决"是两回事' },
                    total: { type: 'number', description: '未裁决总数(可能大于 items.length)' },
                    items: {
                        type: 'array',
                        description: '待裁决对(最多 limit 条)',
                        items: {
                            type: 'object',
                            properties: {
                                pair_id: { type: 'string' },
                                run_id: { type: 'string', description: '产生该冻结的蒸馏批次 id(可交给 memory_receipts 追该轮判了什么)' },
                                winner_id: { type: 'string' },
                                winner_content: { type: 'string', description: 'LLM 建议胜方的正文;空串 = 该记录已不在检索库' },
                                loser_id: { type: 'string' },
                                loser_content: { type: 'string', description: '同上' },
                                created_at: { type: 'string' },
                            },
                            additionalProperties: false,
                        },
                    },
                    notice: { type: 'string', description: '非结果的状态提示(如冻结未开启 / 本会话记忆已关闭)' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: value.notice ?? renderConflicts(value) }],
        },
        execute: async (args, exec) => {
            // 档位拒读门与 memory_receipts 同款:off 会话对记忆系统完全隐身,
            // 不该反过来能内省"库里有哪些自相矛盾的记忆"。
            const family = familyOfCaller(exec);
            if (family === null) {
                return { enabled: false, total: 0, items: [], notice: blockNoticeOf(exec) };
            }
            return listConflictPairs({ l1: stores.l1, conflictFreezeEnabled: live.get().conflictFreeze === true }, { limit: typeof args.limit === 'number' ? args.limit : undefined });
        },
    }));
    // ── memory_resolve_conflict: §C 矛盾冻结的人工裁决出口 ──
    // 冻结把裁决权交还给人,那么**必须**有一个"人能把结论说回去"的出口——
    // 否则待裁决队列是个只进不出的黑洞,安全阀(task_24)会成为唯一出路,
    // 那等于把 opt-in 的冻结悄悄退回成"超时后机器自己判"。
    ctx.tools.register(defineTool({
        name: 'memory_resolve_conflict',
        description: '裁决一条**矛盾冻结**的待裁决对(§C)。冻结产生的冲突对停放在待裁决队列里,双方记忆都不被改写,直到你在这里给出结论:winner(判 LLM 建议的胜方为真,败方从检索中退场)、loser(判败方为真)、both(判定两者其实是各自独立的事实,都保留)。需先开启 conflictFreeze 配置;待裁决对可用 memory_conflicts 查看。',
        parameters: {
            pair_id: { type: 'string', description: '待裁决对的 pair_id(来自待裁决队列)' },
            outcome: { type: 'string', description: '裁决结论:winner | loser | both' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    pair_id: { type: 'string' },
                    outcome: { type: 'string' },
                    resolved_at: { type: 'string', description: '裁决时刻(ISO);空串表示未生效' },
                    removed_record_id: { type: 'string', description: '因裁决从检索中退场的记录 id(无则空串)' },
                    notice: { type: 'string', description: '非结果的状态提示(如未开启冻结 / 该对不存在或已裁决)' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: renderConflictResolution(value) }],
        },
        execute: async (args, exec) => {
            const family = familyOfCaller(exec);
            if (family === null) {
                return { pair_id: '', outcome: '', resolved_at: '', removed_record_id: '', notice: blockNoticeOf(exec) };
            }
            const empty = { pair_id: '', outcome: '', resolved_at: '', removed_record_id: '' };
            const pairId = typeof args.pair_id === 'string' ? args.pair_id.trim() : '';
            const outcome = typeof args.outcome === 'string' ? args.outcome.trim() : '';
            if (!pairId)
                return { ...empty, notice: '需要 pair_id:待裁决对没有"全部裁决"这种用法。' };
            return resolveConflictPair({ l1: stores.l1, conflictFreezeEnabled: live.get().conflictFreeze === true }, pairId, outcome);
        },
    }));
    logger.info('[memory] 工具已注册: memory_search / conversation_search / memory_read_scene / memory_receipts / memory_search_graph / memory_expand_graph_node,及高权限 memory_add/memory_import/memory_delete / memory_resolve_conflict / memory_ruminate / memory_ruminate_cancel / memory_ruminate_status');
}
/** 凭证回溯的人类可读渲染(含"还有多少条没显示")。 */
function renderReceipts(dimension, items, total) {
    const what = dimension === 'record' ? '该记录出自哪一轮' : dimension === 'run' ? '该批次的全部决策' : '该记录在该批次中的决策';
    if (items.length === 0)
        return `(${what}:没有查到凭证——该 id 可能从未走过 L1 去重,或凭证已超出保留窗口)`;
    const lines = items.map((it, i) => `${i + 1}. [${it.kind ?? ''}] run=${it.run_id ?? ''} record=${it.record_id ?? ''}` +
        `\n   时刻: ${it.decided_at ?? ''}\n   输入指纹: ${(it.input_digest ?? '').slice(0, 16)}…`);
    const more = total > items.length ? `\n…共 ${total} 条,已显示 ${items.length} 条` : '';
    return `${what}(${items.length} 条):\n${lines.join('\n')}${more}`;
}
function renderGraphCards(items) {
    if (!items || items.length === 0)
        return '(图谱中没有找到相关实体)';
    return items
        .map((it, i) => {
        const state = it.current_state ? `\n   状态: ${it.current_state.replaceAll('\n', ' / ')}` : '';
        return `${i + 1}. ${it.name ?? ''}(类型 ${it.type ?? ''},id=${it.id ?? ''})${state}\n   匹配: ${it.match_reason ?? ''}`;
    })
        .join('\n');
}
function renderMemoryItems(items) {
    if (!items || items.length === 0)
        return '(没有找到相关记忆)';
    return items
        .map((it, i) => `${i + 1}. [${it.type ?? ''}]${it.scene_name ? ` (${it.scene_name})` : ''} ${it.content ?? ''}`)
        .join('\n');
}
function renderConversationItems(items) {
    if (!items || items.length === 0)
        return '(没有找到相关对话)';
    return items
        .map((it, i) => {
        const time = it.timestamp ? new Date(it.timestamp).toISOString() : '';
        return `${i + 1}. [${it.role ?? ''}]${time ? ` ${time}` : ''} (session=${it.session_id ?? ''})\n${it.content ?? ''}`;
    })
        .join('\n\n');
}
function renderRuminateStatus(v) {
    const running = v.running ?? false;
    const status = running ? `🔄 反刍运行中` : '✅ 反刍已完成';
    const phaseMap = {
        idle: '空闲',
        distilling: 'L1 蒸馏中',
        consolidating: 'L2 场景整合中',
        updating: 'L3 画像更新中',
        done: '完成',
        cancelled: '已取消',
        failed: '失败',
    };
    const phase = phaseMap[v.phase ?? 'idle'] ?? v.phase ?? 'idle';
    const total = v.total ?? 0;
    const done = v.done ?? 0;
    const parts = [`${status} [${phase}]`];
    if (running || total > 0) {
        parts.push(`进度: ${done}/${total} 会话`);
    }
    if ((v.recordsBuilt ?? 0) > 0) {
        parts.push(`产出: ${v.recordsBuilt} 条记忆`);
    }
    if (v.startedAt) {
        parts.push(`开始: ${v.startedAt}`);
    }
    if (v.finishedAt) {
        parts.push(`结束: ${v.finishedAt}`);
    }
    if (v.error) {
        parts.push(`错误: ${v.error}`);
    }
    if (v.cancelRequested) {
        parts.push('⚠️ 已请求取消');
    }
    return parts.join(' | ');
}
