/**
 * 图谱节点检索(纯函数,无 I/O):字段加权重叠计分 + 可解释命中输出。
 *
 * 与 L1 检索(FTS5/向量)不同,图谱节点量级是"可重建投影"的百~千级,在此
 * 直接内存打分即可,不建倒排索引(>2k 节点再考虑预建)。
 *
 * ── 图谱演进阶梯(阈值触发,非按需猜测)──────────────────────────────
 * 图谱是 L0 → L1 → 图谱 链上的可重建派生投影(不是事实源),故存储引擎**可随时替换,
 * 且是重建而非迁移**——这是当前不引入图数据库不会锁死将来的核心依据。
 * 本阶梯把"何时才该升级"固化成可判定的阈值,避免提前引入重型方案:
 *
 *   Tier  能力                                          存储      触发阈值                  成本
 *   T0    邻接表 + 字段加权打分(即本文件)               SQLite    nodes 10²~10³(现状)      已有
 *   T1    TS 内存 BFS/DFS:k-hop/最短路径/连通分量       **不变**  nodes ≤ ~10k             纯 TS,零 schema 变更
 *                                                                edges ≤ ~100k(=T1 上限)
 *   T2    递归 CTE(不物化全图)                          **不变**  图装不进内存              复杂 SQL + 手工防环
 *   T3    闭包表/物化路径(传递闭包预计算)               **不变**  高频多跳重复查询          写放大,边变更需维护
 *   T4    嵌入式图引擎(Kuzu 优先,非 Neo4j)              换引擎    T1-T3 全部不足            原生依赖,破坏自包含
 *
 * **2k 节点** = 预建倒排索引的检查点(上方既有判断);**10k / 100k** = T1 内存遍历的上限。
 *
 * **注意**:10k 节点 / 100k 边是**按内存占用推算的估算值**(10 万边 × ~100 字节 ≈ 10 MB),
 * **非实测**,待真实规模数据校准。多跳遍历归 TS 纯函数层,**不使用 `WITH RECURSIVE`**。
 *
 * 设计要点:
 * - 分词与 L0/L1 共用 util/text.ts 的 tokenize(jieba 词 ∪ 拉丁词 ∪ CJK 二元组),
 *   查询与文档两侧同源;
 * - 字段加权:name×6 / aliases×5 / tags×5 / currentState×4 / facts×4 /
 *   relations×3 / type×2——名称是实体最强身份信号,关系词最弱(邻接噪声);
 * - facts 只拼 active(superseded 是历史,不该让旧状态把节点拉进结果);
 * - relations 只取 active 边(superseded 的旧关系同理);
 * - "仅关系词命中"的结果过滤丢弃:只命中关系名的节点通常是邻接噪声
 *   (type-only 命中仍保留,保证按"项目/工具"等类型搜索可用);
 * - score 只用于排序,不是事实置信度;无词法命中返回空,不兜底。
 */
import { tokenize } from '../util/text.js';
import type { GraphEdge, GraphNode, GraphNodeSearchResult } from './types.js';
import { GRAPH_SEARCH_LIMIT_MAX } from './types.js';

/** 字段权重(检索命中计分;名称最高、关系词最低)。 */
export const GRAPH_FIELD_WEIGHTS = {
  name: 6,
  aliases: 5,
  tags: 5,
  currentState: 4,
  facts: 4,
  relations: 3,
  type: 2,
} as const;

type SearchField = keyof typeof GRAPH_FIELD_WEIGHTS;

/** matchedFields 的中文标签(matchReason 组装)。 */
const FIELD_LABELS: Record<SearchField, string> = {
  name: '名称',
  aliases: '别名',
  tags: '标签',
  currentState: '当前状态',
  facts: '事实',
  relations: '关系',
  type: '类型',
};

const FIELD_ORDER: SearchField[] = ['name', 'aliases', 'tags', 'currentState', 'facts', 'relations', 'type'];

/** fact 值渲染进检索文本(数组值空格连接)。 */
function factValueText(value: string | string[]): string {
  return Array.isArray(value) ? value.join(' ') : value;
}

/**
 * 图谱节点检索:返回按 score 降序的命中(最多 limit 条;limit 钳制 1~20)。
 * 候选节点 = active | disputed(superseded/archived 不进检索)。
 */
export function searchGraphNodes(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  query: string,
  limit: number,
): GraphNodeSearchResult[] {
  const tokens = [...new Set(tokenize(query))];
  const cappedLimit = Math.min(Math.max(Math.floor(limit) || 5, 1), GRAPH_SEARCH_LIMIT_MAX);
  if (tokens.length === 0) return [];

  // nodeId → active 关系词 token 集(先建邻接表,防逐节点全量扫边)
  const relationTokensByNode = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.status !== 'active') continue;
    let set = relationTokensByNode.get(edge.fromNodeId);
    if (!set) {
      set = new Set();
      relationTokensByNode.set(edge.fromNodeId, set);
    }
    for (const t of tokenize(edge.relation)) set.add(t);
    let set2 = relationTokensByNode.get(edge.toNodeId);
    if (!set2) {
      set2 = new Set();
      relationTokensByNode.set(edge.toNodeId, set2);
    }
    for (const t of tokenize(edge.relation)) set2.add(t);
  }

  const results: GraphNodeSearchResult[] = [];
  for (const node of nodes) {
    if (node.status !== 'active' && node.status !== 'disputed') continue;
    const fieldTokens: Record<SearchField, Set<string>> = {
      name: new Set(tokenize(node.name)),
      aliases: new Set(node.aliases.flatMap((a) => tokenize(a))),
      tags: new Set((node.tags ?? []).flatMap((t) => tokenize(t))),
      currentState: new Set(tokenize(node.currentState)),
      facts: new Set(
        node.facts
          .filter((f) => f.status === 'active')
          .flatMap((f) => tokenize(`${f.key} ${factValueText(f.value)}`)),
      ),
      relations: relationTokensByNode.get(node.id) ?? new Set(),
      type: new Set(tokenize(node.type)),
    };

    let score = 0;
    const matchedFields: SearchField[] = [];
    const matchedTokens = new Set<string>();
    for (const field of FIELD_ORDER) {
      let hits = 0;
      for (const t of tokens) {
        if (fieldTokens[field].has(t)) {
          hits++;
          matchedTokens.add(t);
        }
      }
      if (hits > 0) {
        score += GRAPH_FIELD_WEIGHTS[field] * hits;
        matchedFields.push(field);
      }
    }
    // 无命中跳过;仅关系词命中 = 邻接噪声,过滤丢弃(type-only 保留)
    if (matchedFields.length === 0) continue;
    if (matchedFields.length === 1 && matchedFields[0] === 'relations') continue;
    const matchReason = `命中${matchedFields.map((f) => FIELD_LABELS[f]).join('/')}「${[...matchedTokens].slice(0, 4).join('、')}」`;
    results.push({ node, score, matchedFields, matchReason });
  }

  results.sort((a, b) => b.score - a.score || (a.node.updatedAt < b.node.updatedAt ? 1 : a.node.updatedAt > b.node.updatedAt ? -1 : a.node.id < b.node.id ? -1 : 1));
  return results.slice(0, cappedLimit);
}
