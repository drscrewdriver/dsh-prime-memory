/**
 * 存量图谱清扫(v0.26.58,本体论落地计划的第二把刀)。
 *
 * 为什么必需:投影闸门(apply.ts)是**入口过滤器**——只拦新提案,从不回写已有行。
 * 于是 v2 全库重投跑完后,R3/R4 的两类脏存量(路径名 place、泛称裸角色节点)仍然
 * 躺在表里,指标不动。本模块在同一批纯判据(isPathLike/isRoleName/splitQualified/
 * isAliasShaped/normalizeFactKey)上**反扫存量**,让 v2 的收敛在库上真正成立。
 *
 * 五条规则与投影侧严格同源(同函数同口径,防两处判据漂移):
 *  ① 泛称裸角色节点 → `archived`(person/organization 无限定名且命中角色词表);
 *     带限定名(用户@DSH)的一律保留——那正是 R4 要的分离。
 *  ② 路径名 place → 改名末段 + tag `路径`(与 tool 路径保留同处理,不删信息)。
 *  ③ 别名 → 只留写法变体(isAliasShaped:路径样与描述性短语一律剔除)。
 *  ④ fact key → 同义映射归一(GRAPH_FACT_KEY_SYNONYMS),归一后仍不在规范词表的
 *     节点补 tag `未规范`(与 apply 的打标同式,供收敛率统计)。
 *  ⑤ currentState 按 active facts 重建——与 apply 的重建式逐字一致。
 *
 * 生命周期与可逆性:本模块**不新增状态词**,只用 GRAPH_STATUSES 里既有的 archived
 * (R5 语义:图谱是派生投影,清扫只是把投影结果重新收敛)。读侧三处可见性判据
 * (preview/select/record-links 的 isGraphNodeVisible)只放行 active/disputed,故
 * 归档即刻从画布/检索/关联反查退场;L1 事实源不动,需要还原时 memory_graph_admin
 * rebuild 会连凭证一起作废、从 L1 全量重投。
 *
 * 边界:① 边一律不动——边可见性由两端状态决定,读侧已有闸,归档端点即断链;
 * ② 概念行只清别名与 key、只报告重复组不自动合并(改名会牵动边指向,实测零重名,
 *    不值得为此引入风险);③ 幂等:再跑一次命中判据的行为是「无命中」。
 */
import { isCanonicalFactKey, normalizeEntityName, normalizeFactKey } from './apply.js';
import { GRAPH_CAP } from './constraints.js';
import { isAliasShaped, isPathLike, isRoleName, splitQualified } from './entity-identity.js';
/** 空报告(前置条件不满足时返回,调用方无需判空)。 */
function emptyReport() {
    return {
        scanned: 0, bareRoleArchived: 0, placeRenamed: 0, placeUnrenamed: 0, aliasesPruned: 0,
        factsRenamed: 0, nodesUncanon: 0, statesRebuilt: 0, conceptDups: 0,
        archivedFacts: 0, archivedMaxFacts: 0, bareRoleQualified: 0, bareRoleBlocked: 0,
        vecRowsPruned: 0,
        archivedIds: [], touchedIds: [], touchedConceptIds: [], archivedSamples: [],
    };
}
/**
 * 泛称节点的「枢纽」阈值:活跃 fact 数 ≥ 20 就不当作杂散泛称处理。
 * 20 取自线上分布——真泛称(团队/AI代理/执行分析的助手)承载 2–9 条,而 `用户`
 * 158 条、`AI` 66 条;两者之间没有歧义带。
 */
const HUB_FACTS = 20;
const TAG_PATH = '路径';
const TAG_UNCANON = '未规范';
/** 可见节点(与读侧 isGraphNodeVisible 同判据:active/disputed 才参与当前图)。 */
function inScope(status) {
    return status === 'active' || status === 'disputed';
}
/**
 * 就地清扫存量图(纯函数,无 I/O;变异传入的 nodes/concepts,与 apply 同风格)。
 *
 * @param options.nodes - 全量节点(含 archived;只动可见行)。
 * @param options.concepts - 概念行(③④ 同样适用)。
 * @param options.now - ISO 时间戳(写 updatedAt 用,由调用方注入以保证可测)。
 */
export function sweepStockGraph(options) {
    const { nodes, concepts = [], now } = options;
    const report = emptyReport();
    // 可见面的归一名字集:限定名改之前查冲突,避免把两个泛称改成同一个名字。
    const visibleNames = new Set(nodes.filter((n) => inScope(n.status)).map((n) => normalizeEntityName(n.name)));
    /** 归档一个泛称节点并记账(退场物质一并上报,见 GraphSweepReport.archivedFacts)。 */
    const archiveHub = (node, liveFacts) => {
        node.status = 'archived';
        node.updatedAt = now;
        report.bareRoleArchived++;
        report.archivedFacts += liveFacts;
        if (liveFacts > report.archivedMaxFacts)
            report.archivedMaxFacts = liveFacts;
        report.archivedIds.push(node.id);
        if (report.archivedSamples.length < 10)
            report.archivedSamples.push(node.name);
    };
    for (const node of nodes) {
        if (!inScope(node.status))
            continue;
        report.scanned++;
        let changed = false;
        // ① 泛称裸角色:判据与 apply.ts 同式(无限定名 + 命中角色词表)。退场方式分两路——
        //   承载少的(杂散泛称)→ 归档;承载 ≥ HUB_FACTS 的(`用户`/`AI` 这类偏好汇聚点)
        //   → 按 R4 的正面解法改**限定名** `名字@family`,保留在图上。理由:指标要 0 很
        //   容易,但把带 158 条 fact 的枢纽归档,等于为了让 bareRole 变绿而把图谱最有
        //   内容的部分请出去——那不是收敛,是数字游戏。
        if ((node.type === 'person' || node.type === 'organization') && !splitQualified(node.name).qualifier && isRoleName(node.name)) {
            const liveFacts = node.facts.filter((f) => f.status === 'active' || f.status === 'disputed').length;
            const family = (node.families ?? [])[0]?.trim();
            const qualified = family ? `${node.name}@${family}` : undefined;
            if (liveFacts >= HUB_FACTS && qualified && qualified.length <= GRAPH_CAP.name) {
                const target = normalizeEntityName(qualified);
                if (!visibleNames.has(target)) {
                    visibleNames.add(target);
                    node.name = qualified;
                    node.updatedAt = now;
                    report.bareRoleQualified++;
                    changed = true;
                    // 限定后不再归档:继续走 ③④⑤(别名/key/状态串照样收敛)。
                }
                else {
                    report.bareRoleBlocked++; // 目标名已被占:不静默改名,退回归档分支
                    archiveHub(node, liveFacts);
                    continue;
                }
            }
            else {
                archiveHub(node, liveFacts);
                continue; // 归档行不再改名/清别名:历史原样留存
            }
        }
        // ② 路径名 place:改名为末段并打 `路径` tag(与 tool 路径保留同处理,不删信息)。
        if (node.type === 'place' && isPathLike(node.name)) {
            const leaf = (node.name.replace(/[\\/]+$/, '').split(/[\\/]+/).pop() ?? '').trim().replace(/^[\s.:_-]+|[\s.:_-]+$/g, '');
            if (leaf && !isPathLike(leaf)) {
                node.name = leaf.slice(0, 160);
                const tags = node.tags ?? (node.tags = []);
                if (!tags.includes(TAG_PATH))
                    tags.push(TAG_PATH);
                report.placeRenamed++;
                changed = true;
            }
            else {
                report.placeUnrenamed++;
            }
        }
        // ③ 别名:只留写法变体(路径样/描述性短语剔除;与 apply 入档判据同式)。
        const keptAliases = (node.aliases ?? []).filter((alias) => isAliasShaped(alias) && normalizeEntityName(alias) !== normalizeEntityName(node.name));
        if (keptAliases.length !== (node.aliases ?? []).length) {
            report.aliasesPruned += (node.aliases ?? []).length - keptAliases.length;
            node.aliases = keptAliases;
            changed = true;
        }
        // ④ fact key:同义归一 + 表外补节点级 tag(与 apply 打标同式)。
        const tags = node.tags ?? (node.tags = []);
        for (const fact of node.facts) {
            if (fact.status === 'superseded' || fact.status === 'archived')
                continue;
            const canonical = normalizeFactKey(fact.key);
            if (canonical !== fact.key) {
                fact.key = canonical;
                report.factsRenamed++;
                fact.updatedAt = now;
                changed = true;
            }
            if (!isCanonicalFactKey(canonical) && !tags.includes(TAG_UNCANON))
                tags.push(TAG_UNCANON);
        }
        // ⑤ currentState:按 active facts 重建(式子与 apply 逐字一致)。
        const rebuilt = node.facts
            .filter((f) => f.status === 'active')
            .map((f) => `${f.key}: ${Array.isArray(f.value) ? f.value.join('、') : f.value}`)
            .join('\n');
        if (rebuilt !== node.currentState) {
            node.currentState = rebuilt;
            report.statesRebuilt++;
            changed = true;
        }
        if (changed) {
            node.updatedAt = now;
            report.touchedIds.push(node.id);
        }
        if (tags.includes(TAG_UNCANON))
            report.nodesUncanon++;
    }
    // 概念行:同一把尺清别名与 key(分类不猜、定义不编——只收敛,不生成)。
    const seenConcept = new Set();
    for (const concept of concepts) {
        if (!inScope(concept.status))
            continue;
        const dupKey = `${normalizeEntityName(concept.name)}|${concept.category}`;
        if (seenConcept.has(dupKey))
            report.conceptDups++;
        else
            seenConcept.add(dupKey);
        let changed = false;
        const kept = (concept.aliases ?? []).filter((a) => isAliasShaped(a) && normalizeEntityName(a) !== normalizeEntityName(concept.name));
        if (kept.length !== (concept.aliases ?? []).length) {
            report.aliasesPruned += (concept.aliases ?? []).length - kept.length;
            concept.aliases = kept;
            changed = true;
        }
        for (const fact of concept.facts ?? []) {
            if (fact.status === 'superseded' || fact.status === 'archived')
                continue;
            const canonical = normalizeFactKey(fact.key);
            if (canonical !== fact.key) {
                fact.key = canonical;
                report.factsRenamed++;
                fact.updatedAt = now;
                changed = true;
            }
        }
        if (changed) {
            concept.updatedAt = now;
            report.touchedConceptIds.push(concept.id);
        }
    }
    return report;
}
