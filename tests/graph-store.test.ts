/**
 * GraphStore 单元测试:原子提交回滚 / 独立降级 no-op / job 生命周期四件(去重、
 * 优先级不倒挂、attempts 封顶、running 回收)/ 删除传播 / 坏 JSON 容忍 / 清空投影。
 * 用真实 node:sqlite(内存/临时文件),不 mock 引擎。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphStore } from '../src/store/graph-store.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { MemoryRecord } from '../src/types.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-graph-'));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

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

const NODE_PROPOSAL = {
  ref: 'a',
  name: '张三',
  type: 'person',
  sourceRecordIds: ['r1'],
} as const;

function makeRawDb(file: string): DatabaseSync {
  const raw = new DatabaseSync(file, { allowExtension: false });
  raw.exec(`
    CREATE TABLE IF NOT EXISTS l1_records (
      record_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT DEFAULT '',
      priority INTEGER DEFAULT 50,
      scene_name TEXT DEFAULT '',
      session_id TEXT DEFAULT 'default',
      version INTEGER NOT NULL DEFAULT 0,
      timestamp_str TEXT DEFAULT '',
      timestamp_start TEXT DEFAULT '',
      timestamp_end TEXT DEFAULT '',
      created_time TEXT DEFAULT '',
      updated_time TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}',
      family TEXT NOT NULL DEFAULT 'chat'
    );
  `);
  return raw;
}

function insertRawRecord(raw: DatabaseSync, id: string): void {
  raw
    .prepare(
      `INSERT INTO l1_records (record_id, content, type, created_time, updated_time, timestamp_str, metadata_json)
       VALUES (?, ?, 'episodic', '2026-09-06T07:00:00.000Z', '2026-09-06T07:00:00.000Z', '', '{}')`,
    )
    .run(id, `记忆 ${id}`);
}

describe('GraphStore:独立降级 no-op', () => {
  it('init 失败(已关闭连接)→ ready=false,全部读写安全 no-op 不抛', () => {
    const raw = new DatabaseSync(':memory:');
    raw.close();
    const gs = new GraphStore();
    gs.init(raw);
    expect(gs.ready).toBe(false);
    expect(gs.loadGraph()).toEqual({ nodes: [], edges: [] });
    expect(gs.getNode('n1')).toBeNull();
    expect(gs.edgesOf('n1')).toEqual([]);
    expect(gs.searchNodes('张三', 5)).toEqual([]);
    expect(gs.queueGraphProjection(['r1'], 100)).toBe(0);
    expect(gs.claimNext()).toBeNull();
    expect(gs.listJobs()).toEqual([]);
    expect(gs.recoverRunning()).toBe(0);
    expect(gs.queueMissing(100)).toBe(0);
    expect(() => gs.markSourcesDeleted(['r1'])).not.toThrow();
    expect(() => gs.complete('gjob_x', { reason: '', nodes: [], edges: [] })).not.toThrow();
    expect(() => gs.fail('gjob_x', 'err')).not.toThrow();
    expect(() => gs.resetAll()).not.toThrow();
    gs.close();
  });
});

describe('GraphStore:job 生命周期与去重下推', () => {
  it('入队去重:在途 mapping 与已完成投影都阻断重复入队', () => {
    const db = new MemoryDb(join(dir, 'g1.db'), 0);
    db.init();
    db.upsertL1(rec('r1'));
    expect(db.graphStore.queueGraphProjection(['r1'], 10000)).toBe(1);
    expect(db.graphStore.queueGraphProjection(['r1'], 10000)).toBe(0); // 在途去重
    const claim = db.graphStore.claimNext()!;
    expect(claim.job.status).toBe('running');
    expect(claim.records.map((r) => r.id)).toEqual(['r1']);
    expect(db.graphStore.queueGraphProjection(['r1'], 10000)).toBe(0); // running 中仍去重
    db.graphStore.complete(claim.job.id, { reason: '', nodes: [NODE_PROPOSAL], edges: [] }, { now: '2026-09-06T08:00:00.000Z' });
    expect(db.graphStore.loadGraph().nodes).toHaveLength(1);
    expect(db.graphStore.listJobs()[0]!.status).toBe('completed');
    expect(db.graphStore.queueGraphProjection(['r1'], 10000)).toBe(0); // 已投影去重
    db.close();
  });

  it('优先级不倒挂:新蒸馏(10000)先于存量补投影(100)被 claim', () => {
    const db = new MemoryDb(join(dir, 'g2.db'), 0);
    db.init();
    for (const id of ['r-old', 'r-new']) db.upsertL1(rec(id));
    // old 先入队(时间更早),但 new 优先级高
    expect(db.graphStore.queueGraphProjection(['r-old'], 100)).toBe(1);
    expect(db.graphStore.queueGraphProjection(['r-new'], 10000)).toBe(1);
    const first = db.graphStore.claimNext()!;
    expect(first.job.sourceRecordIds).toEqual(['r-new']);
    db.close();
  });

  it('attempts 封顶:三次失败转 dead 放掉 mapping,之后可重新入队;退避窗口内 claim 不到', () => {
    const raw = makeRawDb(join(dir, 'raw-g3.db'));
    insertRawRecord(raw, 'r1');
    const gs = new GraphStore();
    gs.init(raw);
    expect(gs.queueGraphProjection(['r1'], 100)).toBe(1);
    for (let i = 1; i <= 3; i++) {
      const claim = gs.claimNext();
      expect(claim).not.toBeNull();
      gs.fail(claim!.job.id, `模拟失败 ${i}`);
      const job = gs.listJobs()[0]!;
      if (i < 3) {
        expect(job.status).toBe('failed');
        expect(job.nextAttemptAt!).toBeGreaterThan(Date.now()); // 指数退避已设
        expect(gs.claimNext()).toBeNull(); // 退避窗口内不可取
        raw.prepare('UPDATE graph_projection_jobs SET next_attempt_at = 0').run(); // 快进退避
      }
    }
    expect(gs.listJobs()[0]!.status).toBe('dead');
    expect(gs.claimNext()).toBeNull();
    // dead 放掉 mapping:重新入队可行
    expect(gs.queueGraphProjection(['r1'], 100)).toBe(1);
    gs.close();
    raw.close();
  });

  it('来源全缺失 → claim 判 dead 返 null 不抛;部分缺失收缩到现存子集', () => {
    const db = new MemoryDb(join(dir, 'g4.db'), 0);
    db.init();
    // 全缺失
    expect(db.graphStore.queueGraphProjection(['ghost-1'], 100)).toBe(1);
    expect(db.graphStore.claimNext()).toBeNull();
    expect(db.graphStore.listJobs()[0]!.status).toBe('dead');
    // 部分缺失
    db.upsertL1(rec('alive'));
    db.graphStore.queueGraphProjection(['ghost-2', 'alive'], 100);
    const claim = db.graphStore.claimNext()!;
    expect(claim.job.sourceRecordIds).toEqual(['alive']);
    db.close();
  });

  it('recoverRunning:running → pending,重启缝不永久卡批', () => {
    const db = new MemoryDb(join(dir, 'g5.db'), 0);
    db.init();
    db.upsertL1(rec('r1'));
    db.graphStore.queueGraphProjection(['r1'], 100);
    expect(db.graphStore.claimNext()).not.toBeNull();
    expect(db.graphStore.recoverRunning()).toBe(1);
    expect(db.graphStore.listJobs()[0]!.status).toBe('pending');
    expect(db.graphStore.claimNext()).not.toBeNull();
    db.close();
  });

  it('超过 GRAPH_JOB_BATCH(8)条记录分片成多个 job', () => {
    const db = new MemoryDb(join(dir, 'g6.db'), 0);
    db.init();
    const ids = Array.from({ length: 17 }, (_, i) => `r${i}`);
    for (const id of ids) db.upsertL1(rec(id));
    expect(db.graphStore.queueGraphProjection(ids, 100)).toBe(3); // 8+8+1
    db.close();
  });
});

describe('GraphStore:complete 原子性', () => {
  it('注入 idFactory 中途抛错 → 整体回滚:无节点落库、job 保持 running,可重投', () => {
    const db = new MemoryDb(join(dir, 'g7.db'), 0);
    db.init();
    db.upsertL1(rec('r1'));
    db.graphStore.queueGraphProjection(['r1'], 100);
    const claim = db.graphStore.claimNext()!;
    let calls = 0;
    db.graphStore.complete(
      claim.job.id,
      {
        reason: '',
        nodes: [{ ...NODE_PROPOSAL, state: '在职', facts: [{ key: '职业', value: '工程师' }] }],
        edges: [],
      },
      {
        idFactory: (prefix) => {
          if (++calls > 1) throw new Error('模拟序号分配失败');
          return `${prefix}-x`;
        },
      },
    );
    expect(db.graphStore.loadGraph().nodes).toHaveLength(0); // 回滚无残留
    expect(db.graphStore.listJobs()[0]!.status).toBe('running');
    // 正常重投成功
    db.graphStore.complete(claim.job.id, { reason: '', nodes: [NODE_PROPOSAL], edges: [] });
    expect(db.graphStore.loadGraph().nodes).toHaveLength(1);
    db.close();
  });

  it('对非 running job 的 complete 幂等 no-op;record 缺失时 allowed 集不含它(零无来源不破)', () => {
    const db = new MemoryDb(join(dir, 'g8.db'), 0);
    db.init();
    db.upsertL1(rec('r1'));
    db.graphStore.queueGraphProjection(['r1'], 100);
    // 未 claim 直接 complete → no-op
    const jobId = db.graphStore.listJobs()[0]!.id;
    db.graphStore.complete(jobId, { reason: '', nodes: [NODE_PROPOSAL], edges: [] });
    expect(db.graphStore.loadGraph().nodes).toHaveLength(0);
    expect(db.graphStore.listJobs()[0]!.status).toBe('pending');
    db.close();
  });

  it('删除传播:deleteL1Batch 后来源全失效的节点 archived,部分失效保留', () => {
    const db = new MemoryDb(join(dir, 'g9.db'), 0);
    db.init();
    for (const id of ['r1', 'r2']) db.upsertL1(rec(id));
    // 同一实体跨两批重提案(每批只能引用本批来源——零无来源校验),节点来源并集累积
    db.graphStore.queueGraphProjection(['r1'], 100);
    let claim = db.graphStore.claimNext()!;
    db.graphStore.complete(claim.job.id, { reason: '', nodes: [{ ref: 'a', name: '张三', type: 'person', sourceRecordIds: ['r1'] }], edges: [] });
    db.graphStore.queueGraphProjection(['r2'], 100);
    claim = db.graphStore.claimNext()!;
    db.graphStore.complete(claim.job.id, { reason: '', nodes: [{ ref: 'a', name: '张三', type: 'person', sourceRecordIds: ['r2'] }], edges: [] });
    expect(db.graphStore.loadGraph().nodes).toHaveLength(1);
    expect(db.graphStore.loadGraph().nodes[0]!.sourceRecordIds).toEqual(['r1', 'r2']);
    // 删 r1:来源未全失效 → 保持 active
    db.deleteL1Batch(['r1']);
    expect(db.graphStore.loadGraph().nodes[0]!.status).toBe('active');
    // 再删 r2:来源全失效 → archived
    db.deleteL1Batch(['r2']);
    expect(db.graphStore.loadGraph().nodes[0]!.status).toBe('archived');
    db.close();
  });

  it('clearL1 连带清空图谱投影表(可重建投影,记录清空即作废)', () => {
    const db = new MemoryDb(join(dir, 'g10.db'), 0);
    db.init();
    db.upsertL1(rec('r1'));
    db.graphStore.queueGraphProjection(['r1'], 100);
    const claim = db.graphStore.claimNext()!;
    db.graphStore.complete(claim.job.id, { reason: '', nodes: [NODE_PROPOSAL], edges: [] });
    expect(db.graphStore.loadGraph().nodes).toHaveLength(1);
    db.clearL1();
    expect(db.graphStore.loadGraph().nodes).toHaveLength(0);
    expect(db.graphStore.listJobs()).toHaveLength(0);
    // 投影台账已清:同 id 记录重建后可重新入队
    db.upsertL1(rec('r1'));
    expect(db.graphStore.queueGraphProjection(['r1'], 100)).toBe(1);
    db.close();
  });
});

describe('GraphStore:坏 JSON 容忍与族过滤', () => {
  it('坏 JSON 列只损失该行派生信息,不抛;families_json 驱动族过滤(无族信息不可见)', () => {
    const raw = makeRawDb(join(dir, 'raw.db'));
    const gs = new GraphStore();
    gs.init(raw);
    expect(gs.ready).toBe(true);
    raw
      .prepare(
        `INSERT INTO graph_nodes (node_id, name, type, aliases_json, facts_json, families_json)
         VALUES ('n1', '张三', 'person', 'not-json', '{bad', '[]')`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO graph_nodes (node_id, name, type, aliases_json, facts_json, families_json)
         VALUES ('n2', '李四', 'person', '[]', '[]', '["work"]')`,
      )
      .run();
    const nodes = gs.loadGraph().nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.id === 'n1')!.facts).toEqual([]);
    expect(nodes.find((n) => n.id === 'n1')!.aliases).toEqual([]);
    // 不过滤:两节点各自名称命中;族过滤:work 族只见李四;无族信息的 n1 一律不可见(宁漏不串)
    expect(gs.searchNodes('张三 李四', 10).map((n) => n.node.id)).toEqual(['n1', 'n2']); // 不过滤:两节点都有命中
    expect(gs.searchNodes('李四', 10, ['work']).map((n) => n.node.id)).toEqual(['n2']);
    expect(gs.searchNodes('李四', 10, ['chat'])).toHaveLength(0);
    gs.close();
    raw.close();
  });
});
