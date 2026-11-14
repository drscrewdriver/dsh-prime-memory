/** 9 家驱动类型的唯一清单(配置面 `ext_memory.drivers[].type` 的合法值)。 */
export const EXT_DRIVER_TYPES = [
    'mem0',
    'hindsight',
    'openviking',
    'honcho',
    'retaindb',
    'supermemory',
    'holographic',
    'byterover',
    'mnemon-native',
];
/** 同步档位(消费侧归一,配置面**不用 union**——ADR-0008 条 4:schemastery 对非法值抛错的故障半径是整棵配置树)。 */
export const EXT_SYNC_MODES = ['shadow-read', 'push-only', 'two-way'];
/** 归一 sync_mode:非法/缺省 → 'shadow-read'(风险最低档)。 */
export function normSyncMode(raw) {
    return EXT_SYNC_MODES.includes(String(raw)) ? raw : 'shadow-read';
}
/**
 * md 投射 × 外部同步共存门控(T4.2)。
 *
 * 危险面是 **two-way**:外部回灌改库 → 投射把库渲染进文件,而文件侧手改又回灌库
 * ——两套写面在同一条记录的正文上互相触发,写回环与丢改并存。故 two-way 与
 * memExport 同开时**硬降 shadow-read**(融合不丢:检索仍能融合外部,只是不再出/回写)。
 *
 * push-only 保留:它只把库内容推向远端、不反向改库,与文件面无写竞争。
 */
export function applyCoexistGate(input) {
    const base = normSyncMode(input.syncMode);
    if (input.extMemoryEnabled && input.memExportEnabled && base === 'two-way') {
        return {
            syncMode: 'shadow-read',
            notice: 'md 投射与外部双向同步同开:双向已降为 shadow-read(两套写面同时回写同一条正文会打架)。要恢复双向请先关 memExport。',
        };
    }
    return { syncMode: base };
}
/** 该驱动可否参与双向同步(影子/推送/拉取)。byterover 恒 false。 */
export function canSync(cap) {
    return cap.addressing !== 'synthetic-block' && cap.freshness !== 'none';
}
/** 该驱动可否接收删除同步(退场传导)。 */
export function canForget(cap) {
    return cap.forget && cap.deletionMode !== 'unsupported';
}
/** 必需核对所有家一致。 */
const CORE_METHODS = ['status', 'search', 'remember'];
function spec(typeId, transport, capabilities, scoreSemantics) {
    const required = [...CORE_METHODS];
    if (capabilities.forget)
        required.push('forget');
    if (capabilities.browse)
        required.push('list');
    if (capabilities.graph)
        required.push('graph');
    if (capabilities.related)
        required.push('graph');
    if (capabilities.link)
        required.push('link');
    // 不再从 freshness==='cursor' 推导 sincePull：那会迫使未接游标的家也放一个会抛错的桩，
    // 于是「方法存在」变成恒真判据，拉取分支永远走错路（见 DriverCapabilities.incremental）。
    if (capabilities.incremental)
        required.push('sincePull');
    return { typeId, transport, capabilities, scoreSemantics, requiredMethods: [...new Set(required)] };
}
/** 逐家能力矩阵(唯一事实源;配置校验、面板展示、装配校验三方共用)。 */
export const EXT_DRIVER_SPECS = {
    mem0: spec('mem0', 'http', {
        search: true, browse: true, graph: false, related: false, link: false, remember: true, forget: true,
        writeMode: 'async-extracting', deletionMode: 'hard', addressing: 'stable-id', freshness: 'full-scan',
        incremental: false, paged: true,
        rateLimit: { burst: 10, sustainedPerSec: 1 },
    }, 'normalized-relevance'),
    hindsight: spec('hindsight', 'http', {
        search: true, browse: true, graph: true, related: true, link: false, remember: true, forget: true,
        writeMode: 'async-extracting', deletionMode: 'soft', addressing: 'stable-id', freshness: 'cursor',
        // freshness 说“服务端有游标可用”，incremental 说“本驱动接了”——两者现在不等价。
        incremental: false, paged: true,
    }, 'normalized-relevance'),
    openviking: spec('openviking', 'http', {
        search: true, browse: true, graph: false, related: false, link: false, remember: true, forget: true,
        writeMode: 'async-extracting', deletionMode: 'hard', addressing: 'uri', freshness: 'full-scan',
        // fs/ls 是树遍历、一次给全（无 offset 语义）：paged=false 让面板如实说“单页”。
        incremental: false, paged: false,
    }, 'normalized-relevance'),
    honcho: spec('honcho', 'http', {
        search: true, browse: true, graph: false, related: false, link: false, remember: true, forget: true,
        writeMode: 'exact', deletionMode: 'hard', addressing: 'stable-id', freshness: 'full-scan',
        incremental: false, paged: true,
    }, 'none'),
    retaindb: spec('retaindb', 'http', {
        search: true, browse: true, graph: false, related: false, link: false, remember: true, forget: true,
        writeMode: 'exact', deletionMode: 'hard', addressing: 'stable-id', freshness: 'full-scan',
        // profile/collection 两形态都没给出分页参数：宁可声明 paged=false，由 listAll 单页到底。
        incremental: false, paged: false,
    }, 'normalized-relevance'),
    supermemory: spec('supermemory', 'http', {
        search: true, browse: true, graph: false, related: false, link: false, remember: true, forget: true,
        writeMode: 'async-extracting', deletionMode: 'soft', addressing: 'stable-id', freshness: 'cursor',
        incremental: false, paged: true,
    }, 'normalized-relevance'),
    holographic: spec('holographic', 'local-file', {
        search: true, browse: true, graph: true, related: true, link: false, remember: true, forget: true,
        writeMode: 'exact', deletionMode: 'hard', addressing: 'content-hash', freshness: 'cursor',
        incremental: false, paged: true,
    }, 'normalized-relevance'),
    byterover: spec('byterover', 'cli', {
        search: true, browse: false, graph: false, related: false, link: false, remember: true, forget: false,
        writeMode: 'async-extracting', deletionMode: 'unsupported', addressing: 'synthetic-block', freshness: 'none',
        incremental: false, paged: false,
    }, 'normalized-relevance'),
    'mnemon-native': spec('mnemon-native', 'cli', {
        search: true, browse: true, graph: true, related: true, link: true, remember: true, forget: true,
        writeMode: 'exact', deletionMode: 'soft', addressing: 'stable-id', freshness: 'cursor',
        // CLI recall 只有 --limit、无 offset：单页到底，面板必须如实说明导入上限 = 单页。
        incremental: false, paged: false,
    }, 'normalized-relevance'),
};
/** 按能力表取一个实例上必须存在的方法名集合(T0.2 消费;导出以便单测复用)。 */
export function requiredMethodsOf(cap) {
    return [...spec('mem0', 'http', cap, 'none').requiredMethods];
}
