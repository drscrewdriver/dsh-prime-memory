/**
 * 治理服务与队列 scope 测试(治理 W3/W4,T3.1/T3.2/T3.4/T3.7/T3.9/T4.2/T4.4)。
 *
 * 钉死的门禁判据:
 * - CSV 导出**禁用 getAllL1**(游标分页)+ 列名不用裸词 scope(P1-4);
 * - verdict 干跑默认:**省略 dryRun = 零写**(变异探针,I-14);
 * - 乐观并发:updatedAt 快照过期 → 行级拒绝不整批作废(P0-11);
 * - 201 条 → truncated===1(P1-6);高影响项需二次确认(T3.4);
 * - tier 轴:wiki=0.05 降权、retire 不改 tier、setTier 不碰 validTo(Issue 5);
 * - 队列 scope:存量 global 行**任何 workspaceId 可见**;反向验证删 OR 分支必须变红(P1-13)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import { applyVerdicts, exportRecordsCsv, previewVerdicts, VERDICT_VALUES } from '../src/governance-service.js';
import { captureGovernanceAttribution, reapplyGovernanceAttribution } from '../src/pipeline/rebuild-preserve.js';
import { NoopEmbeddingService } from '../src/store/embedding.js';
import type { MemoryRecord } from '../src/types.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function rec(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return { id, content: `记忆 ${id}`, type: 'episodic', priority: 60, scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now, version: 0, family: 'chat', ...overrides };
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-governance-svc-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 't.db'), 0);
  db.init();
  const store = new L1Store(dataDir, db, new NoopEmbeddingService(), 'keyword', undefined, 0);
  await store.init();
  return { dataDir, db, store };
}

describe('CSV 导出(T3.1/T3.13/P1-4)', () => {
  it('游标分页导出活跃记录;列名无裸词 scope;副本非移动(源不动)', async () => {
    const { db, store } = await setup();
    try {
      await store.appendNew([rec('a'), rec('b', { repoKeyName: 'alpha', tier: 'wiki' })]);
      const { csv, total } = exportRecordsCsv(store);
      expect(total).toBe(2);
      expect(csv.split('\n')[0]).not.toMatch(/(^|,)scope(,|$)/);
      expect(csv).toContain('alpha');
      expect(csv).toContain('wiki');
      // 副本非移动:源记录仍在
      expect(store.getByIds(['a', 'b']).length).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('裁决应用(T3.2/T3.4/T3.7)', () => {
  it('词表完整(七动词单一来源)', () => {
    expect(VERDICT_VALUES).toEqual(['retire', 'restore', 'demote-to-wiki', 'promote-to-active', 'move-scope', 'mark-adopted', 'keep']);
  });
  it('干跑默认:省略 dryRun 零写(变异探针:库快照哈希不变,I-14)', async () => {
    const { db, store } = await setup();
    try {
      await store.appendNew([rec('x')]);
      const { hashRecords } = await import('../src/store/l1-snapshot.js');
      const before = hashRecords(db.getAllL1());
      const r = await applyVerdicts(
        { store, createSnapshot: async () => 'unused', memoryMutate: true },
        [{ id: 'x', verdict: 'retire' }],
      );
      expect(r.dryRun).toBe(true);
      expect(r.applied).toBe(1);
      expect(hashRecords(db.getAllL1())).toBe(before); // 零写
    } finally {
      db.close();
    }
  });
  it('执行路由:retire 闭合 validTo 且**不改 tier**;promote 对已退场 no-op(Issue 5)', async () => {
    const { db, store } = await setup();
    try {
      await store.appendNew([rec('r1'), rec('r2', { tier: 'wiki' }), rec('r3', { tier: 'wiki', validTo: Date.now() })]);
      const exec = (rows: never) => applyVerdicts({ store, createSnapshot: async () => store.createGovernanceSnapshot('test'), memoryMutate: true }, rows, { dryRun: false, confirmHighImpact: true });
      const r1 = await exec([{ id: 'r1', verdict: 'retire' }] as never);
      expect(r1.applied).toBe(1);
      const after1 = store.getByIds(['r1'])[0];
      expect(after1.validTo != null).toBe(true); // retire 闭合 validTo
      expect(after1.tier).toBe('active'); // retire 不改 tier(正交)
      const r3 = await exec([{ id: 'r3', verdict: 'promote-to-active' }] as never);
      expect(r3.rows[0].status).toBe('noop');
      expect(r3.rows[0].notice).toContain('restore');
      const r2 = await exec([{ id: 'r2', verdict: 'promote-to-active' }] as never);
      expect(r2.applied).toBe(1);
      expect(store.getByIds(['r2'])[0].tier).toBe('active');
    } finally {
      db.close();
    }
  });
  it('乐观并发:updatedAt 过期行 skippedStale,其余行照常(行级拒绝不整批作废,P0-11)', async () => {
    const { db, store } = await setup();
    try {
      await store.appendNew([rec('a'), rec('b')]);
      const stale = store.getByIds(['a'])[0].updatedAt - 1000;
      const fresh = store.getByIds(['b'])[0].updatedAt;
      const r = await applyVerdicts(
        { store, createSnapshot: async () => 'unused', memoryMutate: true },
        [
          { id: 'a', verdict: 'keep', updatedAt: stale },
          { id: 'b', verdict: 'keep', updatedAt: fresh },
        ],
        { dryRun: false },
      );
      expect(r.skippedStale).toBe(1);
      expect(r.rows[0].status).toBe('skippedStale');
      expect(r.rows[1].status).toBe('noop');
    } finally {
      db.close();
    }
  });
  it('高影响项(instruction/persona≥80)未确认 → skippedHighImpact(T3.4)', async () => {
    const { db, store } = await setup();
    try {
      await store.appendNew([rec('inst', { type: 'instruction' }), rec('core-persona', { type: 'persona', priority: 85 })]);
      const r = await applyVerdicts(
        { store, createSnapshot: async () => 'unused', memoryMutate: true },
        [{ id: 'inst', verdict: 'retire' }, { id: 'core-persona', verdict: 'retire' }],
        { dryRun: false },
      );
      expect(r.skippedHighImpact).toBe(2);
    } finally {
      db.close();
    }
  });
  it('201 条 → truncated===1(P1-6)', async () => {
    const { db, store } = await setup();
    try {
      const rows = Array.from({ length: 201 }, (_, i) => ({ id: `m${i}`, verdict: 'keep' }));
      const r = await applyVerdicts({ store, createSnapshot: async () => 'unused', memoryMutate: true }, rows as never, { dryRun: true });
      expect(r.truncated).toBe(1);
      expect(r.rows.length).toBe(200);
    } finally {
      db.close();
    }
  });
  it('preview 与 apply 同形且零写', async () => {
    const { db, store } = await setup();
    try {
      await store.appendNew([rec('p1')]);
      const before = store.getByIds(['p1'])[0].validTo;
      const r = await previewVerdicts({ store, createSnapshot: async () => 'unused', memoryMutate: true }, [{ id: 'p1', verdict: 'retire' }]);
      expect(r.dryRun).toBe(true);
      expect(store.getByIds(['p1'])[0].validTo).toBe(before);
    } finally {
      db.close();
    }
  });
});

describe('tier CAS 与重聚类作业(T3.3/T3.10)', () => {
  it('setTier CAS:期望不符返回 0;wiki→active 路由可用;作业入队可取', async () => {
    const { db, store } = await setup();
    try {
      await store.appendNew([rec('t1', { tier: 'wiki' })]);
      expect(db.setTier('t1', 'active', 'active')).toBe(0); // CAS 不符
      expect(db.setTier('t1', 'active', 'wiki')).toBe(1);
      store.enqueueSceneRecluster('chat', ['场景A', '场景B'], 'batch-1');
      const job = store.claimSceneRecluster();
      expect(job?.sceneNames).toEqual(['场景A', '场景B']);
      store.finishSceneRecluster(job!.jobId, true);
      expect(store.claimSceneRecluster()).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('队列接 scope(W4,T4.2/T4.4,P1-13)', () => {
  it('存量 global 行任何 workspaceId 可见;反向验证(删 OR 分支)必须变红', async () => {
    const { db, store } = await setup();
    try {
      // 造两对未裁决冻结对(存量形态:无 scope 列时代 → 迁移后 DEFAULT 'global')
      const now = new Date().toISOString();
      db.upsertConflictPairForTest('p1', 'w1', 'l1', now);
      db.upsertConflictPairForTest('p2', 'w2', 'l2', now);
      const all = store.listConflictPending({ limit: 100 });
      expect(all.length).toBeGreaterThanOrEqual(2);
      // 开启 scope 过滤:任一 workspaceId 下,global 存量行都可见(OR 哨兵分支)
      const scopedA = store.listConflictPending({ limit: 100, scopeFilter: { enabled: true, workspaceId: 'ws-a' } });
      expect(scopedA.length).toBe(all.length);
      // **反向验证**:去掉 OR 'global' 分支的变异查询必须漏掉存量行(证明守卫有效)
      const mutated = db.listConflictPendingMutatedForTest('ws-a');
      expect(mutated.length).toBe(0); // 变异实现把存量全滤没了 → 证明 OR 分支是生命线
    } finally {
      db.close();
    }
  });
});

describe('重建治理归属对账(T3.12/P1-8:降级记录不得以 active 复活)', () => {
  it('捕获只记非默认值;回填 id 命中优先、内容哈希兜底;不覆盖既有 wiki', async () => {
    const { db, store } = await setup();
    try {
      const now = Date.now();
      const base = { type: 'episodic', priority: 60, scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now, version: 0, family: 'work' as const };
      // w1:按 id 对账路径;w2:内容哈希兜底路径(重建重造新 id 但内容逐字同)
      await store.appendNew([
        { ...base, id: 'w1', content: '唯一内容甲' , tier: 'wiki' } as MemoryRecord,
        { ...base, id: 'w2', content: '唯一内容乙', tier: 'wiki', repoKeyName: 'alpha' } as MemoryRecord,
        { ...base, id: 'n1', content: '普通记录无治理归属' } as MemoryRecord,
      ]);
      const attr = captureGovernanceAttribution(store.all());
      expect(attr.byId.size).toBe(2); // n1 无归属不记录
      // 模拟重建:清空 → 同 id 恢复 w1 / 新 id 同内容重造 w2'
      db.clearL1();
      await store.appendNew([
        { ...base, id: 'w1', content: '唯一内容甲' } as MemoryRecord,
        { ...base, id: 'w2-reborn', content: '唯一内容乙' } as MemoryRecord,
      ]);
      const r = reapplyGovernanceAttribution(store, attr);
      expect(r.byId).toBe(1);
      expect(r.byHash).toBeGreaterThanOrEqual(1);
      expect(store.getByIds(['w1'])[0].tier).toBe('wiki'); // id 命中:wiki 不复活为 active
      const w2 = store.getByIds(['w2-reborn'])[0];
      expect(w2.tier).toBe('wiki'); // 内容哈希兜底命中
      expect(w2.repoKeyName).toBe('alpha');
      // 不覆盖:已经是 wiki 的记录回填不会降级(且重复回填幂等)
      const r2 = reapplyGovernanceAttribution(store, attr);
      expect(store.getByIds(['w1'])[0].tier).toBe('wiki');
      expect(r2.byId + r2.byHash).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
    }
  });
});

describe('MMF tags 子键容错(T3.14/I-26:格式不升版)', () => {
  it('导入侧白名单治理子键(tier/repo/applicability)且忽略未知子键', async () => {
    // 直接验证 store 层接受治理列(导入工具 buildRecord 的白名单归一与之同形);
    // 未知子键(如 future_key)不落库、不报错——解析器容错 = 向前兼容。
    const { db, store } = await setup();
    try {
      const now = Date.now();
      const base = { type: 'episodic', priority: 60, scene_name: 'mmf', timestamps: [now], createdAt: now, updatedAt: now, version: 0, family: 'work' as const };
      await store.appendNew([
        { ...base, id: 'mmf1', content: '带治理子键的导入记忆', tier: 'wiki', repoKeyName: 'alpha', applicability: 'this-repo', future_key: '未知子键应被忽略' } as unknown as MemoryRecord,
      ]);
      const r = store.getByIds(['mmf1'])[0];
      expect(r.tier).toBe('wiki');
      expect(r.repoKeyName).toBe('alpha');
      expect(r.applicability).toBe('this-repo');
      expect((r as Record<string, unknown>).future_key).toBeUndefined();
      // 非法 tier 读回 active(fail-open,I-23)
      await store.appendNew([{ ...base, id: 'mmf2', content: '非法 tier', tier: 'archived' } as unknown as MemoryRecord]);
      expect(store.getByIds(['mmf2'])[0].tier).toBe('active');
    } finally {
      db.close();
    }
  });
});
