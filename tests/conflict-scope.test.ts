/**
 * T0.9 判据:conflict_pending 的**展示与裁决**两端都带可见范围维度
 * (ADR-0008 条 82-84 登记的欠账:项目 A 冻结的对不得在项目 B 展示或裁决)。
 *
 * 三条边界都要钉:
 * ① 不带 workspaceId = 不过滤(与改前逐字一致,既有部署零漂移);
 * ② 任一方记录在场且不可见 → 整对隐去/拒裁(按单条过滤会把一对拆开仍泄露对手正文);
 * ③ 双方记录都已不在库(物理清理)→ 可见(无内容可泄,拦住反而把存量对锁死)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { conflictPairId } from '../src/store/conflicts.js';
import { listConflictPairs, resolveConflictPair } from '../src/conflict-service.js';
import type { MemoryRecord } from '../src/types.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
const ROOT: string[] = [];
afterAll(async () => {
  for (const d of ROOT) await rm(d, { recursive: true, force: true });
});

function row(id: string, content: string, scope: 'global' | 'workspace', workspaceId: string): MemoryRecord {
  const t = 1_700_000_000_000;
  return {
    id, content, type: 'work_fact', priority: 60, scene_name: 's',
    timestamps: [t], createdAt: t, updatedAt: t, family: 'work', scope, workspaceId,
  };
}

async function setup(opts: { loserGone?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-conflict-scope-'));
  ROOT.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'm.db'), 0);
  db.init();
  const store = new L1Store(dataDir, db, undefined, 'keyword', noopLogger as never, 0);
  await store.init();
  const rows: MemoryRecord[] = [row('w1', '项目 A 的事实:部署走 nginx', 'workspace', 'E:\\projA')];
  if (!opts.loserGone) rows.push(row('l1', '项目 A 的旧事实:部署走 caddy', 'workspace', 'E:\\projA'));
  db.upsertL1Batch(rows);
  store.recordConflictPending([
    { pairId: conflictPairId('run1', 'w1', 'l1'), runId: 'run1', winnerId: 'w1', loserId: 'l1', createdAt: new Date().toISOString(), resolvedAt: '', resolution: '' },
  ]);
  return { db, store };
}

const listDeps = (store: L1Store) => ({ l1: store, conflictFreezeEnabled: true });

describe('conflict 可见范围(T0.9)', () => {
  it('展示侧:不带 workspaceId 恒可见(零漂移);跨项目不可见;本项目可见', async () => {
    const { db, store } = await setup();
    try {
      expect(listConflictPairs(listDeps(store), {}).items).toHaveLength(1);
      expect(listConflictPairs(listDeps(store), { workspaceId: 'E:\\projB' }).items).toHaveLength(0);
      expect(listConflictPairs(listDeps(store), { workspaceId: 'E:\\projA' }).items).toHaveLength(1);
      // global 记录不受工作区过滤影响(判据是 isScopeVisible,不是等值比较)
      db.upsertL1Batch([row('w2', '全局事实', 'global', ''), row('l2', '全局旧事实', 'global', '')]);
      store.recordConflictPending([
        { pairId: conflictPairId('run2', 'w2', 'l2'), runId: 'run2', winnerId: 'w2', loserId: 'l2', createdAt: new Date().toISOString(), resolvedAt: '', resolution: '' },
      ]);
      const inB = listConflictPairs(listDeps(store), { workspaceId: 'E:\\projB' });
      expect(inB.items.map((p) => p.pair_id)).toEqual([conflictPairId('run2', 'w2', 'l2')]);
      expect(inB.total).toBe(1); // 过滤态 total 只数扫描窗内可见项,不掺全库计数
    } finally {
      db.close();
    }
  });

  it('裁决侧同一判据:跨项目裁决被拒且不落任何标记;同项目照常', async () => {
    const { db, store } = await setup();
    try {
      const pairId = conflictPairId('run1', 'w1', 'l1');
      const r = await resolveConflictPair({ l1: store, conflictFreezeEnabled: true, workspaceId: 'E:\\projB' }, pairId, 'winner');
      expect(r.notice).toContain('可见范围');
      expect(r.resolved_at).toBe('');
      expect(store.getByIds(['l1'])[0]?.metadata?.dsh_superseded).toBeUndefined(); // 败方未被退场

      const ok = await resolveConflictPair({ l1: store, conflictFreezeEnabled: true, workspaceId: 'E:\\projA' }, pairId, 'winner');
      expect(ok.resolved_at).not.toBe('');
      expect(ok.removed_record_id).toBe('l1');
    } finally {
      db.close();
    }
  });

  it('双方记录都取不到(已物理清理/从未入库)→ 仍可展示(无内容可泄,不得锁死存量对)', async () => {
    const { db, store } = await setup({ loserGone: true });
    try {
      // 新造一对:双方 id 在检索库里都不存在
      store.recordConflictPending([
        { pairId: conflictPairId('run3', 'gone-w', 'gone-l'), runId: 'run3', winnerId: 'gone-w', loserId: 'gone-l', createdAt: new Date().toISOString(), resolvedAt: '', resolution: '' },
      ]);
      const inAny = listConflictPairs(listDeps(store), { workspaceId: 'E:\\anything' });
      const pairIds = inAny.items.map((p) => p.pair_id);
      expect(pairIds).toContain(conflictPairId('run3', 'gone-w', 'gone-l')); // 无记录可泄 → 可见
      expect(pairIds).not.toContain(conflictPairId('run1', 'w1', 'l1')); // w1 在场且属 projA → 隐去
    } finally {
      db.close();
    }
  });
});
