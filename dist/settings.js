import { EFFORT_CHOICES, liveSettingsSchema } from './config.js';
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
    injectBootMode: 'off',
    extractBootMode: 'off',
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
    distillTimeoutMs: 0,
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
    skillsEnabled: false,
    // 知识图谱投影:默认关(部署 cfg.graph.enabled 仍可强制开;这里只做追加开)
    graphEnabled: false,
    keywordEnabled: false,
    redistillEnabled: false,
    mdSyncEnabled: false,
    memportEnabled: false,
    // 时效分级门2 灰度开关:默认关(注入与改前逐字一致)
    validityTiering: false,
    // 记忆库侧栏入口:默认开(用户装了插件就能看到)
    explorerEnabled: true,
    // md 投射护栏运行时覆盖:0 = 跟随部署 cfg.memExport.maxRecords（面板上可改）
    mdExportMaxRecords: 0,
    // 回填并行度运行时覆盖:0 = 跟随部署 cfg.backfill.concurrency（概览页滑块可改）
    backfillConcurrency: 0,
    // 外部同步运行时开关(T4.2 后补):档位 '' = 跟随部署;三布尔为双闸的热阀
    extSyncMode: '',
    extPushEnabled: false,
    extPullEnabled: false,
    extAllowHardDelete: false,
    // 污染隔离闸：默认**开**（本仓第一个默认开的 live 闸，理由见 config.ts 注释）
    extImportIsolate: true,
    toolRoom: true,
    toolGraph: true,
    toolRuminate: true,
    toolConflict: true,
    toolMutate: true,
    toolSkills: true,
    // v0.26.57 工具面精简:管理组(graphAdmin)与旧名兼容组(legacy)默认**封印**——
    // memory_reproject/migrate_relation/graph_admin 是人工纠偏通道、memory_add 等四件已被
    // memory_write 吸收,常态不该占模型工具位;要开回在设置页显式打开。
    toolGraphAdmin: false,
    toolLegacy: false,
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
/**
 * 读 live 节的当前值。两种形状都得接：
 * - 新 schemastery：`liveSettingsSchema()` 成功标了 `.volatile()`，宿主给 `Volatile<T>`（有 `.get()`）。
 * - 老 schemastery（0.1.5-rc.3 解析到的 4.0.2，无 `.volatile()`）：config.ts 的探测不标，
 *   宿主直接给配置对象本体——没有 `.get()`，当成冻结快照读即可。
 * 不兼容这一形就是在老线报 `ref.get is not a function`（把加载期崩换成运行期崩）。
 */
export function readLiveRef(ref) {
    const maybe = ref;
    return typeof maybe?.get === 'function' ? maybe.get() : maybe;
}
export function registerLiveSettings(ctx, config, logger, bootStore) {
    // 读面:volatile 引用恒在(由 Config schema 默认值兜底),读数现取现解析,
    // 无进程内缓存——旧「服务就绪探测 / scope 复用 / 实例判活」整套机制随
    // 命 令式注册面一起删除(0.1.7 无注册,自然无 already-registered 竞态)。
    const ref = config.live;
    // 启动挡位以插件自有存储为准（宿主 forms.update 会剪掉新增的 bootMode 键，
    // 见 store/boot-mode.ts）；无存档时保留 volatile 解出的值。
    const withBoot = (s) => {
        if (!bootStore)
            return s;
        const inject = bootStore.get('inject');
        const extract = bootStore.get('extract');
        if (inject === undefined && extract === undefined)
            return s;
        return {
            ...s,
            injectBootMode: inject ?? s.injectBootMode,
            extractBootMode: extract ?? s.extractBootMode,
        };
    };
    const read = () => withBoot(resolveSettings(readLiveRef(ref)));
    // 变更诊断(替代旧 scope.watch):宿主把 volatile-only 变更提交进引用后,
    // 向持有 fiber 广播一次 loader/volatile-update(路径为键数组,只关心 live 节)。
    // 同时拨一下竞态门 waitForVolatile(启动挡位在 patch 未并入时等这里)。
    let releaseVolatile;
    ctx.on('loader/volatile-update', (paths) => {
        releaseVolatile?.();
        releaseVolatile = undefined;
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
    // ── 读写面三代腰(纯特性检测,playbook §5:勿按版本号分支)──────────────
    // 代 1(0.1.7+):settings 服务有 SettingsForms.update(ns,patch) —— 读走 Config
    //   live volatile 引用(read()),写走 forms.update(整节提交)。
    // 代 2(0.1.2/0.1.5):settings.register 返回 SettingsScope(get/watch/update)
    //   —— 读写全走 scope(写活读死:0.1.2/0.1.5 的 scope.get() 快照可能恒默认,
    //   磁盘才是真值,调用方以持久化成功为准)。
    // 代 2'(register 缺失):installSection 只回 hooks —— 读走 setSource 注入的
    //   thunk,写显式拒绝。
    // 代 3(0.1.0/0.1.1):settings 服务整体缺席 → 恒开降级,internal/service 上线
    //   重试。参考件:compat/0.1.5 registerLiveSettings 的 tryAttach 全套。
    let forms;
    ctx.inject(['settings'], (sctx) => {
        forms = sctx.get('settings');
    });
    let inner = {
        supported: false,
        get: () => ({ ...ALWAYS_ON, distillChain: [] }),
        update: () => Promise.reject(new Error('settings 服务不可用,记忆开关无法写入')),
        // 降级句柄:两个写面都不可用(live 写不了、配置节更写不了)
        configWritable: false,
        updateConfig: () => Promise.reject(new Error('settings 服务不可用,配置无法写入')),
        readConfig: () => undefined,
    };
    const wireScope = (scope) => {
        return {
            supported: true,
            get: () => resolveSettings(scope.get()),
            update: async (patch) => {
                await scope.update(patch);
            },
            // 代 2/2' 的 scope 只认 live 节,不开放任意配置节写入——面板据此置灰而非伪装成功。
            configWritable: false,
            updateConfig: () => Promise.reject(new Error('当前宿主不支持配置写入(旧 scope 只认 live 节):请改在 profile.yaml 里维护 ext_memory')),
            readConfig: () => undefined,
        };
    };
    const tryAttachOld = () => {
        const settings = ctx.get('settings');
        if (!settings || typeof forms?.update === 'function')
            return true; // 代 1 生效,老臂不必挂
        if (typeof settings.register === 'function') {
            try {
                const scope = settings.register(MEMORY_ENTRY_ID, liveSettingsSchema(), { applies: 'live' });
                inner = wireScope(scope);
                logger.info('[memory] 记忆模式开关就绪(settings.register,命名空间 dsh-memory)');
                return true;
            }
            catch (err) {
                logger.warn(`[memory] 记忆模式开关注册失败(保持全开): ${err instanceof Error ? err.message : String(err)}`);
                return true;
            }
        }
        if (typeof settings.installSection === 'function') {
            try {
                let source = () => ({ ...ALWAYS_ON, distillChain: [] });
                let notify;
                const bridge = {
                    get: () => resolveSettings(source()),
                    watch: (callback) => {
                        notify = () => void callback(bridge.get());
                        return () => {
                            notify = undefined;
                        };
                    },
                    update: () => Promise.reject(new Error('installSection 桥接模式不支持运行时写入')),
                };
                settings.installSection(ctx, MEMORY_ENTRY_ID, liveSettingsSchema(), { ...ALWAYS_ON, distillChain: [] }, {
                    setSource: (current) => {
                        source = current;
                    },
                    onChange: () => notify?.(),
                });
                inner = wireScope(bridge);
                logger.info('[memory] 记忆模式开关就绪(settings.installSection 桥接,运行时写入不可用)');
                return true;
            }
            catch (err) {
                logger.warn(`[memory] 记忆模式开关 installSection 桥接失败(保持全开): ${err instanceof Error ? err.message : String(err)}`);
                return true;
            }
        }
        logger.warn('[memory] settings 服务无可用的 register/installSection API,记忆模式开关降级为恒开');
        return true;
    };
    if (!tryAttachOld()) {
        logger.warn('[memory] settings 服务未就绪,记忆模式开关暂不可用(保持全开,等待服务上线)');
    }
    // 服务迁移自愈(代 2/2' 臂):下线 → 降级;换实例/上线 → 立即重试挂接(幂等)。
    ctx.on('internal/service', (name) => {
        if (name !== 'settings')
            return;
        inner = {
            supported: false,
            get: () => ({ ...ALWAYS_ON, distillChain: [] }),
            update: () => Promise.reject(new Error('settings 服务不可用,记忆开关无法写入')),
            configWritable: false,
            updateConfig: () => Promise.reject(new Error('settings 服务不可用,配置无法写入')),
            readConfig: () => undefined,
        };
        tryAttachOld();
    });
    const modernWrite = () => {
        const f = forms;
        return !!(f && typeof f.update === 'function');
    };
    return {
        supported: true,
        get: () => (modernWrite() ? read() : withBoot(inner.get())),
        /** 面板据此置灰:把"写不了"伪装成"写成功"比明确不支持更坑。 */
        get configWritable() {
            return modernWrite();
        },
        bootModeOf: (axis) => bootStore?.get(axis),
        waitForVolatile: (timeoutMs = 3000) => new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done)
                    return;
                done = true;
                resolve();
            };
            releaseVolatile = finish;
            setTimeout(finish, timeoutMs).unref?.();
        }),
        updateConfig: async (patch) => {
            const f = forms;
            if (f === undefined || typeof f.update !== 'function') {
                throw new Error('当前宿主不支持配置写入(settings.forms 缺席);请改在 profile.yaml 里维护 ext_memory');
            }
            await f.update(MEMORY_ENTRY_ID, patch);
        },
        readConfig: (key) => {
            const f = forms;
            if (f === undefined || typeof f.get !== 'function')
                return undefined;
            try {
                const all = f.get(MEMORY_ENTRY_ID);
                return all?.[key];
            }
            catch {
                // 读回失败不能顶掉写入结果:调用方按"未校验"处理即可
                return undefined;
            }
        },
        update: async (patch) => {
            // 启动挡位(两轴)先进插件自有存储（权威）——宿主 forms.update 会剪掉这些新键，
            // 不先落盘则重启后读不回。同值时 set 短路。先写 store，后续 read() 的
            // withBoot 叠加才能反映新值。
            if (bootStore && patch.injectBootMode !== undefined) {
                await bootStore.set('inject', patch.injectBootMode);
            }
            if (bootStore && patch.extractBootMode !== undefined) {
                await bootStore.set('extract', patch.extractBootMode);
            }
            if (modernWrite()) {
                if (!forms)
                    throw new Error('settings 服务不可用,记忆开关无法写入');
                // patch 合并语义与旧 scope.update 一致:只改传入键。合并在插件侧完成后
                // **整节提交**——宿主的表单 update 按 volatile 节整体写入 profile patch,
                // 部分对象会覆盖掉未提交字段。写失败(update 抛错)对调用方可观测。
                const next = { ...read(), ...patch };
                await forms.update(MEMORY_ENTRY_ID, { live: next });
                return;
            }
            await inner.update(patch);
        },
    };
}
/** scope.get() 的防御性解析:异常值回退默认(宁可多记不可静默停摆)。 */
/**
 * 启动期应用两轴三态挡位：
 * - 注入轴 injectBootMode：on/off 把 recall 写回初值，last 原样保留；
 * - 提取轴 extractBootMode：on/off 把 capture 与 distill 写回初值，last 原样保留；
 * - 总闸 enabled 钉为 true（不再作为顶控，行为由三键接管）。
 *
 * 为什么在启动期写而不是读侧折叠：读侧折叠会让「本会话手动开关」永远失效。
 * 写回一次后本会话走持久化的 recall/capture/distill；写面缺席（老宿主/降级句柄）时
 * 保持持久值，不阻断启动。
 *
 * 诊断与竞态防护（0.27.9，用户反馈「选了下次关闭重启不生效」）：启动固定打印一行
 * 「插件存档×磁盘回读×生效值」对照；无存档且 volatile 与磁盘对不上时等一次广播后重读。
 */
export async function applyBootMode(live, logger) {
    const say = (msg) => logger?.info(msg);
    const warn = (msg) => (logger ? logger.warn(msg) : console.warn(msg));
    try {
        let s = live.get();
        const injStore = live.bootModeOf?.('inject');
        const extStore = live.bootModeOf?.('extract');
        say(`[memory] 启动挡位对照: 注入=${s.injectBootMode}${injStore ? '(存档)' : ''} 提取=${s.extractBootMode}${extStore ? '(存档)' : ''}` +
            ` | 现值 recall=${s.recall} capture=${s.capture} distill=${s.distill}`);
        // 两轴均为 last 且无存档时，不写回（沿用持久值）。
        if (injStore === undefined && extStore === undefined) {
            const persisted = live.readConfig?.('live');
            const diskInject = persisted?.injectBootMode;
            if ((diskInject === 'on' || diskInject === 'off') &&
                diskInject !== s.injectBootMode) {
                say(`[memory] 挡位竞态信号: 磁盘注入=${String(diskInject)} 运行时=${s.injectBootMode}，等一次 volatile 广播后重读`);
                await live.waitForVolatile?.(3000);
                s = live.get();
            }
        }
        const patch = { enabled: true };
        let touched = false;
        if (s.injectBootMode === 'on' && s.recall !== true) {
            patch.recall = true;
            touched = true;
        }
        else if (s.injectBootMode === 'off' && s.recall !== false) {
            patch.recall = false;
            touched = true;
        }
        if (s.extractBootMode === 'on' && (s.capture !== true || s.distill !== true)) {
            patch.capture = true;
            patch.distill = true;
            touched = true;
        }
        else if (s.extractBootMode === 'off' && (s.capture !== false || s.distill !== false)) {
            patch.capture = false;
            patch.distill = false;
            touched = true;
        }
        if (s.enabled !== true)
            touched = true; // 总闸钉 true
        if (!touched) {
            say(`[memory] 启动挡位与现值已一致，免写回`);
            return;
        }
        await live.update(patch);
        say(`[memory] 启动挡位写回初值: recall=${patch.recall ?? s.recall} capture=${patch.capture ?? s.capture} distill=${patch.distill ?? s.distill}`);
    }
    catch (err) {
        /* 写面不可用：保持持久值，启动不受影响——但从本版起不再静默 */
        warn(`[memory] 启动挡位应用失败(保持持久值): ${err instanceof Error ? err.message : String(err)}`);
    }
}
export function resolveSettings(value) {
    if (!value || typeof value !== 'object')
        return { ...ALWAYS_ON, distillChain: [] };
    const v = value;
    const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
    // #37:布尔键收到非 boolean(常见于手编 YAML 写成字符串 "true" 或数字 0)时,
    // 严格 === true 会静默判关——用户设置无声丢失。这里不改变判值方向(写删门宁紧勿松),
    // 但发一次诊断让「读回形状异常」可见而不是靠重启后开关回落来发现。
    const warnBadBoolean = (key, raw) => {
        if (raw === undefined || typeof raw === 'boolean')
            return;
        if (typeof console !== 'undefined')
            console.warn(`[memory] live.${key} 持久化值形状异常(期望 boolean,得到 ${typeof raw}),已按关闭处理:`, raw);
    };
    for (const key of ['memoryMutate', 'conflictFreeze', 'skillsEnabled', 'graphEnabled', 'keywordEnabled', 'redistillEnabled', 'mdSyncEnabled', 'memportEnabled', 'validityTiering'])
        warnBadBoolean(key, v[key]);
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
    // 启动挡位拆两轴：缺键/非法值均归 'off'(出厂默认关闭)。挡位本身**不在读侧折叠**——
    // 启动期由 `applyBootMode` 把初值写回 recall / capture+distill，这样本会话的手动开关永远有效。
    const normBoot = (x) => x === 'on' || x === 'off' || x === 'last' ? x : 'off';
    const injectBootMode = normBoot(v.injectBootMode);
    const extractBootMode = normBoot(v.extractBootMode);
    return {
        injectBootMode,
        extractBootMode,
        // 总闸不再作为面板顶控；钉为 true，行为由 recall / capture / distill 三键接管。
        // 旧 profile 里 enabled=false 的遗留值会被这里抹平（一次性迁移，不阻断）。
        enabled: true,
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
        // R10 蒸馏超时运行时覆盖：钳 0~600000（与 live schema 同上限）；0 = 跟随部署 llm.timeoutMs
        distillTimeoutMs: Math.min(600_000, Math.max(0, num(v.distillTimeoutMs))),
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
        // 轨2 技能结晶:严格 === true(默认关,新功能默认关)
        skillsEnabled: v.skillsEnabled === true,
        // 知识图谱投影:严格 === true(默认关);与部署 graph.enabled 取或后生效
        graphEnabled: v.graphEnabled === true,
        // 存量回填/进阶功能启用开关:严格 === true(默认关)
        keywordEnabled: v.keywordEnabled === true,
        redistillEnabled: v.redistillEnabled === true,
        mdSyncEnabled: v.mdSyncEnabled === true,
        memportEnabled: v.memportEnabled === true,
        validityTiering: v.validityTiering === true,
        explorerEnabled: v.explorerEnabled !== false, // 默认 true，只有显式 false 才关
        // md 投射护栏钳 0~10000（与 live schema 同上限）；0 = 跟随部署默认
        mdExportMaxRecords: Math.min(10_000, Math.max(0, num(v.mdExportMaxRecords))),
        // 回填并行度钳 0~8（与 live schema 同上限）；0 = 跟随部署 cfg.backfill.concurrency
        backfillConcurrency: Math.min(8, Math.max(0, Math.floor(num(v.backfillConcurrency)))),
        // 工具分组封印:严格 !== false(缺省/异常值 = 未封印,工具照常注册)
        toolRoom: v.toolRoom !== false,
        toolGraph: v.toolGraph !== false,
        toolRuminate: v.toolRuminate !== false,
        toolConflict: v.toolConflict !== false,
        toolMutate: v.toolMutate !== false,
        toolSkills: v.toolSkills !== false,
        // 默认封印组:方向相反——缺字段/异常值都视为封印(false 才开)。
        toolGraphAdmin: v.toolGraphAdmin === true,
        toolLegacy: v.toolLegacy === true,
        // 外部同步运行时开关:档位白名单与 schema 同源（非法值 = 跟随部署）;三布尔严格 === true
        extSyncMode: v.extSyncMode === 'shadow-read' || v.extSyncMode === 'push-only' || v.extSyncMode === 'two-way'
            ? v.extSyncMode
            : '',
        extPushEnabled: v.extPushEnabled === true,
        extPullEnabled: v.extPullEnabled === true,
        extAllowHardDelete: v.extAllowHardDelete === true,
        // 隔离闸方向相反：关才关（!== false），缺字段/异常值都视为开——防污染应当默认生效。
        extImportIsolate: v.extImportIsolate !== false,
    };
}
