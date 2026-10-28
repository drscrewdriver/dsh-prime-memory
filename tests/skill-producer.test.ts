/**
 * 轨2 技能结晶生产者（`src/skills/producer.ts`）单测。
 *
 * 存在理由：issue #15 的根因是"检测函数在、生产者不在"——`detectCandidates` 与
 * `SkillStore.create()` 此前**只有测试调用**。所以本文件的断言重心不是"函数返回什么"，
 * 而是"磁盘上到底有没有生成 skills.json、evidence 行有没有长出来"。
 *
 * 覆盖 checklist 的 M1/M2/M5–M12、M19–M21 与失败隔离；runner 侧接线（M3/M14）由
 * 全量套件的 store 桩（不含 `skills` 字段）继续跑绿来证明，另以 grep 校验调用点存在。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectCandidates } from '../src/skills/crystallize.js';
import { createSkillProducer } from '../src/skills/producer.js';
import { SkillStore } from '../src/store/skill-store.js';
import type { L1Store } from '../src/store/l1.js';
import type { MemoryConfig } from '../src/config.js';
import type { MemoryLogger, MemoryRecord } from '../src/types.js';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'dsh-skprod-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

type SkillsCfg = MemoryConfig['skills'];

/** 与 config.ts 的缺省档一致（enabled 这里手动开，因为生产者首行就判它）。 */
function cfgOf(over: Partial<SkillsCfg> = {}): SkillsCfg {
  return {
    enabled: true, inject: true, allowPromote: false, minSessions: 3, minEvidence: 5,
    maxPerTurnBytes: 600, maxSkillCatalogBytes: 2048, excerptChars: 240, idleArchiveDays: 90,
    ...over,
  } as SkillsCfg;
}

function rec(id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, content, type: 'work_method', priority: 50, scene_name: '',
    timestamps: [], createdAt: 0, updatedAt: 0, ...over,
  } as unknown as MemoryRecord;
}

/** L1 桩：生产者只用到 allLite / getByIds / countByType 三个面。 */
function l1Stub(rows: readonly MemoryRecord[]): L1Store {
  return {
    allLite: (limit: number, offset: number) =>
      rows.slice(offset, offset + limit).map((r) => ({ id: r.id, type: r.type, metadata: r.metadata ?? {} })),
    getByIds: (ids: readonly string[]) => rows.filter((r) => ids.includes(r.id)),
    countByType: (t: string) => rows.filter((r) => r.type === t).length,
  } as unknown as L1Store;
}

async function freshStore(): Promise<SkillStore> {
  const s = new SkillStore(await tmp());
  await s.init();
  return s;
}

describe('ingestRound：把候选真的写进磁盘', () => {
  it('本轮 work_method → skills.json 落盘、candidate 生成、evidence 非空', async () => {
    const dir = await tmp();
    const skills = new SkillStore(dir);
    await skills.init();
    const p = createSkillProducer({ skills, l1: l1Stub([]), cfg: () => cfgOf(), logger: noopLogger });

    const s = await p.ingestRound([rec('r1', '先跑 lint 再 test', { scene_name: 'repo-A' })], 'sess-1', 'run-1');
    expect(s.created).toBe(1);
    expect(s.appended).toBe(1);

    const list = skills.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('candidate');
    expect(list[0]!.id.startsWith('skx-')).toBe(true);
    // M2：晋升判据只认 evidence 行，不看 evidenceRecordIds
    expect(skills.sessionCount(list[0]!.id)).toBe(1);
    expect(skills.evidenceCount(list[0]!.id)).toBe(1);

    // issue #15 的核心症状就是这文件不存在
    const raw = JSON.parse(await readFile(join(dir, 'skills.json'), 'utf8')) as { skills: unknown[]; evidence: unknown[] };
    expect(raw.skills).toHaveLength(1);
    expect(raw.evidence).toHaveLength(1);
  });

  it('非 work_method 类型与空正文被忽略，不产生技能', async () => {
    const skills = await freshStore();
    const p = createSkillProducer({ skills, l1: l1Stub([]), cfg: () => cfgOf(), logger: noopLogger });
    const s = await p.ingestRound(
      [rec('a', '事实正文', { type: 'work_fact' }), rec('b', '   '), rec('c', '偏好', { type: 'preference' })],
      'sess-1', 'run-1',
    );
    expect(s.scanned).toBe(3);
    expect(s.methods).toBe(0);
    expect(s.created).toBe(0);
    expect(skills.list()).toHaveLength(0);
  });

  it('开关关闭时零动作（不建候选、不投证据）', async () => {
    const skills = await freshStore();
    const p = createSkillProducer({ skills, l1: l1Stub([]), cfg: () => cfgOf({ enabled: false }), logger: noopLogger });
    const s = await p.ingestRound([rec('r1', '方法甲', { scene_name: 'repo-A' })], 'sess-1', 'run-1');
    expect(s.created).toBe(0);
    expect(s.appended).toBe(0);
    expect(skills.list()).toHaveLength(0);
  });

  it('同组重复检测得到同一 id，且不重复灌证据', async () => {
    const skills = await freshStore();
    const p = createSkillProducer({ skills, l1: l1Stub([]), cfg: () => cfgOf(), logger: noopLogger });
    const rows = [rec('r1', '先跑 lint 再 test', { scene_name: 'repo-A' })];

    const first = await p.ingestRound(rows, 'sess-1', 'run-1');
    const second = await p.ingestRound(rows, 'sess-1', 'run-2');
    expect(second.created).toBe(0);
    expect(second.appended).toBe(0);
    expect(second.candidatesTouched).toBe(1);

    const list = skills.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).not.toBe('');
    expect(first.created).toBe(1);
    // 同一 (skill, session, record) 只有一条证据
    expect(skills.evidenceCount(list[0]!.id)).toBe(1);
  });

  it('候选 id 与 detectCandidates 逐字相同（两路径不得漂移）', async () => {
    const skills = await freshStore();
    const p = createSkillProducer({ skills, l1: l1Stub([]), cfg: () => cfgOf(), logger: noopLogger });
    const row = rec('r1', '统一走 tsdown 打包', { scene_name: 'build', metadata: { hall: 'work' } });
    await p.ingestRound([row], 'sess-1', 'run-1');

    const [expected] = detectCandidates(
      [{ id: 'r1', content: '统一走 tsdown 打包', sessionId: 'sess-1', hall: 'work', sceneName: 'build' }],
      { minSessions: 1, minEvidence: 1 },
    );
    expect(skills.list()[0]!.id).toBe(expected!.id);
  });

  it('跨会话累积 distinct-session；allowPromote 关时恒 candidate', async () => {
    const skills = await freshStore();
    const p = createSkillProducer({ skills, l1: l1Stub([]), cfg: () => cfgOf({ allowPromote: false }), logger: noopLogger });
    for (const sid of ['s1', 's2', 's3']) {
      await p.ingestRound([rec(`r-${sid}`, `方法 ${sid} 的描述`, { scene_name: 'repo-A' })], sid, `run-${sid}`);
    }
    const list = skills.list();
    expect(list).toHaveLength(1);
    expect(skills.sessionCount(list[0]!.id)).toBe(3);
    expect(list[0]!.status).toBe('candidate');
  });

  it('allowPromote 开且双阈满足 → 晋升 active；只满足会话数不满足证据数则不动', async () => {
    const skills = await freshStore();
    const p = createSkillProducer({
      skills, l1: l1Stub([]), cfg: () => cfgOf({ allowPromote: true, minSessions: 2, minEvidence: 3 }), logger: noopLogger,
    });
    // 两个会话、各一条 → 证据 2 < minEvidence 3：不该晋升
    await p.ingestRound([rec('r1', '同一 SOP 表述', { scene_name: 'repo-A' })], 's1', 'run-1');
    await p.ingestRound([rec('r2', '同一 SOP 表述', { scene_name: 'repo-A' })], 's2', 'run-2');
    let list = skills.list();
    expect(skills.sessionCount(list[0]!.id)).toBe(2);
    expect(list[0]!.status).toBe('candidate');

    // 第三个会话补一条 → 证据 3 达标 → 晋升
    await p.ingestRound([rec('r3', '同一 SOP 表述', { scene_name: 'repo-A' })], 's3', 'run-3');
    list = skills.list();
    expect(list[0]!.status).toBe('active');
  });

  it('body 是人编辑区：二次检测只重写 steps', async () => {
    const skills = await freshStore();
    const p = createSkillProducer({ skills, l1: l1Stub([]), cfg: () => cfgOf(), logger: noopLogger });
    await p.ingestRound([rec('r1', '原始表述', { scene_name: 'repo-A' })], 's1', 'run-1');
    const id = skills.list()[0]!.id;
    await skills.update(id, { body: '人工撰写的技能说明' });

    await p.ingestRound([rec('r2', '新增一条步骤', { scene_name: 'repo-A' })], 's2', 'run-2');
    const after = skills.get(id)!;
    expect(after.body).toBe('人工撰写的技能说明');
    expect(after.steps).toContain('新增一条步骤');
  });
});

describe('backfill：从锚点复原历史会话归属', () => {
  it('一条记录映射到多个会话 → 各投一条证据（三元组去重生效）', async () => {
    const skills = await freshStore();
    const rows = [rec('h1', '发布前跑冒烟', {
      scene_name: 'release',
      metadata: { dsh_source_anchors: [{ sessionId: 's1', turn: 1 }, { sessionId: 's2', turn: 3 }] },
    })];
    const p = createSkillProducer({ skills, l1: l1Stub(rows), cfg: () => cfgOf(), logger: noopLogger });
    const r = await p.backfill();
    expect(r.created).toBe(1);
    expect(r.appended).toBe(2);
    const id = skills.list()[0]!.id;
    // 按二元组去重会抹掉第二个会话，distinct-session 正是晋升判据
    expect(skills.sessionCount(id)).toBe(2);
  });

  it('缺锚点的记录被跳过并计数，不伪造会话归属', async () => {
    const skills = await freshStore();
    const rows = [rec('h1', '没有锚点的历史方法', { scene_name: 'x' })];
    const p = createSkillProducer({ skills, l1: l1Stub(rows), cfg: () => cfgOf(), logger: noopLogger });
    const r = await p.backfill();
    expect(r.skippedNoAnchor).toBe(1);
    expect(r.created).toBe(0);
    expect(skills.list()).toHaveLength(0);
  });

  it('分页扫描：小 page 覆盖全部记录；maxRecords 到顶即截断', async () => {
    const skills = await freshStore();
    const rows = Array.from({ length: 10 }, (_, i) => rec(`h${i}`, `方法 ${i}`, {
      scene_name: 'repo',
      metadata: { dsh_source_anchors: [{ sessionId: `s${i}`, turn: 1 }] },
    }));
    const paged = createSkillProducer({ skills, l1: l1Stub(rows), cfg: () => cfgOf(), logger: noopLogger });
    const r1 = await paged.backfill({ page: 3 });
    expect(r1.truncated).toBe(false);
    expect(r1.pages).toBe(5); // 3+3+3+1 → 再一页空才收
    expect(r1.created).toBe(1); // 同 scene 聚成一个候选
    expect(skills.sessionCount(skills.list()[0]!.id)).toBe(10);

    const small = new SkillStore(await tmp());
    await small.init();
    const p2 = createSkillProducer({ skills: small, l1: l1Stub(rows), cfg: () => cfgOf(), logger: noopLogger });
    const r2 = await p2.backfill({ page: 3, maxRecords: 2 });
    expect(r2.truncated).toBe(true);
    expect(r2.pages).toBe(1);
  });

  it('backfill 之后再走增量，不重复灌同一证据', async () => {
    const skills = await freshStore();
    const row = rec('h1', '同一方法', {
      scene_name: 'repo',
      metadata: { dsh_source_anchors: [{ sessionId: 's1', turn: 1 }] },
    });
    const p = createSkillProducer({ skills, l1: l1Stub([row]), cfg: () => cfgOf(), logger: noopLogger });
    await p.backfill();
    expect(skills.evidenceCount(skills.list()[0]!.id)).toBe(1);

    await p.ingestRound([row], 's1', 'run-9');
    expect(skills.list()).toHaveLength(1);
    expect(skills.evidenceCount(skills.list()[0]!.id)).toBe(1);
  });
});

describe('失败隔离：技能结晶绝不抛穿蒸馏轮次', () => {
  it('create 抛"达上限"时停止本轮并记入 errors，不冒泡', async () => {
    const real = await freshStore();
    const throwing = {
      get: () => undefined,
      list: () => real.list(),
      sessionCount: (id: string) => real.sessionCount(id),
      evidenceCount: (id: string) => real.evidenceCount(id),
      hasEvidence: () => false,
      create: async () => { throw new Error('技能数已达上限（500），请归档部分'); },
      update: async () => true,
      appendEvidence: async () => 0,
      tryPromote: async () => false,
    } as unknown as SkillStore;
    const p = createSkillProducer({ skills: throwing, l1: l1Stub([]), cfg: () => cfgOf(), logger: noopLogger });
    const s = await p.ingestRound([rec('r1', '方法甲', { scene_name: 'repo-A' })], 's1', 'run-1');
    expect(s.stoppedAtCap).toBe(true);
    expect(s.errors.length).toBeGreaterThan(0);
  });

  it('update 抛错被消化为 errors，证据仍照投且不外抛', async () => {
    const skills = await freshStore();
    let appended = 0;
    // get() 总返回一个已存在候选 → 强制走「只重写 steps」分支，不碰 create。
    const flaky = {
      get: (id: string) => ({ id, title: '既有候选', status: 'candidate', body: '人工正文', steps: [] }),
      list: () => skills.list(),
      sessionCount: (id: string) => skills.sessionCount(id),
      evidenceCount: (id: string) => skills.evidenceCount(id),
      hasEvidence: () => false,
      create: async () => { throw new Error('不该被调用'); },
      update: async () => { throw new Error('磁盘忙'); },
      appendEvidence: async () => {
        appended += 1;
        return appended;
      },
      tryPromote: async () => false,
    } as unknown as SkillStore;
    const p = createSkillProducer({ skills: flaky, l1: l1Stub([]), cfg: () => cfgOf(), logger: noopLogger });
    const s = await p.ingestRound([rec('r1', '方法甲', { scene_name: 'repo-A' })], 's1', 'run-1');
    expect(s.errors.some((e) => e.includes('磁盘忙'))).toBe(true);
    expect(s.candidatesTouched).toBe(1);
    // 写步骤失败不能连带吞掉证据：否则 distinct-session 永远不增长
    expect(s.appended).toBe(1);
  });

  it('status 报告 wired，并带出回灌时间', async () => {
    const skills = await freshStore();
    const rows = [rec('h1', '方法', { scene_name: 'r', metadata: { dsh_source_anchors: [{ sessionId: 's1', turn: 1 }] } })];
    const p = createSkillProducer({ skills, l1: l1Stub(rows), cfg: () => cfgOf(), logger: noopLogger });
    expect(p.status().wired).toBe(true);
    expect(p.status().backfilledAt).toBeUndefined();
    await p.backfill();
    expect(typeof p.status().backfilledAt).toBe('string');
    await p.ingestRound([rec('h2', '方法乙', { scene_name: 'r' })], 's2', 'run-2');
    expect(typeof p.status().lastRoundAt).toBe('string');
  });
});
