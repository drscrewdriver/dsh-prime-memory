/**
 * sourceMeta() 三通道（ms/scene/hall）单测：入表判据（任一通道有值即入表）、
 * hall 众数、平票按 WING_CATALOG 词表序 tie-break、非法值不计票、
 * agingOf 对 ms:null 容忍（端点层注入短路返 null；agingWeightOf 本身对 undefined 下限兜底不抛）。
 * 用真实 node:sqlite,不 mock 引擎。节点 id 由投影生成,经 loadGraph 按 name 反查。
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { GraphStore } from '../src/store/graph-store.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { agingWeightOf } from '../src/stats.js';
import type { MemoryRecord } from '../src/types.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS l1_records (
    record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT DEFAULT '',
    priority INTEGER DEFAULT 50, scene_name TEXT DEFAULT '', session_id TEXT DEFAULT 'default',
    version INTEGER NOT NULL DEFAULT 0, timestamp_str TEXT DEFAULT '', timestamp_start TEXT DEFAULT '',
    timestamp_end TEXT DEFAULT '', created_time TEXT DEFAULT '', updated_time TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '{}', family TEXT NOT NULL DEFAULT 'chat'
  );
`;

function rec(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    content: `记忆 ${id}`,
    type: 'episodic',
    priority: 60,
    scene_name: '默认',
    timestamps: [Date.parse('2026-09-06T07:00:00.000Z')],
    createdAt: Date.parse('2026-09-06T07:00:00.000Z'),
    updatedAt: Date.parse('2026-09-06T07:00:00.000Z'),
    ...overrides,
  };
}

const PROJ = (ref: string, recIds: string[]) => ({
  ref, name: `NAME_${ref}`, type: 'person' as const, sourceRecordIds: recIds,
});

/** 投影一组节点并返回 name → 投影节点 id 映射。 */
function project(g: GraphStore, nodes: Array<{ ref: string; recIds: string[] }>): Map<string, string> {
  const allRecIds = [...new Set(nodes.flatMap((n) => n.recIds))];
  g.queueGraphProjection(allRecIds, 10000);
  const c = g.claimNext()!;
  g.complete(
    c.job.id,
    { reason: '', nodes: nodes.map((n) => PROJ(n.ref, n.recIds)), edges: [] },
    { now: '2026-09-06T08:00:00.000Z' },
  );
  const map = new Map<string, string>();
  for (const n of g.loadGraph().nodes) map.set(n.name, n.id);
  return map;
}

describe('sourceMeta 三通道（hall）', () => {
  it('hall 众数 + 平票词表序 + 非法值不计票', () => {
    const db = new MemoryDb(':memory:', 0);
    db.init();
    db.upsertL1(rec('r-w1', { metadata: { hall: 'work' } }));
    db.upsertL1(rec('r-w2', { metadata: { hall: 'work' } }));
    db.upsertL1(rec('r-fin', { metadata: { hall: 'finance' } }));
    db.upsertL1(rec('r-jour', { metadata: { hall: 'journey' } }));
    db.upsertL1(rec('r-bad', { metadata: { hall: '不是合法hall' } }));
    db.upsertL1(rec('r-num', { metadata: { hall: 42 } }));

    const ids = project(db.graphStore, [
      { ref: 'majority', recIds: ['r-w1', 'r-w2', 'r-fin', 'r-bad', 'r-num'] }, // work×2 > finance×1,非法不计票
      { ref: 'single', recIds: ['r-jour'] },
      { ref: 'tie', recIds: ['r-fin', 'r-jour'] }, // 平票 → 词表序 finance(第6) < journey(第8)
    ]);
    const meta = db.graphStore.sourceMeta();
    expect(meta.get(ids.get('NAME_majority')!)?.hall).toBe('work');
    expect(meta.get(ids.get('NAME_single')!)?.hall).toBe('journey');
    expect(meta.get(ids.get('NAME_tie')!)?.hall).toBe('finance');
    db.close();
  });

  it('平票反向序: relationships(第2) vs journey(第8) → relationships', () => {
    const raw = new DatabaseSync(':memory:', { allowExtension: false });
    raw.exec(SCHEMA);
    const ins = raw.prepare(`INSERT INTO l1_records (record_id, content, updated_time, metadata_json) VALUES (?, ?, '2026-09-06T07:00:00.000Z', ?)`);
    ins.run('r-rel', 'a', JSON.stringify({ hall: 'relationships' }));
    ins.run('r-jou', 'b', JSON.stringify({ hall: 'journey' }));
    const gs = new GraphStore();
    gs.init(raw);
    const ids = project(gs, [{ ref: 'tie2', recIds: ['r-rel', 'r-jou'] }]);
    const meta = gs.sourceMeta();
    expect(meta.get(ids.get('NAME_tie2')!)?.hall).toBe('relationships');
    expect(meta.get(ids.get('NAME_tie2')!)?.ms).not.toBeNull();
    gs.close();
    raw.close();
  });

  it('全空不入表;仅 hall 有值(无时间戳无场景)也入表', () => {
    const raw = new DatabaseSync(':memory:', { allowExtension: false });
    raw.exec(SCHEMA);
    const ins = raw.prepare(`INSERT INTO l1_records (record_id, content, scene_name, updated_time, metadata_json) VALUES (?, ?, ?, ?, ?)`);
    ins.run('r-bare', '裸', '', '', '{}');                       // 全空 → 不入表
    ins.run('r-hallOnly', '只有hall', '', '', JSON.stringify({ hall: 'learning' })); // 仅 hall → 入表
    const gs = new GraphStore();
    gs.init(raw);
    const ids = project(gs, [
      { ref: 'bare', recIds: ['r-bare'] },
      { ref: 'hallOnly', recIds: ['r-hallOnly'] },
    ]);
    const meta = gs.sourceMeta();
    expect(meta.has(ids.get('NAME_bare')!)).toBe(false);
    const h = meta.get(ids.get('NAME_hallOnly')!);
    expect(h?.hall).toBe('learning');
    expect(h?.ms).toBeNull();
    expect(h?.scene).toBeNull();
    gs.close();
    raw.close();
  });

  it('有 scene 无时间戳也入表(ms=null)——判据放宽的回归钉', () => {
    const raw = new DatabaseSync(':memory:', { allowExtension: false });
    raw.exec(SCHEMA);
    raw.prepare(`INSERT INTO l1_records (record_id, content, scene_name, updated_time, metadata_json) VALUES ('r-sc', '有场景', '字节岗位', '', '{}')`).run();
    const gs = new GraphStore();
    gs.init(raw);
    const ids = project(gs, [{ ref: 'sc', recIds: ['r-sc'] }]);
    const meta = gs.sourceMeta();
    const m = meta.get(ids.get('NAME_sc')!);
    expect(m?.scene).toBe('字节岗位');
    expect(m?.ms).toBeNull();
    gs.close();
    raw.close();
  });

  it('aging 通道容忍: agingWeightOf(undefined) 不抛且被下限兜底(0.2);端点层对 ms:null 短路返 null', () => {
    // 库函数本身:undefined 时间戳不抛,0.5^极大 → 下限兜底
    expect(agingWeightOf(undefined, 30, Date.now(), 0.2)).toBe(0.2);
    // 端点层注入体与 stats.ts 相同的短路逻辑:ms==null → null
    const halfLife = 30;
    const inject = (m: { ms: number | null } | undefined) =>
      m == null || m.ms == null ? null : agingWeightOf(m.ms, halfLife, undefined, 0.2);
    expect(inject(undefined)).toBeNull();
    expect(inject({ ms: null })).toBeNull();
    expect(inject({ ms: Date.now() })).not.toBeNull();
  });
});
