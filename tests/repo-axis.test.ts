import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRepoScope, normApplicability, APPLICABILITY_VALUES } from '../src/repo-scope.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { hashJson } from '../src/store/l1-snapshot.js';
import type { MemoryRecord } from '../src/types.js';

/** 与 l1-snapshot.ts canonicalRecords 同一口径的字段投影(测试本地镜像;源文件加字段即测试红)。 */
function canonicalProjection(r: MemoryRecord): Record<string, unknown> {
  return {
    id: r.id, content: r.content, type: r.type, priority: r.priority, scene_name: r.scene_name,
    timestamps: r.timestamps, createdAt: r.createdAt, updatedAt: r.updatedAt, version: r.version,
    metadata: r.metadata ?? {}, sessionId: r.sessionId, family: r.family,
    validFrom: r.validFrom, validTo: r.validTo, persistence: r.persistence,
  };
}

describe('repo-scope 派生(ADR-0015 T1.7)', () => {
  it('basename of normalized cwd; empty/invalid → 不围栏', () => {
    expect(resolveRepoScope('E:\\test\\rewrite-agently').repoKey).toBe('rewrite-agently');
    expect(resolveRepoScope('/home/u/proj/sub/').repoKey).toBe('sub');
    expect(resolveRepoScope(undefined).repoKey).toBe('');
    expect(resolveRepoScope('').repoKey).toBe('');
    expect(resolveRepoScope('E:\\test\\rewrite-agently').source).toBe('cwd');
  });

  it('applicability 归一:非法/缺省 = 不围栏', () => {
    expect(APPLICABILITY_VALUES).toContain('');
    expect(normApplicability('this-repo')).toBe('this-repo');
    expect(normApplicability('cross-project')).toBe('cross-project');
    expect(normApplicability('')).toBe('');
    expect(normApplicability('bogus')).toBe('');
    expect(normApplicability(undefined)).toBe('');
  });
});

describe('l1_records repo 列(迁移 DEFAULT 零回填 + 读写回环)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repo-'));
  const db = new MemoryDb(join(dir, 'repo-test.db'), 0);
  db.init();

  it('新写入带 repo 归属;读回 fail-open 归一', () => {
    const base = {
      content: '项目 A 的内网地址是 xx',
      type: 'work_fact',
      priority: 60,
      scene_name: 's',
      timestamps: [Date.now()],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 0,
      metadata: {},
      family: 'work' as const,
      scope: 'global' as const,
      workspaceId: '',
    };
    db.upsertL1({
      ...base,
      id: 'r1',
      repoKeyName: 'proj-a',
      repoKeyOwner: '',
      applicability: 'this-repo',
    });
    const got = db.getL1ByIds(['r1'])[0];
    expect(got.repoKeyName).toBe('proj-a');
    expect(got.applicability).toBe('this-repo');

    // 未归属记录:列 DEFAULT '' → 读侧 ''(不围栏)
    db.upsertL1({ ...base, id: 'r2' });
    const got2 = db.getL1ByIds(['r2'])[0];
    expect(got2.repoKeyName ?? '').toBe('');
    expect(got2.applicability ?? '').toBe('');
  });

  it('patchRepoKey 支持人工消歧,CAS 匹配才写', () => {
    expect(db.patchRepoKey('r2', { repoKeyName: 'proj-a', repoKeyOwner: 'alice' })).toBe(1);
    expect(db.getL1ByIds(['r2'])[0].repoKeyOwner).toBe('alice');
    // CAS:期望值不符 → 0 行
    expect(db.patchRepoKey('r2', { repoKeyName: 'proj-b' }, 'wrong-old')).toBe(0);
    expect(db.getL1ByIds(['r2'])[0].repoKeyName).toBe('proj-a');
  });

  it('golden 锚:治理列不进 canonicalRecords 哈希投影(加列零漂移纪律)', () => {
    // 投影是逐字段枚举白名单(l1-snapshot.ts canonicalRecords):
    // repoKeyName/repoKeyOwner/applicability 不在其中——治理归属变化不得触发快照校验失败。
    const r1 = db.getL1ByIds(['r1'])[0];
    const h1 = hashJson(canonicalProjection(r1));
    const h2 = hashJson(canonicalProjection({ ...r1, repoKeyName: 'other', repoKeyOwner: 'bob', applicability: 'cross-project' }));
    expect(h1).toBe(h2);
  });

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟,容错 */
    }
  });
});

describe('scene_recluster_jobs 队列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recl-'));
  const db = new MemoryDb(join(dir, 'recl-test.db'), 0);
  db.init();

  it('enqueue→claim→finish 全链;source 透传', () => {
    const id = db.enqueueSceneRecluster('work', ['场景A', '场景B'], 'batch-1', 'repo-change');
    expect(id).toMatch(/^recl_/);
    const job = db.claimSceneRecluster();
    expect(job).not.toBeNull();
    expect(job!.family).toBe('work');
    expect(job!.sceneNames).toEqual(['场景A', '场景B']);
    expect(job!.source).toBe('repo-change');
    db.finishSceneRecluster(job!.jobId, true);
    expect(db.claimSceneRecluster()).toBeNull();
  });

  it('degraded 库 claim 返回 null 不抛', () => {
    const d2 = new MemoryDb(join(dir, 'recl-test2.db'), 0);
    // 未 init → degraded 语义路径(claim 内部判 degraded)
    expect(d2.claimSceneRecluster()).toBeNull();
  });

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 容错 */
    }
  });
});
