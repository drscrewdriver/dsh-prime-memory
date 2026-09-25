import { EFFORT_CHOICES } from './config.js';
/** 运行时路由链上限(写入门与 UI 同限,防误粘贴巨数组撑爆 settings 存储)。 */
export const DISTILL_CHAIN_MAX = 8;
/**
 * 运行时统一路由链的展示投影(llm-providers 的 chain.current 数据源):
 * distillChain 非空即原样返回;为空时投影旧运行时键(distillProvider/distillModel
 * 成对 → 单行主路由,旧档位 reasoningEffort 作为该主路由的档位)。注意:生效逻辑
 * (effectiveCfg)只认显式 distillChain、不走本投影——旧键路径在未配链时按旧语义
 * 原样生效。
 */
export function projectDistillChain(s) {
    if (s?.distillChain?.length)
        return s.distillChain;
    if (s?.distillProvider && s?.distillModel) {
        return [{ provider: s.distillProvider, model: s.distillModel, reasoningEffort: s.reasoningEffort || '' }];
    }
    return [];
}
/**
 * settings-set 写入门校验:返回错误文案(null = 通过)。
 * opts.requireExplicitHead(层链用):头行必须 provider+model 双显式——层键出现
 * 即意图覆盖;"双空 = 跟随默认模型"是全局链独有语义,层链禁掉双空头,消除
 * "层链头跟随哪套全局解析"的歧义。
 */
export function validateDistillChain(chain, opts) {
    if (!Array.isArray(chain))
        return 'distillChain 须为数组';
    if (chain.length > DISTILL_CHAIN_MAX)
        return `路由链最多 ${DISTILL_CHAIN_MAX} 条`;
    const seen = new Set();
    for (let i = 0; i < chain.length; i++) {
        if (!chain[i] || typeof chain[i] !== 'object')
            return `第 ${i + 1} 行须为对象`;
        const e = chain[i];
        const p = typeof e.provider === 'string' ? e.provider : '';
        const m = typeof e.model === 'string' ? e.model : '';
        const eff = typeof e.reasoningEffort === 'string' ? e.reasoningEffort : '';
        if (p.length > 200 || m.length > 200)
            return `第 ${i + 1} 行 provider/model 过长(≤200 字符)`;
        if (!EFFORT_CHOICES.includes(eff))
            return `第 ${i + 1} 行思考档位非法: ${eff || '(空)'}`;
        if (i === 0) {
            if (opts?.requireExplicitHead && (!p || !m))
                return '主路由行必须显式选择供应商与模型(层链不支持跟随默认模型)';
            if ((p && !m) || (!p && m))
                return '主路由行 provider 与 model 须成对(双空 = 跟随默认模型)';
        }
        else if (!p || !m) {
            return `第 ${i + 1} 行回退路由必须显式选择供应商与模型`;
        }
        if (p && m) {
            const key = `${p}::${m}`;
            if (seen.has(key))
                return `第 ${i + 1} 行与前面的路由重复(${p}/${m})`;
            seen.add(key);
        }
    }
    return null;
}
/** 本插件 loader entry id(cordis.patch.yml 固定)= 0.1.7 设置表单的命名空间。 */
export const MEMORY_ENTRY_ID = 'dsh-memory';
const ALWAYS_ON = {
    enabled: true,
    capture: true,
    distill: true,
    recall: true,
    reasoningEffort: '',
    distillProvider: '',
    distillModel: '',
    distillChain: [],
    distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0, graph: 0 },
    distillMaxInputChars: 0,
    distillLayerChains: { l1: [], l2: [], l3: [] },
    distillMode: '',
    directBaseURL: '',
    directApiKey: '',
    embedRemoteBaseURL: '',
    embedRemoteApiKey: '',
    embedRemoteModel: '',
    embedRemoteDimensions: 0,
    memoryMutate: false,
    conflictFreeze: false,
};
/** 自带自定义设置页(settings.section 顶层「记忆」分节,client 半挂载):
 *  关掉宿主按 volatile 字段自动生成的表单页,避免同一个插件出现两份设置入口。
 *  settings 服务缺失/未挂 configure 时静默跳过(自动表单页照常生成,无害)。 */
export function suppressAutoSettingsForm(ctx) {
    ctx.inject(['settings'], (sctx) => {
        sctx.effect(() => {
            const svc = sctx.get('settings');
            return svc?.configure?.({ auto: false }, ctx.fiber) ?? (() => { });
        });
    });
}
export function registerLiveSettings(ctx, config, logger) {
    // 读面:volatile 引用恒在(由 Config schema 默认值兜底),读数现取现解析,
    // 无进程内缓存——旧「服务就绪探测 / scope 复用 / 实例判活」整套机制随
    // 命令式注册面一起删除(0.1.7 无注册,自然无 already-registered 竞态)。
    const ref = config.live;
    const read = () => resolveSettings(ref.get());
    // 变更诊断(替代旧 scope.watch):宿主把 volatile-only 变更提交进引用后,
    // 向持有 fiber 广播一次 loader/volatile-update(路径为键数组,只关心 live 节)。
    ctx.on('loader/volatile-update', (paths) => {
        if (!paths.some((p) => p[0] === 'live'))
            return;
        const current = read();
        const b = current.distillBudgets;
        const budgetNote = (b.extract || b.dedup || b.l2 || b.l3 || b.graph)
            ? `,输出预算=抽取 ${b.extract || '默认'}/去重 ${b.dedup || '默认'}/L2 ${b.l2 || '默认'}/L3 ${b.l3 || '默认'}/图谱 ${b.graph || '默认'}`
            : '';
        const inputNote = current.distillMaxInputChars > 0 ? `,输入预算=${current.distillMaxInputChars}` : '';
        logger.info(`[memory] 记忆模式开关更新:总=${current.enabled} 捕获=${current.capture} 蒸馏=${current.distill} 召回=${current.recall}` +
            `,蒸馏思考=${current.reasoningEffort || '跟随配置'}` +
            (current.distillProvider && current.distillModel
                ? `,蒸馏模型=${current.distillProvider}/${current.distillModel}`
                : '') + budgetNote + inputNote);
    });
    // 写面:settings 服务(宿主服务,可能晚于本插件就绪)——用 inject 惰性握手,
    // 服务替换时 cordis 会重跑回调换上新实例,无需手工判活。
    let forms;
    ctx.inject(['settings'], (sctx) => {
        forms = sctx.get('settings');
    });
    return {
        supported: true,
        get: read,
        update: async (patch) => {
            if (!forms)
                throw new Error('settings 服务不可用,记忆开关无法写入');
            // patch 合并语义与旧 scope.update 一致:只改传入键。合并在插件侧完成后
            // **整节提交**——宿主的表单 update 按 volatile 节整体写入 profile patch,
            // 部分对象会覆盖掉未提交字段。写失败(update 抛错)对调用方可观测。
            const next = { ...read(), ...patch };
            await forms.update(MEMORY_ENTRY_ID, { live: next });
        },
    };
}
/** scope.get() 的防御性解析:异常值回退默认(宁可多记不可静默停摆)。 */
function resolveSettings(value) {
    if (!value || typeof value !== 'object')
        return { ...ALWAYS_ON, distillChain: [] };
    const v = value;
    const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
    const rawBudgets = (v.distillBudgets ?? {});
    // 路由链逐条防御:非对象条目剔除、超长截断、非法档位归空、超限截断到上限
    const defuseChain = (raw) => {
        const out = [];
        if (!Array.isArray(raw))
            return out;
        for (const item of raw) {
            if (out.length >= DISTILL_CHAIN_MAX)
                break;
            if (!item || typeof item !== 'object')
                continue;
            const e = item;
            const eff = typeof e.reasoningEffort === 'string' && EFFORT_CHOICES.includes(e.reasoningEffort)
                ? e.reasoningEffort
                : '';
            out.push({
                provider: typeof e.provider === 'string' ? e.provider.slice(0, 200) : '',
                model: typeof e.model === 'string' ? e.model.slice(0, 200) : '',
                reasoningEffort: eff,
            });
        }
        return out;
    };
    const rawLayer = (v.distillLayerChains ?? {});
    return {
        enabled: v.enabled !== false,
        capture: v.capture !== false,
        distill: v.distill !== false,
        recall: v.recall !== false,
        reasoningEffort: typeof v.reasoningEffort === 'string' && EFFORT_CHOICES.includes(v.reasoningEffort)
            ? v.reasoningEffort
            : '',
        distillProvider: typeof v.distillProvider === 'string' ? v.distillProvider : '',
        distillModel: typeof v.distillModel === 'string' ? v.distillModel : '',
        distillChain: defuseChain(v.distillChain),
        distillLayerChains: {
            l1: defuseChain(rawLayer.l1),
            l2: defuseChain(rawLayer.l2),
            l3: defuseChain(rawLayer.l3),
        },
        distillBudgets: {
            extract: num(rawBudgets.extract),
            dedup: num(rawBudgets.dedup),
            l2: num(rawBudgets.l2),
            l3: num(rawBudgets.l3),
            graph: num(rawBudgets.graph),
        },
        distillMaxInputChars: num(v.distillMaxInputChars),
        // 蒸馏通道:mode 白名单(非法归 '' = 跟随部署);端点与密钥截断防御但保留原始内容
        distillMode: v.distillMode === 'host' || v.distillMode === 'direct' ? v.distillMode : '',
        directBaseURL: typeof v.directBaseURL === 'string' ? v.directBaseURL.slice(0, 2000) : '',
        directApiKey: typeof v.directApiKey === 'string' ? v.directApiKey.slice(0, 2000) : '',
        // 远程嵌入覆盖:端点/密钥截 2000,模型名截 200,维度钳 0~8192(与部署 schema 上限一致)
        embedRemoteBaseURL: typeof v.embedRemoteBaseURL === 'string' ? v.embedRemoteBaseURL.slice(0, 2000) : '',
        embedRemoteApiKey: typeof v.embedRemoteApiKey === 'string' ? v.embedRemoteApiKey.slice(0, 2000) : '',
        embedRemoteModel: typeof v.embedRemoteModel === 'string' ? v.embedRemoteModel.slice(0, 200) : '',
        embedRemoteDimensions: typeof v.embedRemoteDimensions === 'number' && Number.isFinite(v.embedRemoteDimensions)
            ? Math.min(Math.max(Math.floor(v.embedRemoteDimensions), 0), 8192)
            : 0,
        // 写删门:严格 === true(任何异常值都视为关,模型写删风险宁紧勿松)
        memoryMutate: v.memoryMutate === true,
        // §C 人工冲突裁决:严格 === true(默认关,冻结消耗注意力)
        conflictFreeze: v.conflictFreeze === true,
    };
}
