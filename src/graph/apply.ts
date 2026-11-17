/**
 * 投影提案硬校验与落库语义(纯函数,无 I/O)。
 *
 * 这是图谱最核心的守门代码,唯一不变量:**零无来源事实**——每个节点/fact/边的
 * sourceRecordIds 必须非空且全部属于本 job 认领的记录批次,否则整条提案静默丢弃。
 * 图谱里不存在无法回溯到 L1 记录(进而到 JSONL 事实源)的结论。
 *
 * 其余语义:
 * - 实体消歧:normalizeEntityName(NFKC + 小写 + 去空白/下划线/连字符)归一后同名
 *   且类型一致才合并(别名累积去重);子串包含不算同一实体;
 * - 状态历史:同 key 的新 fact 把旧 active fact 标 superseded 并闭合 validTo;
 *   同 (from,relation) 指向新目标的旧边同样 supersede——保留时间区间,不覆盖历史;
 * - currentState 只由 active facts 重建;
 * - 时间锚四级链:activity_start_time → activity_end_time → timestamps 最新 →
 *   createdAt,跨来源取最晚(ISO);无任何证据时才落到 now,不猜日期。
 *
 * 函数直接变异传入的 nodes/edges(merge scope),返回 touched id 集合——调用方
 * (GraphStore.complete)在单事务内 load scope → apply → 写回,LLM 调用永远
 * 不发生在该事务内。
 */
import { familyForType } from '../types.js';
import {
  clampConceptCategory,
  isAliasShaped,
  isPathLike,
  isRoleName,
  splitQualified,
} from './entity-identity.js';
import type { MemoryFamily, MemoryRecord } from '../types.js';
import {
  GRAPH_CAP,
  GRAPH_FACT_KEYS,
  GRAPH_FACT_KEY_SYNONYMS,
  GRAPH_NODE_TYPE_SET,
  GRAPH_SOURCE_RECORDS_CAP,
  GRAPH_STATUS_SET,
} from './constraints.js';
import type {
  ConceptCategory,
  GraphConcept,
  GraphEdge,
  GraphFact,
  GraphNode,
  GraphProjectionResult,
  GraphRecordStatus,
} from './types.js';

export interface ApplyGraphProjectionOptions {
  /** 可变异的合并 scope(现有节点/边;调用方决定 scope 大小)。 */
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 可变异的概念 scope(独立表 graph_concepts 的内存形)。 */
  concepts?: GraphConcept[];
  /** 本批认领的记录(族判定与时间锚的证据来源)。 */
  records: readonly MemoryRecord[];
  result: GraphProjectionResult;
  allowedRecordIds: ReadonlySet<string>;
  /** 本次投影时刻(ISO;时间锚兜底与 updatedAt 的时间基准)。 */
  now: string;
  idFactory: (prefix: 'node' | 'edge' | 'gfact' | 'gconcept') => string;
}

export interface ApplyGraphProjectionOutcome {
  nodeIds: string[];
  edgeIds: string[];
  /** touched 概念 id(独立表写回输入)。 */
  conceptIds: string[];
  /** 因无来源/形状非法被丢弃的提案条数(节点+fact+边;诊断日志用)。 */
  dropped: number;
}

/** 字符串字段归一:trim、折叠空白、截断;非字符串一律空串。 */
function textOf(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : '';
}

/** 字符串数组字段归一:逐项截断去空、跨项去重、截到条数上限。 */
function stringsOf(value: unknown, itemCap: number, countCap: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const t = textOf(item, itemCap);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= countCap) break;
  }
  return out;
}

/** 置信度钳制:非法值回到 0.8 中性档(提案没填 = 模型默认自信度)。 */
function clampConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
}

/** 状态归一:非法值回 active(四态之外的表达一律不采信)。 */
function clampStatus(value: unknown): GraphRecordStatus {
  return typeof value === 'string' && GRAPH_STATUS_SET.has(value) ? (value as GraphRecordStatus) : 'active';
}

/**
 * 实体名归一(NFKC + 小写 + 去空白/下划线/连字符):全角/半角、大小写、
 * "张 三"与"张三"、"AI-agent"与"aiagent"视作同一实体的拼写变体。
 * 归一后空串返回原串(防止空名互相合并)。
 */
export function normalizeEntityName(name: string): string {
  const normalized = name.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
  return normalized || name;
}

/** 记录族兜底(record.family 缺失时按 type 前缀推导,与写入侧同一兜底链)。 */
function recordFamily(r: MemoryRecord): MemoryFamily {
  return r.family ?? familyForType(r.type);
}

/**
 * 时间锚:有效期为先,提及/入库时间为后。
 *
 * 逐条记录按六级证据取最晚,任何一级无法解析(缺字段/非法日期)即落到下一级:
 * validTo → validFrom(时间增强列,新写入路径)→ metadata.activity_end_time →
 * metadata.activity_start_time(列迁移前的存量数据)→ timestamps 最新 → createdAt。
 * 全部无证据才用 fallback(now),绝不猜测。
 *
 * task_2.6(expiry-tiering):兜底 now 分支回传 `'fallback_now'` 证据等级——供图谱侧
 * 同口径读时派生使用(落到 now 的 validFrom **不是**时间证据,与 activity_* 链的
 * 'evidence' 必须可区分;否则假过期与真过期同形)。
 */
export function anchorTimeFromRecordsDetailed(
  records: readonly MemoryRecord[],
  fallbackIso: string,
): { iso: string; source: 'evidence' | 'fallback_now' } {
  let latest = Number.NaN;
  const consider = (raw: unknown): void => {
    const t = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    if (Number.isFinite(t) && t > 0 && (Number.isNaN(latest) || t > latest)) latest = t;
  };
  for (const r of records) {
    // 时间增强列优先(新写入路径),再回落 metadata.activity_*(列迁移前的存量数据)
    consider(r.validTo);
    consider(r.validFrom);
    const meta = r.metadata as { activity_start_time?: unknown; activity_end_time?: unknown } | undefined;
    consider(meta?.activity_start_time);
    consider(meta?.activity_end_time);
    for (const t of r.timestamps ?? []) consider(t);
    consider(r.createdAt);
  }
  return Number.isNaN(latest)
    ? { iso: fallbackIso, source: 'fallback_now' }
    : { iso: new Date(latest).toISOString(), source: 'evidence' };
}

/** {@link anchorTimeFromRecordsDetailed} 的旧签名封装(调用方只要时刻时的零改动通道)。 */
export function anchorTimeFromRecords(records: readonly MemoryRecord[], fallbackIso: string): string {
  return anchorTimeFromRecordsDetailed(records, fallbackIso).iso;
}

/** 来源集并集封顶(保最新:新引用追加在尾部,溢出丢头部最老引用)。 */
function unionSourcesCapped(old: readonly string[], add: readonly string[]): string[] {
  const merged = [...new Set([...old, ...add])];
  return merged.length > GRAPH_SOURCE_RECORDS_CAP ? merged.slice(-GRAPH_SOURCE_RECORDS_CAP) : merged;
}

/** 同一实体判定:类型一致 + 名称/别名归一后的集合相交(子串包含不算)。 */
function isSameEntity(node: GraphNode, name: string, aliases: readonly string[], type: string): boolean {
  if (node.type !== type) return false;
  // v0.26.57 消歧升级:限定符参与身份比较——用户@DSH 与 用户@GitHub 是两个实体,
  // 用户@DSH 与 用户@dsh(NFKC/大小写/空白变体)是同一实体;无限定名不并入带限定名
  // (语境不明宁可分裂,不误合并)。同判据也用于概念合并(sameQualified)。
  return sameQualified(node, name, aliases);
}

/**
 * 同一概念判定:归一集合相交 + **限定符一致**(v0.26.57)。
 *
 * 限定名 `用户@DSH` 与 `用户@GitHub` 归一后 base 相同但不是同一实体——
 * 比较 (normalize(base), normalize(qualifier)) 二元组。概念合并只按名称/别名。
 */
function sameQualified(node: { name: string; aliases: readonly string[] }, name: string, aliases: readonly string[]): boolean {
  const want = splitQualified(name);
  const qWant = want.qualifier ? normalizeEntityName(want.qualifier) : '';
  const candidates = [node.name, ...node.aliases];
  for (const cand of candidates) {
    const got = splitQualified(cand);
    const qGot = got.qualifier ? normalizeEntityName(got.qualifier) : '';
    if (qGot !== qWant) continue;
    if (normalizeEntityName(got.base) === normalizeEntityName(want.base)) return true;
    if (aliases.some((alias) => {
      const ga = splitQualified(alias);
      return (ga.qualifier ? normalizeEntityName(ga.qualifier) : '') === qWant
        && normalizeEntityName(ga.base) === normalizeEntityName(got.base);
    })) return true;
  }
  return false;
}

/** fact key 规范化:trim/小写无关的中文 key 原样,命中同义映射替换;规范表外不动。 */
export function normalizeFactKey(key: string): string {
  const k = key.trim();
  return GRAPH_FACT_KEY_SYNONYMS[k] ?? k;
}
/** key 是否在规范词表内(表外保留但供统计收敛率)。 */
export function isCanonicalFactKey(key: string): boolean {
  return (GRAPH_FACT_KEYS as readonly string[]).includes(key) || key === '未规范';
}

/** 应用一次投影提案(硬校验 + 消歧 + supersede + 状态重建)。 */
export function applyGraphProjection(options: ApplyGraphProjectionOptions): ApplyGraphProjectionOutcome {
  const { nodes, edges, records, allowedRecordIds, now, idFactory } = options;
  const concepts = options.concepts ?? [];
  const refs = new Map<string, GraphNode>();
  const conceptRefs = new Map<string, GraphConcept>();
  const touchedConcepts = new Set<string>();
  const touchedNodes = new Set<string>();
  const touchedEdges = new Set<string>();
  let dropped = 0;

  /** 来源引用校验:非空且全部属于本批(任一越批 = 整条提案不可信,返回空)。 */
  const validSources = (value: unknown): string[] => {
    const requested = stringsOf(value, GRAPH_CAP.ref, GRAPH_CAP.proposalSources);
    return requested.length > 0 && requested.every((id) => allowedRecordIds.has(id)) ? requested : [];
  };
  const recordById = new Map(records.map((r) => [r.id, r]));
  const familiesOf = (sourceIds: readonly string[]): MemoryFamily[] => {
    const families = new Set<MemoryFamily>();
    for (const id of sourceIds) {
      const r = recordById.get(id);
      if (r) families.add(recordFamily(r));
    }
    return [...families];
  };

  // ── 节点提案 ──
  for (const raw of Array.isArray(options.result.nodes) ? options.result.nodes : []) {
    const ref = textOf(raw?.ref, GRAPH_CAP.ref);
    const name = textOf(raw?.name, GRAPH_CAP.name);
    const sources = validSources(raw?.sourceRecordIds);
    if (!ref || !name || !GRAPH_NODE_TYPE_SET.has(raw?.type) || sources.length === 0) {
      dropped++;
      continue;
    }
    // ── 本体准入(v0.26.57):类型×名字形态硬规则,与提示词同源 ──
    if (raw.type === 'concept') { dropped++; continue; }            // 概念走独立表分流
    const pathLike = isPathLike(name);
    if (raw.type === 'place' && pathLike) { dropped++; continue; }  // 路径不是地点
    if ((raw.type === 'person' || raw.type === 'organization') && !splitQualified(name).qualifier && isRoleName(name)) {
      dropped++;                                                     // 泛称裸节点不落库(带限定名除外)
      continue;
    }
    const aliases = stringsOf(raw?.aliases, GRAPH_CAP.alias, GRAPH_CAP.aliases)
      .filter((alias) => normalizeEntityName(alias) !== normalizeEntityName(name))
      .filter(isAliasShaped);                                        // 别名只收写法变体
    const tags = stringsOf(raw?.tags, GRAPH_CAP.tag, GRAPH_CAP.tags);
    if (raw.type === 'tool' && pathLike) tags.push('路径');           // 路径样工具保留打 tag(@scope/pkg 是真工具)
    const validFrom = textOf(raw?.validFrom, GRAPH_CAP.date) || anchorTimeFromRecords(sources.map((id) => recordById.get(id)!).filter(Boolean), now);
    const validTo = textOf(raw?.validTo, GRAPH_CAP.date) || undefined;
    const status = clampStatus(raw?.status);
    const confidence = clampConfidence(raw?.confidence);

    // 消歧合并:同名同型已有节点就地更新;否则新建
    let node = nodes.find((candidate) => isSameEntity(candidate, name, aliases, raw.type as string));
    if (!node) {
      node = {
        id: idFactory('node'),
        name,
        type: raw.type,
        aliases: [],
        currentState: '',
        facts: [],
        status,
        confidence,
        sourceRecordIds: [],
        families: [],
        createdAt: now,
        updatedAt: now,
      };
      nodes.push(node);
    }
    node.aliases = [...new Set([...node.aliases, ...aliases])];
    if (tags.length > 0) node.tags = [...new Set([...(node.tags ?? []), ...tags])].slice(0, GRAPH_CAP.tags);
    // v0.26.60 **归档不复活**:清扫/删除判成 archived 的行,后续投影再命中同名只更新内容,
    // 不把状态翻回 active。实测(带正对照)投影原本会无条件写 active——那意味着 task_28 的
    // bareRole=0 会被下一批投影悄悄冲掉,指标随时间回退。语义上归档是**否决权**,高于投影
    // 的默认值;投影若显式表态(disputed/superseded 等)仍跟随它,重建(A 刀)也不受影响。
    node.status = node.status === 'archived' && status === 'active' ? 'archived' : status;
    node.confidence = confidence;
    node.sourceRecordIds = unionSourcesCapped(node.sourceRecordIds, sources);
    node.families = [...new Set([...node.families, ...familiesOf(sources)])];

    // 事实集:单行状态(state)归一为「状态」fact + 显式 facts 数组
    const stateLine = textOf(raw?.state, GRAPH_CAP.state);
    const explicitFacts = Array.isArray(raw?.facts) ? raw.facts : [];
    const factProposals: Array<{ key: string; value: string | string[]; sourceRecordIds?: string[] }> = [
      ...(stateLine ? [{ key: '状态', value: stateLine }] : []),
      ...explicitFacts,
    ];
    for (const fp of factProposals) {
      const rawKey = textOf(fp?.key, GRAPH_CAP.factKey);
      const key = normalizeFactKey(rawKey);
      if (key && !isCanonicalFactKey(key) && !(node.tags ?? []).includes('未规范')) {
        node.tags = [...(node.tags ?? []), '未规范'];
      }
      const value = Array.isArray(fp?.value)
        ? stringsOf(fp.value, GRAPH_CAP.factValue, GRAPH_CAP.factValueItems)
        : textOf(fp?.value, GRAPH_CAP.factValue);
      if (!key || (Array.isArray(value) ? value.length === 0 : !value)) continue;
      // fact 级来源可选:未带则继承节点提案的来源(同样过批校验)
      const factSources = fp && 'sourceRecordIds' in fp && fp.sourceRecordIds !== undefined
        ? validSources(fp.sourceRecordIds)
        : sources;
      if (factSources.length === 0) {
        dropped++;
        continue;
      }
      // supersede:同 key 的旧 active fact 闭合(保留完整时间区间)
      for (const old of node.facts) {
        if (old.status === 'active' && old.key === key) {
          old.status = 'superseded';
          if (!old.validTo) old.validTo = validFrom;
          old.updatedAt = now;
        }
      }
      const fact: GraphFact = {
        id: idFactory('gfact'),
        key,
        value,
        status,
        validFrom,
        ...(validTo ? { validTo } : {}),
        confidence,
        sourceRecordIds: unionSourcesCapped([], factSources),
        createdAt: now,
        updatedAt: now,
      };
      node.facts.push(fact);
    }
    // currentState 只由 active facts 重建(superseded/disputed/archived 不进状态串)
    node.currentState = node.facts
      .filter((f) => f.status === 'active')
      .map((f) => `${f.key}: ${Array.isArray(f.value) ? f.value.join('、') : f.value}`)
      .join('\n');
    node.updatedAt = now;
    refs.set(ref, node);
    touchedNodes.add(node.id);
  }

  // ── 概念提案(独立表分流;硬校验与节点同规)──
  for (const raw of Array.isArray(options.result.concepts) ? options.result.concepts : []) {
    const ref = textOf(raw?.ref, GRAPH_CAP.ref);
    const name = textOf(raw?.name, GRAPH_CAP.name);
    const sources = validSources(raw?.sourceRecordIds);
    if (!ref || !name || sources.length === 0) { dropped++; continue; }
    const definition = textOf(raw?.definition, GRAPH_CAP.state);
    if (!definition) { dropped++; continue; }   // 概念必须有定义(空定义 = 没有沉淀价值)
    const category = clampConceptCategory(raw?.category, name) as ConceptCategory;
    const aliases = stringsOf(raw?.aliases, GRAPH_CAP.alias, GRAPH_CAP.aliases)
      .filter((alias) => normalizeEntityName(alias) !== normalizeEntityName(name))
      .filter(isAliasShaped);
    const validFrom = textOf(raw?.validFrom, GRAPH_CAP.date) || anchorTimeFromRecords(sources.map((id) => recordById.get(id)!).filter(Boolean), now);
    const status = clampStatus(raw?.status);
    const confidence = clampConfidence(raw?.confidence);
    let concept = concepts.find((c) => sameQualified(c, name, aliases));
    if (!concept) {
      concept = {
        id: idFactory('gconcept'),
        name,
        category,
        aliases: [],
        definition,
        facts: [],
        status,
        confidence,
        sourceRecordIds: [],
        families: [],
        createdAt: now,
        updatedAt: now,
      };
      concepts.push(concept);
    }
    concept.aliases = [...new Set([...concept.aliases, ...aliases])];
    concept.definition = definition;
    // 同 node:归档是**否决权**,投影缺省的 active 不得把它复活(概念表与节点表一条规则,不分叉)。
    concept.status = concept.status === 'archived' && status === 'active' ? 'archived' : status;
    concept.confidence = confidence;
    concept.sourceRecordIds = unionSourcesCapped(concept.sourceRecordIds, sources);
    concept.families = [...new Set([...concept.families, ...familiesOf(sources)])];
    for (const fp of (Array.isArray(raw.facts) ? raw.facts : [])) {
      const key = normalizeFactKey(textOf(fp?.key, GRAPH_CAP.factKey));
      const value = Array.isArray(fp?.value)
        ? stringsOf(fp.value, GRAPH_CAP.factValue, GRAPH_CAP.factValueItems)
        : textOf(fp?.value, GRAPH_CAP.factValue);
      if (!key || (Array.isArray(value) ? value.length === 0 : !value)) continue;
      const factSources = fp && 'sourceRecordIds' in fp && fp.sourceRecordIds !== undefined
        ? validSources(fp.sourceRecordIds)
        : sources;
      if (factSources.length === 0) { dropped++; continue; }
      for (const old of concept.facts) {
        if (old.status === 'active' && old.key === key) {
          old.status = 'superseded';
          if (!old.validTo) old.validTo = validFrom;
          old.updatedAt = now;
        }
      }
      concept.facts.push({
        id: idFactory('gfact'),
        key,
        value,
        status,
        validFrom,
        confidence,
        sourceRecordIds: unionSourcesCapped([], factSources),
        createdAt: now,
        updatedAt: now,
      });
    }
    conceptRefs.set(ref, concept);
    touchedConcepts.add(concept.id);
  }

  // ── 边提案 ──
  for (const raw of Array.isArray(options.result.edges) ? options.result.edges : []) {
    const from = refs.get(textOf(raw?.fromRef, GRAPH_CAP.ref)) ?? conceptRefs.get(textOf(raw?.fromRef, GRAPH_CAP.ref));
    const to = refs.get(textOf(raw?.toRef, GRAPH_CAP.ref)) ?? conceptRefs.get(textOf(raw?.toRef, GRAPH_CAP.ref));
    const relation = textOf(raw?.relation, GRAPH_CAP.relation);
    const sources = validSources(raw?.sourceRecordIds);
    if (!from || !to || from.id === to.id || !relation || sources.length === 0) {
      dropped++;
      continue;
    }
    const status = clampStatus(raw?.status);
    const confidence = clampConfidence(raw?.confidence);
    const validFrom =
      textOf(raw?.validFrom, GRAPH_CAP.date) || anchorTimeFromRecords(sources.map((id) => recordById.get(id)!).filter(Boolean), now);
    const validTo = textOf(raw?.validTo, GRAPH_CAP.date) || undefined;
    // supersede:同 (from,relation) 指向新目标 → 旧 active 边闭合
    for (const old of edges) {
      if (old.status === 'active' && old.fromNodeId === from.id && old.relation === relation && old.toNodeId !== to.id) {
        old.status = 'superseded';
        if (!old.validTo) old.validTo = validFrom;
        old.updatedAt = now;
        touchedEdges.add(old.id);
      }
    }
    // 同 (from,to,relation,status) 已有边 → 合并来源;否则新建
    const existing = edges.find(
      (e) => e.fromNodeId === from.id && e.toNodeId === to.id && e.relation === relation && e.status === status,
    );
    if (existing) {
      existing.sourceRecordIds = unionSourcesCapped(existing.sourceRecordIds, sources);
      existing.confidence = confidence;
      existing.updatedAt = now;
      touchedEdges.add(existing.id);
    } else {
      const edge: GraphEdge = {
        id: idFactory('edge'),
        fromNodeId: from.id,
        toNodeId: to.id,
        relation,
        status,
        validFrom,
        ...(validTo ? { validTo } : {}),
        confidence,
        sourceRecordIds: unionSourcesCapped([], sources),
        createdAt: now,
        updatedAt: now,
      };
      edges.push(edge);
      touchedEdges.add(edge.id);
    }
  }

  return { nodeIds: [...touchedNodes], edgeIds: [...touchedEdges], conceptIds: [...touchedConcepts], dropped };
}
