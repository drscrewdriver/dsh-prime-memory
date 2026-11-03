/**
 * 记忆库入口的关联跳转(读路径纯函数):L1 记录 → 实体 → 关系 → 其它记录。
 *
 * 为什么必须绕图投影:`l1_records` 的 DDL 是逐字节冻结的磁盘契约,记录行里
 * **没有任何 relation/edges 字段**,L1 记录也不是图的顶点。所以"这条记忆和哪些
 * 记忆相关"只能经 `graph_nodes/graph_edges` 的 `sourceRecordIds` **反查**得出——
 * 关系是投影出来的,不是存出来的。反查一律在内存里做(`sourceRecordIds.includes`),
 * 不走 SQL `LIKE '%"id"%'`:图谱量级为可重建投影(百~千级),全表读本就发生在上层
 * `loadGraph`,内存扫描零成本;而 LIKE 匹配 JSON 文本有前缀误配风险。
 *
 * 三条不变式:
 *   1) 只读:本文件不查库、不落库、不建边、不改投影——写面一律走既有 reproject 缝;
 *   2) 判据与预览/检索同源:候选 = active|disputed 节点 × active 边(见 preview.visible);
 *   3) 确定性 = 同输入两次调用逐位一致,同分裁决链落到 id 升序兜底。
 */
import { GRAPH_CAUSAL_RELATIONS, isGraphNodeVisible } from './constraints.js';
import { degreeMaps } from './preview.js';
const CAUSAL_SET = new Set(GRAPH_CAUSAL_RELATIONS);
/** 关联跳转的缺省条数上限(邻居与回落记录各吃一份)。 */
export const RECORD_LINKS_LIMIT_DEFAULT = 60;
/** 条数硬钳制上界(与 list-records 的单页上限同量级,再大没有可读性)。 */
export const RECORD_LINKS_LIMIT_MAX = 200;
/** 跳数上界:2 跳足够看清"经由谁连到谁";3 跳在百级图上是全图,在千级图上是噪声。 */
export const RECORD_LINKS_HOPS_MAX = 2;
/**
 * 每个实体/邻居随带的来源记录预览条数(保最新)。
 *
 * 没有它,第三层「点邻居 → 跳到那条记录」就断了:面板拿到邻居 id 却不知道它
 * 的来源是谁,只能再发一次 graph-node-get。截 5 条是为了不把整条来源链(上限 128)
 * 塞进一个列表项。
 */
export const RECORD_LINKS_SOURCE_PREVIEW = 5;
/** 与预览同源的可见性判据(单源在 constraints)。 */
const visible = isGraphNodeVisible;
/** updatedAt 新(大)先;ISO 字符串可直接字典序比较。 */
function byRecency(a, b) {
    if (a.updatedAt !== b.updatedAt)
        return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
}
/** 来源预览:保最新尾部截断,并排除起点自身(它已在层1 展示)。 */
function previewSources(node, excludeId) {
    const keep = node.sourceRecordIds.filter((r) => r !== excludeId);
    return keep.length > RECORD_LINKS_SOURCE_PREVIEW ? keep.slice(-RECORD_LINKS_SOURCE_PREVIEW) : keep;
}
/**
 * 主函数。`recordId` 命中零个实体时返回全空结构(不抛)——这条记录还没被投影进图
 * (图谱默认关闭 / 投影未跑到 / 该记录无可抽实体),都是正常态而非错误态。
 */
export function buildRecordLinks(nodes, edges, recordId, opts = {}) {
    const empty = { entities: [], neighbors: [], neighborRecordIds: [], truncated: false };
    const id = String(recordId ?? '').trim();
    if (!id)
        return empty;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const dm = degreeMaps(nodes, edges);
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? RECORD_LINKS_LIMIT_DEFAULT), 1), RECORD_LINKS_LIMIT_MAX);
    const hops = Math.min(Math.max(Math.floor(opts.hops ?? 1), 1), RECORD_LINKS_HOPS_MAX);
    const visEdges = edges.filter((e) => e.status === 'active');
    // ── 层2:反查该记录作为来源的实体 ────────────────────────────
    const entityNodes = nodes
        .filter((n) => visible(n) && n.sourceRecordIds.includes(id))
        .sort((a, b) => {
        const da = dm.degree.get(a.id) ?? 0;
        const db = dm.degree.get(b.id) ?? 0;
        if (da !== db)
            return db - da;
        return byRecency(a, b);
    });
    if (entityNodes.length === 0)
        return empty;
    const entities = entityNodes.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        degree: dm.degree.get(n.id) ?? 0,
        causalDegree: dm.causal.get(n.id) ?? 0,
        recordIds: previewSources(n, id),
    }));
    // ── 层3:沿 active 边逐跳展开(visited 防环;起点实体自身不重复入列) ──
    let frontier = entityNodes;
    /** 起点实体集:它们已在层2 展示过,不再当作「关联项」绕回来重复列出。 */
    const entitySet = new Set(entityNodes.map((n) => n.id));
    const seen = new Set([...entitySet]);
    const rows = [];
    /** 排名序的节点集(回落记录按它取,保证"越相关的邻居的来源越先出现")。 */
    const rankedNodes = [...entityNodes];
    for (let hop = 1; hop <= hops; hop += 1) {
        const next = [];
        for (const center of frontier) {
            for (const e of visEdges) {
                let otherId;
                if (e.fromNodeId === center.id)
                    otherId = e.toNodeId;
                else if (e.toNodeId === center.id)
                    otherId = e.fromNodeId;
                else
                    continue;
                const o = byId.get(otherId);
                if (!o || !visible(o))
                    continue;
                if (entitySet.has(o.id))
                    continue; // 环状图不把起点实体列成自己的邻居
                rows.push({
                    id: o.id,
                    name: o.name,
                    type: o.type,
                    relation: e.relation,
                    causal: CAUSAL_SET.has(e.relation),
                    viaEntityId: center.id,
                    degree: dm.degree.get(o.id) ?? 0,
                    hop,
                    recordIds: previewSources(o, id),
                    _upd: o.updatedAt,
                });
                if (!seen.has(o.id)) {
                    seen.add(o.id);
                    next.push(o);
                }
            }
        }
        rankedNodes.push(...next);
        frontier = next;
        if (next.length === 0)
            break;
    }
    rows.sort((a, b) => {
        if (a.causal !== b.causal)
            return a.causal ? -1 : 1;
        if (a.hop !== b.hop)
            return a.hop - b.hop;
        if (a.degree !== b.degree)
            return b.degree - a.degree;
        if (a._upd !== b._upd)
            return a._upd < b._upd ? -1 : 1;
        if (a.id !== b.id)
            return a.id < b.id ? -1 : 1;
        return a.viaEntityId < b.viaEntityId ? -1 : 1;
    });
    const neighborsTruncated = rows.length > limit;
    const kept = rows.slice(0, limit);
    const neighbors = kept.map(({ _upd, ...row }) => row);
    // ── 回落到记录:入选邻居 + 起点实体的来源记录,去重并排除起点自身 ──
    const pickedIds = [];
    const taken = new Set([id]);
    let recordsTruncated = false;
    for (const node of rankedNodes) {
        for (const rid of node.sourceRecordIds) {
            if (taken.has(rid))
                continue;
            if (pickedIds.length >= limit) {
                recordsTruncated = true;
                break;
            }
            taken.add(rid);
            pickedIds.push(rid);
        }
        if (recordsTruncated)
            break;
    }
    return {
        entities,
        neighbors,
        neighborRecordIds: pickedIds,
        truncated: neighborsTruncated || recordsTruncated,
    };
}
