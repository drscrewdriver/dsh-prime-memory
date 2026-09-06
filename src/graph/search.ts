/**
 * 图谱节点检索(纯函数,无 I/O):字段加权重叠计分 + 可解释命中输出。
 *
 * 与 L1 检索(FTS5/向量)不同,图谱节点量级是"可重建投影"的百~千级,在此
 * 直接内存打分即可,不建倒排索引(>2k 节点再考虑预建——见规划可延后清单)。
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
