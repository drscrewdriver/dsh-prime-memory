/**
 * 治理权重与迁移测试(治理 W1,T1.7/T1.8/T1.10b)。
 *
 * 钉死的门禁判据(checklist G1):
 * - **四象限守卫**:work×global 任何 repo 下 scopeMultiplier≡1;反向验证(改"work 一律
 *   围栏"必须变红,P0-7);
 * - applyGovernanceWeights 是纯函数、只换序不改 score、未进 MemoryDb(grep 守卫);
 * - 治理列迁移幂等;tier/repo 读回 fail-open(tier 缺→active,I-23);
 * - 架构守卫:store 层不 import 治理模块(去重路径免疫的结构性保证,I-1)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryDb } from '../src/store/sqlite.js';
import { applyGovernanceWeights, governanceWeightOf, SCOPE_FENCE_QUADRANTS } from '../src/store/governance.js';
import { markDedupPath } from '../src/store/search-utils.js';
import { normApplicability, resolveRepoScope } from '../src/repo-scope.js';
import type { MemoryRecord } from '../src/types.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function rec(overrides: Partial<MemoryRecord>): MemoryRecord {
  const now = Date.now();
  return {
    id: 'r', content: 'c', type: 'episodic', priority: 50, scene_name: 's',
    timestamps: [now], createdAt: now, updatedAt: now, version: 0, family: 'work',
    ...overrides,
  };
}

describe('resolveRepoScope(T1.7,纯字符串 fail-open)', () => {
  it('basename 派生:Windows/POSIX 两种形态', () => {
    expect(resolveRepoScope('E:\\test\\rewrite-agently').repoKey).toBe('rewrite-agently');
    expect(resolveRepoScope('/home/user/proj-x').repoKey).toBe('proj-x');
    expect(resolveRepoScope('E:\\test\\rewrite-agently\\').repoKey).toBe('rewrite-agently');
  });
  it('缺失/非法 → 空串(不围栏,不抛)', () => {
    expect(resolveRepoScope(undefined).repoKey).toBe('');
    expect(resolveRepoScope('').repoKey).toBe('');
    expect(resolveRepoScope(null).repoKey).toBe('');
    expect(resolveRepoScope(42).repoKey).toBe('');
  });
  it('applicability 归一:非法落空串(宁可漏围栏不可误围栏,P0-7)', () => {
    expect(normApplicability('this-repo')).toBe('this-repo');
    expect(normApplicability('cross-project')).toBe('cross-project');
    expect(normApplicability('workspace')).toBe('');
    expect(normApplicability(undefined)).toBe('');
  });
});

describe('四象限守卫(T1.10b,P0-7 反向验证在内)', () => {
  const CROSS = 0.2;
  it('真值表:chat 不围栏 / work 无 repo 不围栏 / cross-project 绝不围栏 / 同仓不围栏 / 跨仓才减权', () => {
    for (const q of SCOPE_FENCE_QUADRANTS) {
      const w = governanceWeightOf(rec({ family: q.family, repoKeyName: q.repoKeyName, applicability: q.applicability }), {
        enabled: true, currentRepoKey: q.currentRepoKey, crossRepoMultiplier: CROSS,
      });
      expect(w, `${q.family}/${q.repoKeyName}/${q.applicability} vs ${q.currentRepoKey}`).toBe(
        q.expected === 1 ? 1 : CROSS,
      );
    }
  });
  it('**反向验证**:把"work 一律围栏"塞进实现,守卫必须变红(ADR-0012 条4)', () => {
    // 变异实现:无视 applicability/repoKeyName,work 族一律减权(即 P0-7 禁止的塌缩)
    const mutated = (r: MemoryRecord, currentRepoKey: string): number =>
      r.family === 'work' && r.repoKeyName !== currentRepoKey ? 0.2 : 1;
    // 在该变异下,真值表里「work×global 不减权」这一行会由 1 变 0.2 → 守卫能检出
    const workGlobal = rec({ family: 'work', repoKeyName: '', applicability: '' });
    expect(mutated(workGlobal, 'other')).not.toBe(
      governanceWeightOf(workGlobal, { enabled: true, currentRepoKey: 'other', crossRepoMultiplier: 0.2 }),
    );
  });
  it('治理关闭(enabled=false)恒 1;读不到归属(undefined)恒 1(fail-open,I-23)', () => {
    const ctx = { enabled: false, currentRepoKey: 'other', crossRepoMultiplier: 0.2 };
    expect(governanceWeightOf(rec({ family: 'work', repoKeyName: 'alpha' }), ctx)).toBe(1);
    expect(governanceWeightOf(undefined, { enabled: true, currentRepoKey: 'other', crossRepoMultiplier: 0.2 })).toBe(1);
  });
});

describe('applyGovernanceWeights(纯函数,只换序不改 score)', () => {
  const records = new Map<string, MemoryRecord>([
    ['mine', rec({ id: 'mine', repoKeyName: 'alpha' })],
    ['other', rec({ id: 'other', repoKeyName: 'beta' })],
    ['chat', rec({ id: 'chat', family: 'chat', repoKeyName: 'beta' })],
  ]);
  const hits = [
    { id: 'other', score: 0.9 },
    { id: 'mine', score: 0.85 },
    { id: 'chat', score: 0.5 },
  ];
  it('围栏开启:跨仓 work 记录沉底,chat 与同仓不动;score 字段不被改写', () => {
    const out = applyGovernanceWeights(hits, records, { enabled: true, currentRepoKey: 'alpha', crossRepoMultiplier: 0.2 });
    // 加权键:mine 0.85×1 | chat 0.5×1 | other 0.9×0.2=0.18 → 跨仓沉底
    expect(out.map((h) => h.id)).toEqual(['mine', 'chat', 'other']);
    // score 不改写(照 sortByDomainWeight 范式,展示分不变)
    for (const h of out) expect(hits.find((x) => x.id === h.id)!.score).toBe(h.score);
    // 输入数组未被就地修改(纯函数)
    expect(hits.map((h) => h.id)).toEqual(['other', 'mine', 'chat']);
  });
  it('围栏关闭:原样返回(同一引用)', () => {
    expect(applyGovernanceWeights(hits, records, { enabled: false, currentRepoKey: 'alpha', crossRepoMultiplier: 0.2 })).toBe(hits);
  });
  it('**去重路径免疫哨兵**:治理函数在 searchCandidates 路径内自证即抛(I-1)', async () => {
    await expect(
      markDedupPath(async () => {
        applyGovernanceWeights(hits, records, { enabled: true, currentRepoKey: 'alpha', crossRepoMultiplier: 0.2 });
      }),
    ).rejects.toThrow(/applyGovernanceWeights/);
  });
});

describe('架构守卫(grep 级,结构性免疫)', () => {
  it('store 层(sqlite/l1/search-utils)不得 import 治理模块(I-1 的结构性保证)', () => {
    for (const f of ['src/store/sqlite.ts', 'src/store/l1.ts', 'src/store/search-utils.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src.includes('store/governance.js'), `${f} 引用了 governance 权重`).toBe(false);
      expect(src.includes('pipeline/l1-gate.js'), `${f} 引用了写入门`).toBe(false);
    }
    // searchCandidates 的实现文件不得在去重路径上调用治理权重
    const l1src = readFileSync(join(process.cwd(), 'src/store/l1.ts'), 'utf8');
    expect(l1src.includes('applyGovernanceWeights')).toBe(false);
  });
});

describe('治理列迁移(T1.8,幂等 + fail-open 读回)', () => {
  it('新库自带治理列;tier/repo/applicability 写读往返;非法 tier 读回 active', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-governance-mig-'));
    dirs.push(dataDir);
    const db = new MemoryDb(join(dataDir, 't.db'), 0);
    db.init();
    try {
      const now = Date.now();
      const base = { content: '治理往返', type: 'episodic', priority: 50, scene_name: 's', timestamps: [now], createdAt: now, updatedAt: now, version: 0 };
      db.upsertL1({ ...base, id: 'g1', family: 'work', repoKeyName: 'alpha', repoKeyOwner: 'team-a', applicability: 'this-repo', tier: 'wiki' } as MemoryRecord);
      db.upsertL1({ ...base, id: 'g2', family: 'work', tier: 'nonsense' } as MemoryRecord);
      const r1 = db.getL1ByIds(['g1'])[0];
      expect(r1.repoKeyName).toBe('alpha');
      expect(r1.repoKeyOwner).toBe('team-a');
      expect(r1.applicability).toBe('this-repo');
      expect(r1.tier).toBe('wiki');
      // fail-open:非法 tier 读回 active(I-23,绝不让记忆凭空消失)
      expect(db.getL1ByIds(['g2'])[0].tier).toBe('active');
      // 幂等:重复 init 不抛不炸(二次 init 经 close/reopen 模拟)
      db.close();
      const db2 = new MemoryDb(join(dataDir, 't.db'), 0);
      db2.init();
      try {
        expect(db2.getL1ByIds(['g1'])[0].tier).toBe('wiki');
      } finally {
        db2.close();
      }
    } catch (err) {
      db.close();
      throw err;
    }
  });
});
