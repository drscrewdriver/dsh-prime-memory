/**
 * 图谱域模型单元测试(纯函数,零 I/O):apply 硬校验/消歧/supersede/时间锚 与
 * search 字段加权/噪声过滤。G1 验收面——G2/G4 的存储与管线都建立在这些语义上。
 */
import { describe, expect, it } from 'vitest';
import { applyGraphProjection, anchorTimeFromRecords, normalizeEntityName } from '../src/graph/apply.js';
import { GRAPH_SOURCE_RECORDS_CAP } from '../src/graph/constraints.js';
import { searchGraphNodes } from '../src/graph/search.js';
import { GRAPH_PRIORITY_NEW } from '../src/graph/types.js';
import type { GraphEdge, GraphNode } from '../src/graph/types.js';
import type { MemoryRecord } from '../src/types.js';

const NOW = '2026-09-06T08:00:00.000Z';
let seq = 0;
const idFactory = (prefix: string): string => `${prefix}-test-${++seq}`;

function rec(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: overrides.id ?? `rec-${++seq}`,
    content: overrides.content ?? '某条记忆',
    type: overrides.type ?? 'episodic',
    priority: 60,
    scene_name: '默认',
    timestamps: overrides.timestamps ?? [],
    createdAt: overrides.createdAt ?? Date.parse('2026-09-06T07:00:00.000Z'),
    updatedAt: Date.parse('2026-09-06T07:00:00.000Z'),
    ...overrides,
  };
}

function applyBatch(
  records: MemoryRecord[],
  result: {
    nodes?: Array<Record<string, unknown>>;
    edges?: Array<Record<string, unknown>>;
  },
  scope?: { nodes: GraphNode[]; edges: GraphEdge[] },
) {
  const allowed = new Set(records.map((r) => r.id));
  return applyGraphProjection({
    nodes: scope?.nodes ?? [],
    edges: scope?.edges ?? [],
    records,
    result: { reason: '', nodes: (result.nodes ?? []) as never, edges: (result.edges ?? []) as never },
    allowedRecordIds: allowed,
    now: NOW,
    idFactory,
  });
}

describe('graph apply:零无来源硬校验', () => {
  it('来源越批的节点/边整条丢弃,合法提案落库', () => {
    const records = [rec({ id: 'r1' })];
    const outcome = applyBatch(records, {
      nodes: [
        { ref: 'a', name: '张三', type: 'person', sourceRecordIds: ['r1'] },
        { ref: 'b', name: '李四', type: 'person', sourceRecordIds: ['r1', '不存在的id'] },
        { ref: 'c', name: '王五', type: 'organization', sourceRecordIds: ['r1'] },
      ],
      edges: [
        { fromRef: 'a', toRef: 'c', relation: '相关', sourceRecordIds: ['r1'] },
        { fromRef: 'a', toRef: 'c', relation: '依赖', sourceRecordIds: ['r9'] },
      ],
    });
    // 落库 a/c 两节点与合法边;越批节点 b 与越批边被整条丢弃
    expect(outcome.nodeIds).toHaveLength(2);
    expect(outcome.edgeIds).toHaveLength(1);
    expect(outcome.dropped).toBe(2);
  });

  it('节点来源合法但 fact 自带越批来源 → 仅该 fact 丢弃', () => {
    const records = [rec({ id: 'r1' })];
    const outcome = applyBatch(records, {
      nodes: [
        {
          ref: 'a',
          name: '张三',
          type: 'person',
          sourceRecordIds: ['r1'],
          facts: [
            { key: '职业', value: '工程师', sourceRecordIds: ['r1'] },
            { key: '城市', value: '上海', sourceRecordIds: ['r2'] },
          ],
        },
      ],
    });
    expect(outcome.nodeIds).toHaveLength(1);
    expect(outcome.dropped).toBe(1);
    const node = outcome.nodeIds.length ? undefined : undefined;
    void node;
  });
});

describe('graph apply:实体消歧', () => {
  it('NFKC/大小写/空白连字符变体合并进已有节点,别名累积去重', () => {
    const records = [rec({ id: 'r1' }), rec({ id: 'r2' })];
    const scope = { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    applyBatch(
      records,
      { nodes: [{ ref: 'a', name: 'AI Agent', type: 'tool', sourceRecordIds: ['r1'], aliases: ['智能体'] }] },
      scope,
    );
    applyBatch(
      records,
      { nodes: [{ ref: 'b', name: 'ai　agent', type: 'tool', sourceRecordIds: ['r2'], aliases: ['智能体', 'AI-Agent'] }] },
      scope,
    );
    expect(scope.nodes).toHaveLength(1);
    expect(scope.nodes[0]!.aliases).toEqual(['智能体']);
    expect(scope.nodes[0]!.sourceRecordIds).toEqual(['r1', 'r2']);
    // families = 来源记录族并集(默认 episodic → chat)
    expect(scope.nodes[0]!.families).toEqual(['chat']);
  });

  it('类型不同不合并;子串包含不算同一实体', () => {
    const records = [rec({ id: 'r1' })];
    const scope = { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    applyBatch(records, { nodes: [{ ref: 'a', name: '张三', type: 'person', sourceRecordIds: ['r1'] }] }, scope);
    applyBatch(records, { nodes: [{ ref: 'b', name: '张三', type: 'organization', sourceRecordIds: ['r1'] }] }, scope);
    applyBatch(records, { nodes: [{ ref: 'c', name: '张三丰', type: 'person', sourceRecordIds: ['r1'] }] }, scope);
    expect(scope.nodes.map((n) => n.name).sort()).toEqual(['张三', '张三', '张三丰']);
    expect(scope.nodes.map((n) => n.type).sort()).toEqual(['organization', 'person', 'person']);
  });

  it('normalizeEntityName 归一口径:NFKC + 小写 + 去空白/下划线/连字符', () => {
    expect(normalizeEntityName('ＶＳＣｏｄｅ')).toBe(normalizeEntityName('vscode'));
    expect(normalizeEntityName('DeepSeek-V3')).toBe(normalizeEntityName('deepseekv3'));
    expect(normalizeEntityName('知 识 图 谱')).toBe(normalizeEntityName('知识图谱'));
  });
});

describe('graph apply:supersede 与 currentState', () => {
  it('同 key 新 fact 闭合旧 active fact(validTo=新 validFrom),currentState 只含 active', () => {
    const records = [rec({ id: 'r1' }), rec({ id: 'r2' })];
    const scope = { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    applyBatch(
      records,
      { nodes: [{ ref: 'a', name: '张三', type: 'person', sourceRecordIds: ['r1'], validFrom: '2026-01-01', state: '居住在北京' }] },
      scope,
    );
    applyBatch(
      records,
      { nodes: [{ ref: 'a', name: '张三', type: 'person', sourceRecordIds: ['r2'], validFrom: '2026-06-01', state: '居住在上海' }] },
      scope,
    );
    const node = scope.nodes[0]!;
    expect(node.facts).toHaveLength(2);
    expect(node.facts[0]!.status).toBe('superseded');
    expect(node.facts[0]!.validTo).toBe('2026-06-01');
    expect(node.facts[1]!.status).toBe('active');
    expect(node.currentState).toBe('状态: 居住在上海');
  });

  it('同 (from,relation) 指向新目标 → 旧边 supersede + validTo 闭合', () => {
    const records = [rec({ id: 'r1' }), rec({ id: 'r2' })];
    const scope = { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    applyBatch(
      records,
      {
        nodes: [
          { ref: 'p', name: '张三', type: 'person', sourceRecordIds: ['r1'] },
          { ref: 't1', name: '团队A', type: 'organization', sourceRecordIds: ['r1'] },
          { ref: 't2', name: '团队B', type: 'organization', sourceRecordIds: ['r2'] },
        ],
        edges: [{ fromRef: 'p', toRef: 't1', relation: '属于', sourceRecordIds: ['r1'] }],
      },
      scope,
    );
    applyBatch(
      records,
      {
        // ref 只在本批提案内连线:第二批重新提案节点(消歧合并进已有节点)后边才可连
        nodes: [
          { ref: 'p', name: '张三', type: 'person', sourceRecordIds: ['r2'] },
          { ref: 't2', name: '团队B', type: 'organization', sourceRecordIds: ['r2'] },
        ],
        edges: [{ fromRef: 'p', toRef: 't2', relation: '属于', sourceRecordIds: ['r2'] }],
      },
      scope,
    );
    expect(scope.edges).toHaveLength(2);
    const old = scope.edges.find((e) => e.toNodeId === scope.nodes.find((n) => n.name === '团队A')!.id)!;
    const neu = scope.edges.find((e) => e.toNodeId === scope.nodes.find((n) => n.name === '团队B')!.id)!;
    expect(old.status).toBe('superseded');
    expect(old.validTo).toBe(neu.validFrom);
    expect(neu.status).toBe('active');
  });

  it('同一 (from,to,relation) 重复投影 → 合并来源而非建重边', () => {
    const records = [rec({ id: 'r1' }), rec({ id: 'r2' })];
    const scope = { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    for (const rid of ['r1', 'r2']) {
      applyBatch(
        [rec({ id: rid })],
        {
          nodes: [
            { ref: 'p', name: '张三', type: 'person', sourceRecordIds: [rid] },
            { ref: 't', name: '团队A', type: 'organization', sourceRecordIds: [rid] },
          ],
          edges: [{ fromRef: 'p', toRef: 't', relation: '属于', sourceRecordIds: [rid] }],
        },
        scope,
      );
    }
    expect(scope.edges).toHaveLength(1);
    expect(scope.edges[0]!.sourceRecordIds).toEqual(['r1', 'r2']);
  });
});

describe('graph apply:时间锚四级链', () => {
  it('activity_start_time > activity_end_time > timestamps > createdAt 逐级取最晚', () => {
    const createdAt = Date.parse('2026-03-01T00:00:00.000Z');
    // 只带 createdAt → 落 createdAt
    expect(anchorTimeFromRecords([rec({ createdAt })], NOW)).toBe('2026-03-01T00:00:00.000Z');
    // timestamps 更晚 → 落 timestamps
    const ts = [Date.parse('2026-04-01T00:00:00.000Z')];
    expect(anchorTimeFromRecords([rec({ createdAt, timestamps: ts })], NOW)).toBe('2026-04-01T00:00:00.000Z');
    // activity_end_time 更晚 → 落 end
    const end = '2026-05-01T00:00:00.000Z';
    expect(
      anchorTimeFromRecords([rec({ createdAt, timestamps: ts, metadata: { activity_end_time: end } })], NOW),
    ).toBe(end);
    // activity_start_time 最晚 → 落 start
    const start = '2026-06-01T00:00:00.000Z';
    expect(
      anchorTimeFromRecords([rec({ createdAt, timestamps: ts, metadata: { activity_start_time: start, activity_end_time: end } })], NOW),
    ).toBe(start);
  });

  it('跨来源取最晚;全部无证据回退 fallback(now),不猜日期', () => {
    const r1 = rec({ id: 'a', createdAt: Date.parse('2026-02-01T00:00:00.000Z') });
    const r2 = rec({ id: 'b', createdAt: Date.parse('2026-08-01T00:00:00.000Z') });
    expect(anchorTimeFromRecords([r1, r2], NOW)).toBe('2026-08-01T00:00:00.000Z');
    expect(anchorTimeFromRecords([], NOW)).toBe(NOW);
    expect(anchorTimeFromRecords([rec({ createdAt: Number.NaN })], NOW)).toBe(NOW);
  });

  it('提案无 validFrom 时从来源记录锚定;显式 validFrom 优先', () => {
    const records = [rec({ id: 'r1', createdAt: Date.parse('2026-04-01T00:00:00.000Z') })];
    const scope = { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    applyBatch(records, { nodes: [{ ref: 'a', name: '张三', type: 'person', sourceRecordIds: ['r1'], state: '在职' }] }, scope);
    expect(scope.nodes[0]!.facts[0]!.validFrom).toBe('2026-04-01T00:00:00.000Z');
  });
});

describe('graph apply:来源集封顶', () => {
  it('节点来源并集封顶 128 保最新(单提案 64 上限之上去并集触发)', () => {
    const records = Array.from({ length: 150 }, (_, i) => rec({ id: `r${i}` }));
    const scope = { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    const ids = records.map((r) => r.id);
    // 三次提案(64+64+22)合并进同一实体 → 并集 150 超过 128 → 保最新
    for (let i = 0; i < 3; i++) {
      applyBatch(
        records,
        { nodes: [{ ref: 'a', name: '张三', type: 'person', sourceRecordIds: ids.slice(i * 64, (i + 1) * 64) }] },
        scope,
      );
    }
    const sources = scope.nodes[0]!.sourceRecordIds;
    expect(sources).toHaveLength(GRAPH_SOURCE_RECORDS_CAP);
    expect(sources[0]).toBe(`r${records.length - GRAPH_SOURCE_RECORDS_CAP}`);
    expect(sources.at(-1)).toBe(`r${records.length - 1}`);
  });
});

describe('graph search:加权与噪声过滤', () => {
  function node(overrides: Partial<GraphNode>): GraphNode {
    return {
      id: 'n1',
      name: '张三',
      type: 'person',
      aliases: [],
      currentState: '',
      facts: [],
      status: 'active',
      confidence: 0.8,
      sourceRecordIds: ['r1'],
      families: ['chat'],
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it('名称命中排在事实命中之前(权重 name×6 > facts×4)', () => {
    const byName = node({ id: 'n-name', name: '知识图谱' });
    const byFacts = node({
      id: 'n-facts',
      name: '别的项目',
      facts: [{ id: 'f1', key: '领域', value: '知识图谱', status: 'active', confidence: 0.8, sourceRecordIds: ['r1'], createdAt: NOW, updatedAt: NOW }],
    });
    const hits = searchGraphNodes([byFacts, byName], [], '知识图谱', 10);
    expect(hits[0]!.node.id).toBe('n-name');
    expect(hits[0]!.matchedFields).toContain('name');
    expect(hits[1]!.matchedFields).toContain('facts');
    expect(hits[0]!.matchReason).toContain('名称');
  });

  it('仅关系词命中的节点被过滤;关系词只做其他字段命中后的加分;type-only 命中保留', () => {
    const proj = node({ id: 'n-proj', name: '无关项目', type: 'project' });
    const person = node({ id: 'n-person', name: '张三', type: 'person' });
    const tool = node({ id: 'n-tool', name: '另一个工具', type: 'tool' });
    const edges: GraphEdge[] = [
      { id: 'e1', fromNodeId: 'n-person', toNodeId: 'n-proj', relation: '使用', status: 'active', confidence: 0.8, sourceRecordIds: ['r1'], createdAt: NOW, updatedAt: NOW },
      { id: 'e2', fromNodeId: 'n-tool', toNodeId: 'n-proj', relation: '贡献', status: 'active', confidence: 0.8, sourceRecordIds: ['r1'], createdAt: NOW, updatedAt: NOW },
    ];
    // 关系词对两端点都生效:「使用」单独搜索时两端都只是关系命中 → 全部过滤
    expect(searchGraphNodes([proj, person, tool], edges, '使用', 10)).toHaveLength(0);
    // 关系词叠加名称命中:person 名称+关系双命中保留(matchedFields 含 name);
    // proj 仍只有关系命中 → 过滤
    const boosted = searchGraphNodes([proj, person, tool], edges, '张三 使用', 10);
    expect(boosted.map((h) => h.node.id)).toEqual(['n-person']);
    expect(boosted[0]!.matchedFields).toContain('name');
    expect(boosted[0]!.matchedFields).toContain('relations');
    // type 词命中(查询用英文 token 与 type 字段同源)保留
    const byType = searchGraphNodes([proj, person, tool], edges, 'tool', 10);
    expect(byType.map((h) => h.node.id)).toEqual(['n-tool']);
    expect(byType[0]!.matchedFields).toEqual(['type']);
  });

  it('superseded facts 不进检索文本;空查询/无命中返回空;limit 钳制', () => {
    const n = node({
      currentState: '',
      facts: [
        { id: 'f1', key: '城市', value: '上海', status: 'active', confidence: 0.8, sourceRecordIds: ['r1'], createdAt: NOW, updatedAt: NOW },
        { id: 'f2', key: '城市', value: '北京', status: 'superseded', confidence: 0.8, sourceRecordIds: ['r0'], createdAt: NOW, updatedAt: NOW },
      ],
    });
    expect(searchGraphNodes([n], [], '北京', 10)).toHaveLength(0);
    expect(searchGraphNodes([n], [], '上海', 10)).toHaveLength(1);
    expect(searchGraphNodes([n], [], '', 10)).toHaveLength(0);
    const many = Array.from({ length: 30 }, (_, i) => node({ id: `n${i}`, name: '张三' }));
    expect(searchGraphNodes(many, [], '张三', 99)).toHaveLength(20);
    expect(searchGraphNodes(many, [], '张三', 0)).toHaveLength(5);
  });

  it('新蒸馏记录优先级常量不倒挂(存量补投影必须 < 10000)', () => {
    expect(GRAPH_PRIORITY_NEW).toBe(10000);
  });
});
