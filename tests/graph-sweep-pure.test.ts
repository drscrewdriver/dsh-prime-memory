/**
 * 存量清扫纯函数测试(v0.26.58 B 刀)。
 *
 * 锁的是「同一把尺」:清扫判据必须与投影闸门逐字同源,否则 v2 的收敛在入口成立、
 * 在存量落空,两处口径分叉比脏数据更难查。
 */
import { describe, expect, it } from 'vitest';
import type { GraphConcept, GraphFact, GraphNode } from '../src/graph/types.js';
import { sweepStockGraph } from '../src/graph/sweep.js';

const NOW = '2026-11-17T00:00:00.000Z';

function fact(key: string, value: string, status: GraphFact['status'] = 'active'): GraphFact {
  return {
    id: `f-${key}`,
    key,
    value,
    status,
    confidence: 0.8,
    sourceRecordIds: ['rec-1'],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function node(over: Partial<GraphNode> & { id: string; name: string; type: GraphNode['type'] }): GraphNode {
  return {
    aliases: [],
    tags: [],
    currentState: '',
    facts: [],
    status: 'active',
    confidence: 0.8,
    sourceRecordIds: ['rec-1'],
    families: ['work'],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as GraphNode;
}

describe('sweepStockGraph 存量清扫', () => {
  it('① 泛称裸角色节点归档;带限定名与真名一律保留', () => {
    const nodes = [
      node({ id: 'n1', name: '助手', type: 'person' }),
      node({ id: 'n2', name: '用户', type: 'person' }),
      node({ id: 'n3', name: '团队', type: 'organization' }),
      node({ id: 'n4', name: '用户@DSH', type: 'person' }),        // R4 要的限定名分离:留
      node({ id: 'n5', name: '于开丞', type: 'person' }),          // 真名:留
      node({ id: 'n6', name: 'NeatDownloader', type: 'tool' }),   // 非 person/org:不碰
      node({ id: 'n7', name: '维护者', type: 'tool' }),            // 角色词但类型不符:不碰
    ];
    const rp = sweepStockGraph({ nodes, now: NOW });
    expect(rp.bareRoleArchived).toBe(3);
    expect(rp.archivedIds.sort()).toEqual(['n1', 'n2', 'n3']);
    expect(nodes.filter((n) => n.status === 'archived').map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n3']);
    expect(nodes.find((n) => n.id === 'n4')?.status).toBe('active');
    expect(nodes.find((n) => n.id === 'n5')?.status).toBe('active');
    expect(nodes.find((n) => n.id === 'n6')?.status).toBe('active');
    expect(nodes.find((n) => n.id === 'n7')?.status).toBe('active');
    expect(rp.archivedSamples).toHaveLength(3);
  });

  it('② 路径名 place 改末段 + 打「路径」tag;末段仍非法的不硬改', () => {
    const nodes = [
      node({ id: 'p1', name: 'E:/test/rewrite-agently/mine-dsh-plugins', type: 'place' }),
      node({ id: 'p2', name: 'C:\\Users\\joshua\\.dsh\\memory', type: 'place' }),
      node({ id: 'p3', name: 'E:/a/b.md', type: 'place' }), // 末段仍是路径(带扩展名):改不动,计入 placeUnrenamed
      node({ id: 'p4', name: '杭州', type: 'place' }), // 真地理:不碰
    ];
    const rp = sweepStockGraph({ nodes, now: NOW });
    expect(rp.placeRenamed).toBe(2);
    expect(rp.placeUnrenamed).toBe(1);
    expect(nodes.find((n) => n.id === 'p1')?.name).toBe('mine-dsh-plugins');
    expect(nodes.find((n) => n.id === 'p2')?.name).toBe('memory');
    expect(nodes.find((n) => n.id === 'p3')?.name).toBe('E:/a/b.md');
    expect(nodes.find((n) => n.id === 'p4')?.name).toBe('杭州');
    expect(nodes.find((n) => n.id === 'p1')?.tags).toContain('路径');
    expect(nodes.find((n) => n.id === 'p4')?.tags ?? []).not.toContain('路径');
  });

  it('③ 别名只留写法变体(路径样/描述性短语剔除,与入档判据同式)', () => {
    const n = node({
      id: 'a1',
      name: 'DSH',
      type: 'project',
      aliases: ['deepseek harness', 'E:/test/dsh', '需要确认排期', 'DSH'],
    });
    const rp = sweepStockGraph({ nodes: [n], now: NOW });
    expect(n.aliases).toEqual(['deepseek harness']);
    expect(rp.aliasesPruned).toBe(3); // 路径 1 + 描述 1 + 与自身归一同名 1
  });

  it('④ fact key 同义归一 + 表外补「未规范」tag(规范词表内不打)', () => {
    const canon = node({ id: 'k1', name: '某项目', type: 'project', facts: [fact('当前状态', '进行中')] });
    const noncanon = node({ id: 'k2', name: '某工具', type: 'tool', facts: [fact('门禁状态', '已过')] });
    const rp = sweepStockGraph({ nodes: [canon, noncanon], now: NOW });
    expect(canon.facts[0]?.key).toBe('状态');       // 同义映射生效
    expect(rp.factsRenamed).toBe(1);
    expect(canon.tags ?? []).not.toContain('未规范'); // 归一后已在规范词表
    expect(noncanon.facts[0]?.key).toBe('门禁状态');   // 表外原样保留
    expect(noncanon.tags ?? []).toContain('未规范');
    expect(rp.nodesUncanon).toBe(1);
  });

  it('⑤ currentState 按 active facts 重建(与 apply 同式)', () => {
    const n = node({
      id: 's1',
      name: '某项目',
      type: 'project',
      currentState: '当前状态: 旧的',
      facts: [fact('当前状态', '进行中'), fact('负责人', 'joshua', 'superseded')],
    });
    const rp = sweepStockGraph({ nodes: [n], now: NOW });
    expect(n.currentState).toBe('状态: 进行中'); // 归一后的 key,superseded 不进状态串
    expect(rp.statesRebuilt).toBe(1);
    expect(rp.touchedIds).toContain('s1');
  });

  it('概念行:清别名/key;同名同分类只报告不自动合并', () => {
    const concept = (id: string, name: string): GraphConcept => ({
      id,
      name,
      category: 'mechanism',
      aliases: ['E:/x/y'],
      definition: '一句话定义',
      facts: [fact('定位', '检索')],
      status: 'active',
      confidence: 0.8,
      sourceRecordIds: ['rec-1'],
      families: ['work'],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const concepts = [concept('c1', '向量检索'), concept('c2', '向量检索')];
    const rp = sweepStockGraph({ nodes: [], concepts, now: NOW });
    expect(concepts[0]?.aliases).toEqual([]);
    expect(concepts[0]?.facts[0]?.key).toBe('用途'); // 定位 → 用途
    expect(rp.touchedConceptIds.sort()).toEqual(['c1', 'c2']);
    expect(rp.conceptDups).toBe(1);                   // 只报告,不合并
  });

  it('① 双路:杂散泛称归档、偏好汇聚枢纽改限定名保留(代价入账)', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => fact('偏好' + i, 'v' + i));
    const hub = node({
      id: 'h1',
      name: '用户',
      type: 'person',
      facts: [...mk(21), fact('旧事实', 'v', 'superseded' as GraphFact['status'])],
    });
    const stray = node({ id: 'h2', name: '助手', type: 'person', facts: [fact('位置', 'x')] });
    const rp = sweepStockGraph({ nodes: [hub, stray], now: NOW });
    expect(rp.bareRoleQualified).toBe(1);
    expect(rp.bareRoleArchived).toBe(1);
    expect(hub.name).toBe('用户@work');            // R4 正面解法:限定名分离,不摘枢纽
    expect(hub.status).toBe('active');
    expect(rp.archivedFacts).toBe(1);              // 只有杂散那一个的账
    expect(rp.archivedMaxFacts).toBe(1);           // <20:没有大物质被误归档
    expect(rp.touchedIds).toContain('h1');         // 改名要写回
  });

  it('① 限定名撞上已有可见名 → 不静默改名,退回归档并计数', () => {
    const hub = node({ id: 'h1', name: '用户', type: 'person', facts: Array.from({ length: 25 }, (_, i) => fact('k' + i, 'v')) });
    const taken = node({ id: 'h2', name: '用户@work', type: 'person' }); // 归一后同键
    const rp = sweepStockGraph({ nodes: [hub, taken], now: NOW });
    expect(rp.bareRoleBlocked).toBe(1);
    expect(rp.bareRoleQualified).toBe(0);
    expect(rp.bareRoleArchived).toBe(1);
    expect(hub.status).toBe('archived');
    expect(rp.archivedFacts).toBe(25);   // ⚠ 名占满时枢纽仍会退场——报告必须看见
    expect(rp.archivedMaxFacts).toBe(25);
  });

  it('① 无 family 可用 → 造不出限定名,枢纽也归档(退路如实入账)', () => {
    const hub = node({ id: 'h1', name: 'AI', type: 'person', families: [], facts: Array.from({ length: 30 }, (_, i) => fact('k' + i, 'v')) });
    const rp = sweepStockGraph({ nodes: [hub], now: NOW });
    expect(rp.bareRoleQualified).toBe(0);
    expect(rp.bareRoleArchived).toBe(1);
    expect(rp.archivedFacts).toBe(30);
  });
  it('幂等 + 不动 archived/disputed 之外语义:再跑一次零命中', () => {
    const nodes = [
      node({ id: 'r1', name: '助手', type: 'person' }),
      node({ id: 'r2', name: 'E:/a/b', type: 'place' }),
      node({ id: 'r3', name: '旧节点', type: 'project', status: 'archived', aliases: ['E:/x'] }),
      node({ id: 'r4', name: '争议节点', type: 'project', status: 'disputed', facts: [fact('当前状态', 'x')] }),
    ];
    const first = sweepStockGraph({ nodes, now: NOW });
    expect(first.scanned).toBe(3);          // archived 不在分母
    expect(first.bareRoleArchived).toBe(1);
    expect(nodes.find((n) => n.id === 'r3')?.aliases).toEqual(['E:/x']); // 归档行不动
    expect(nodes.find((n) => n.id === 'r4')?.facts[0]?.key).toBe('状态'); // disputed 参与清扫
    const second = sweepStockGraph({ nodes, now: NOW });
    expect(second.bareRoleArchived).toBe(0);
    expect(second.placeRenamed).toBe(0);
    expect(second.factsRenamed).toBe(0);
    expect(second.statesRebuilt).toBe(0);
    expect(second.touchedIds).toEqual([]);
    expect(second.aliasesPruned).toBe(0);
  });
});
