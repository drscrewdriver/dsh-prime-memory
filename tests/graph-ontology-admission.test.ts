/**
 * 本体准入与概念分流测试(apply 纯函数层,v0.26.57)。
 *
 * 钉住 checklist 的 apply 侧判据:类型×名字形态三分支准入、限定符消歧、
 * 概念独立表分流(不落 nodes)、描述性别名丢弃计数、fact key 规范化。
 */
import { describe, expect, it } from 'vitest';
import { applyGraphProjection } from '../src/graph/apply.js';
import type { GraphConcept, GraphEdge, GraphNode } from '../src/graph/types.js';
import type { MemoryRecord } from '../src/types.js';
import { familyForType } from '../src/types.js';

function rec(id: string, content: string): MemoryRecord {
  const base: MemoryRecord = {
    id,
    content,
    type: 'episodic',
    family: familyForType('episodic'),
    persistence: 'pass',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    source: 'chat',
    importance: 5,
    confidence: 0.8,
    entity: '',
    wing: 'personal',
    room: 'chat',
    tags: [],
    supersedes: null,
    metadata: {},
  } as unknown as MemoryRecord;
  return base;
}

const RECORDS = [rec('rec-1', '用户在 DSH 里使用助手'), rec('rec-2', '项目用了 C:\\x\\y 目录')];
const ALLOWED = new Set(['rec-1', 'rec-2']);

function apply(
  nodes: GraphNode[],
  edges: GraphEdge[],
  proposals: { nodes?: unknown[]; concepts?: unknown[]; edges?: unknown[] },
  concepts: GraphConcept[] = [],
) {
  let seq = 0;
  return applyGraphProjection({
    nodes,
    edges,
    concepts,
    records: RECORDS,
    result: {
      reason: 'test',
      nodes: (proposals.nodes ?? []) as never,
      concepts: (proposals.concepts ?? []) as never,
      edges: (proposals.edges ?? []) as never,
    },
    allowedRecordIds: ALLOWED,
    now: '2026-09-06T08:00:00.000Z',
    idFactory: (p) => `${p}-${seq++}`,
  });
}

describe('类型×名字形态准入三分支', () => {
  it('place + 路径名 → 丢弃计入 dropped', () => {
    const nodes: GraphNode[] = [];
    const outcome = apply(nodes, [], {
      nodes: [{ ref: 'p1', name: 'C:\\Users\\joshua\\.dsh', type: 'place', sourceRecordIds: ['rec-1'] }],
    });
    expect(outcome.nodeIds).toHaveLength(0);
    expect(outcome.dropped).toBeGreaterThan(0);
    expect(nodes).toHaveLength(0);
  });

  it('tool + 路径名 → 保留且带 路径 tag;scoped 包名不带', () => {
    const nodes: GraphNode[] = [];
    apply(nodes, [], {
      nodes: [
        { ref: 't1', name: 'E:/project/node_modules', type: 'tool', sourceRecordIds: ['rec-1'] },
        { ref: 't2', name: '@changfenhuang/dsh-genui', type: 'tool', sourceRecordIds: ['rec-1'] },
      ],
    });
    expect(nodes).toHaveLength(2);
    const pathTool = nodes.find((n) => n.name.startsWith('E:/'))!;
    const scoped = nodes.find((n) => n.name.startsWith('@'))!;
    expect(pathTool.tags).toContain('路径');
    expect(scoped.tags ?? []).not.toContain('路径');
  });

  it('person/org 泛称裸节点丢弃;带限定符准入', () => {
    const nodes: GraphNode[] = [];
    const outcome = apply(nodes, [], {
      nodes: [
        { ref: 'r1', name: '用户', type: 'person', sourceRecordIds: ['rec-1'] },
        { ref: 'r2', name: '开发团队', type: 'organization', sourceRecordIds: ['rec-1'] },
        { ref: 'r3', name: '用户@DSH', type: 'person', sourceRecordIds: ['rec-1'] },
      ],
    });
    expect(nodes.map((n) => n.name)).toEqual(['用户@DSH']);
    expect(outcome.dropped).toBe(2);
  });

  it('描述性别名被过滤(不进 aliases),名字本身是句子的节点不靠别名混入', () => {
    const nodes: GraphNode[] = [];
    apply(nodes, [], {
      nodes: [{
        ref: 'n1', name: '张三', type: 'person', sourceRecordIds: ['rec-1'],
        aliases: ['老张', '用户确认口径后执行', 'C:\\x\\y'],
      }],
    });
    expect(nodes[0]!.aliases).toEqual(['老张']);
  });

  it('concept 类型混进 nodes → 丢弃(必须走 concepts 数组)', () => {
    const nodes: GraphNode[] = [];
    const outcome = apply(nodes, [], {
      nodes: [{ ref: 'x1', name: '压缩算法', type: 'concept', definition: 'x', sourceRecordIds: ['rec-1'] }],
    });
    expect(nodes).toHaveLength(0);
    expect(outcome.conceptIds).toHaveLength(0);
    expect(outcome.dropped).toBe(1);
  });
});

describe('限定符消歧(用户@DSH 与 用户@GitHub 不合并)', () => {
  it('同名不同限定 → 两个节点;归一变体 → 同一节点', () => {
    const nodes: GraphNode[] = [];
    apply(nodes, [], {
      nodes: [
        { ref: 'a', name: '用户@DSH', type: 'person', sourceRecordIds: ['rec-1'] },
        { ref: 'b', name: '用户@GitHub', type: 'person', sourceRecordIds: ['rec-1'] },
        { ref: 'c', name: '用户 @ dsh', type: 'person', sourceRecordIds: ['rec-2'] },
      ],
    });
    expect(nodes).toHaveLength(2);
    const dsh = nodes.find((n) => n.name === '用户@DSH')!;
    expect(dsh.sourceRecordIds).toEqual(expect.arrayContaining(['rec-1', 'rec-2']));
  });

  it('无限定名不并入带限定名', () => {
    const nodes: GraphNode[] = [];
    apply(nodes, [], {
      nodes: [
        { ref: 'a', name: '张三@项目组', type: 'person', sourceRecordIds: ['rec-1'] },
        { ref: 'b', name: '张三', type: 'person', sourceRecordIds: ['rec-2'] },
      ],
    });
    expect(nodes).toHaveLength(2);
  });
});

describe('概念分流与硬校验', () => {
  it('概念落 concepts 内存形,不落 nodes;实现边跨表连线', () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const concepts: GraphConcept[] = [];
    const outcome = apply(nodes, edges, {
      nodes: [{ ref: 'n1', name: 'GraphX', type: 'project', sourceRecordIds: ['rec-1'] }],
      concepts: [{ ref: 'c1', name: '图谱投影机制', category: 'mechanism', definition: '从记录抽取实体关系的机制', sourceRecordIds: ['rec-2'] }],
      edges: [{ fromRef: 'n1', toRef: 'c1', relation: '实现', sourceRecordIds: ['rec-1'] }],
    }, concepts);
    expect(nodes).toHaveLength(1);
    expect(concepts).toHaveLength(1);
    expect(concepts[0]!.definition).toContain('抽取');
    expect(outcome.conceptIds).toHaveLength(1);
    expect(outcome.edgeIds).toHaveLength(1);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.toNodeId).toBe(concepts[0]!.id);
  });

  it('缺 definition 的概念丢弃;category 非法不丢(回落词根猜测)', () => {
    const concepts: GraphConcept[] = [];
    const outcome = apply([], [], {
      concepts: [
        { ref: 'c1', name: '无定义概念', sourceRecordIds: ['rec-1'] },
        { ref: 'c2', name: '压缩算法', category: '乱写', definition: '有定义', sourceRecordIds: ['rec-1'] },
      ],
    }, concepts);
    expect(concepts).toHaveLength(1);
    expect(concepts[0]!.category).toBe('algorithm');
    expect(outcome.dropped).toBe(1);
  });

  it('概念 fact 同 key 重述 → 旧 active 标 superseded(与节点同语义)', () => {
    const concepts: GraphConcept[] = [];
    apply([], [], {
      concepts: [{ ref: 'c1', name: 'RRF 融合', definition: '倒数排名融合', sourceRecordIds: ['rec-1'], facts: [{ key: '用途', value: '检索重排' }] }],
    }, concepts);
    apply([], [], {
      concepts: [{ ref: 'c1', name: 'RRF 融合', definition: '倒数排名融合', sourceRecordIds: ['rec-2'], facts: [{ key: '用途', value: '图谱回链重排' }] }],
    }, concepts);
    const facts = concepts[0]!.facts.filter((f) => f.key === '用途');
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.status === 'superseded')!.value).toBe('检索重排');
    expect(facts.find((f) => f.status === 'active')!.value).toBe('图谱回链重排');
  });

  it('零来源概念提案丢弃(铁律同节点):allowedRecordIds 外的 id 不算来源', () => {
    const concepts: GraphConcept[] = [];
    const outcome = apply([], [], {
      concepts: [{ ref: 'c1', name: '幽灵概念', definition: 'x', sourceRecordIds: ['rec-not-exist'] }],
    }, concepts);
    expect(concepts).toHaveLength(0);
    expect(outcome.dropped).toBe(1);
  });
});

describe('fact key 规范化(P6)', () => {
  it('同义 key 归一到规范 key;非常规 key 节点打未规范 tag', () => {
    const nodes: GraphNode[] = [];
    apply(nodes, [], {
      nodes: [
        { ref: 'n1', name: 'GraphX', type: 'project', sourceRecordIds: ['rec-1'], facts: [{ key: '当前状态', value: '开发中' }] },
        { ref: 'n2', name: '张三', type: 'person', sourceRecordIds: ['rec-1'], facts: [{ key: '玄学维度', value: '高' }] },
      ],
    });
    const proj = nodes.find((n) => n.name === 'GraphX')!;
    const myst = nodes.find((n) => n.name === '张三')!;
    expect(proj.facts.some((f) => f.key === '状态')).toBe(true);
    expect(myst.facts.some((f) => f.key === '玄学维度')).toBe(true); // 不硬删
    expect(myst.tags).toContain('未规范');
    expect(proj.tags ?? []).not.toContain('未规范');
  });

  it('职位 → 职业(人物属性收敛)', () => {
    const nodes: GraphNode[] = [];
    apply(nodes, [], {
      nodes: [{ ref: 'n1', name: '李四', type: 'person', sourceRecordIds: ['rec-1'], facts: [{ key: '职位', value: '前端负责人' }] }],
    });
    expect(nodes[0]!.facts.some((f) => f.key === '职业' && f.value === '前端负责人')).toBe(true);
  });
});
