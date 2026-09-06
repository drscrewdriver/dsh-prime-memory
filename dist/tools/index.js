import { defineTool } from '@deepseek-ai/dsh-tools';
import { GRAPH_STATUS_LABELS } from '../prompts/graph-projection.js';
const OFF_NOTICE = '本会话的记忆档位为"关闭":该会话对记忆系统完全隐身,不读取也不写入记忆。';
const WRITE_ONLY_NOTICE = '本会话为只写模式:记忆照常沉淀,但不读取。';
const GLOBAL_OFF_NOTICE = '记忆注入已全局停用:本会话不读取记忆(沉淀照常)。';
export function registerMemoryTools(ctx, cfg, stores, logger, modes, live) {
    if (!cfg.tools)
        return;
    /**
     * 调用会话的检索族(auto → undefined 不过滤;off/只写 → null 表示整体禁用)。
     * fail-open:exec.agent 缺失(宿主调用路径未带 agent 标识)按全族检索放行——
     * 档位隔离依赖宿主正确传递 exec.agent.id,缺失只告警一次不拒绝工具调用。
     */
    let warnedNoAgent = false;
    const familyOfCaller = (agentId) => {
        if (agentId === undefined) {
            if (!warnedNoAgent) {
                warnedNoAgent = true;
                logger.warn('[memory] 工具调用缺少 agent 标识(exec.agent 未传递),档位过滤退化为全族检索');
            }
            return undefined;
        }
        const mode = modes.get(agentId);
        if (mode === 'off')
            return null;
        // 只写会话拒读:与注入同属读维度,不拒则"不注入"从工具路径漏风
        if (!modes.resolvedRecall(agentId, live.get().recall))
            return null;
        return mode === 'auto' ? undefined : mode;
    };
    /** 拒读时的归因文案(familyOfCaller 判 null 后重查内存 Map,成本可忽略):
     *  off 完全隐身 / 会话只写覆盖 / 全局召回关——三种停用各说各话,不谎报只写。 */
    const blockNoticeOf = (agentId) => {
        if (agentId !== undefined) {
            if (modes.get(agentId) === 'off')
                return OFF_NOTICE;
            if (modes.getRecall(agentId) === false)
                return WRITE_ONLY_NOTICE;
            if (!modes.resolvedRecall(agentId, live.get().recall))
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
            const family = familyOfCaller(exec.agent?.id);
            if (family === null)
                return { items: [], notice: blockNoticeOf(exec.agent?.id) };
            const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
            const hits = await stores.l1.search(args.query, limit, { type: args.type || undefined, family: family ?? undefined });
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
            if (familyOfCaller(exec.agent?.id) === null)
                return { items: [], notice: blockNoticeOf(exec.agent?.id) };
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
            if (familyOfCaller(exec.agent?.id) === null)
                return { content: blockNoticeOf(exec.agent?.id) };
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
                const primary = familyOfCaller(exec.agent?.id) ?? 'chat';
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
    // memory_add:显式"记得X"直接落库一条 L1 记忆(绕过抽取管线,需高权限)。
    ctx.tools.register(defineTool({
        name: 'memory_add',
        description: '直接写入一条结构化记忆(L1)。仅当用户显式要求"记住/记下 X"时用;需高权限模式开启。内容须是待记忆的事实/偏好/任务/规则,不应包含对话过程。',
        parameters: {
            content: { type: 'string', required: true, description: '要记忆的完整内容(一句话事实,语义完整)' },
            type: { type: 'string', description: '记忆类型(persona/episodic/instruction/work_fact/work_task/work_method/work_artifact;缺省 episodic)' },
            hall: { type: 'string', description: '可选的粗分类 Hall(work/relationships/general/finance/journey)' },
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
        execute: async (args) => {
            if (!live.get().memoryMutate)
                return { notice: MUTATE_OFF_NOTICE };
            const content = String(args.content ?? '').trim();
            if (!content)
                return { notice: 'content 为空,未写入' };
            const type = ADD_TYPES.includes(String(args.type ?? '')) ? String(args.type) : 'episodic';
            const family = type.startsWith('work') ? 'work' : 'chat';
            const hall = typeof args.hall === 'string' && args.hall.trim() ? args.hall.trim().slice(0, 40) : undefined;
            const now = Date.now();
            const id = newMemId();
            await stores.l1.appendNew([
                {
                    id,
                    content,
                    type,
                    priority: 80,
                    scene_name: '__manual__',
                    timestamps: [now],
                    createdAt: now,
                    updatedAt: now,
                    metadata: hall ? { hall } : {},
                    family,
                },
            ]);
            logger.info(`[memory] 高权限写入记忆(${type}${hall ? '/' + hall : ''}):${content.slice(0, 120)}`);
            return { id };
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
            const family = familyOfCaller(exec.agent?.id);
            const limit = Math.min(Math.max(args.limit ?? 3, 1), 10);
            const hits = await stores.l1.search(query, limit, { family: family && family !== null ? family : undefined });
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
            const family = familyOfCaller(exec.agent?.id);
            if (family === null)
                return { items: [], notice: blockNoticeOf(exec.agent?.id) };
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
            const family = familyOfCaller(exec.agent?.id);
            if (family === null)
                return { notice: blockNoticeOf(exec.agent?.id) };
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
    logger.info('[memory] 工具已注册: memory_search / conversation_search / memory_read_scene / memory_search_graph / memory_expand_graph_node,及高权限 memory_add/memory_delete');
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
