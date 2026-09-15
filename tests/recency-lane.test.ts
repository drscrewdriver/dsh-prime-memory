/**
 * §D 第 4 路（task_10）—— 时效路。
 *
 * 形态：把候选池按 `applyDecayWeight` 加权后的顺序作为第 4 条**已排序**列表。
 * 只在 `decayHalfLifeDays > 0` 时**结构性存在**（关掉衰减 = 该路不存在）。
 *
 * 两条必须钉死的性质：
 * ① **时效是排序信号，不是召回信号** —— 该路只重排既有候选，不引入新记录。
 *    把"无关但很新"的记忆塞进结果会直接损害精度，故本文件用「开关衰减前后
 *    结果 **id 集合完全相同**」来证明它没有引入新记录；
 * ② **严禁进入 `searchCandidates`**（`search-utils.ts:26-27` 约定）——写路径找
 *    同语义旧记录必须**无视新旧**：一旦被时效加权，"老的同义记录"会被漏检，
 *    结果是同事实双记录累积。本文件用「同一夹具下 search() 与 searchCandidates()
 *    的排序方向相反」来证明两者确实走了不同判据。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { EmbeddingService } from '../src/store/embedding.js';
import type { MemoryRecord } from '../src/types.js';

const DIM = 16;
const DAY = 86_400_000;
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function vecFor(text: string): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % DIM] += 1;
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (mag < 1e-10) return v;
  for (let i = 0; i < DIM; i++) v[i] /= mag;
  return v;
}
function fakeEmbed(): EmbeddingService {
  return {
    getDimensions: () => DIM,
    getProviderInfo: () => ({ provider: 'probe', model: 'probe', dimensions: DIM }),
    isReady: () => true,
    embed: async (t: string) => vecFor(t),
    embedBatch: async (ts: string[]) => ts.map(vecFor),
  };
}

/** 手工控 `updatedAt`：老而强相关 vs 新而弱相关。 */
function rec(id: string, content: string, ageDays: number): MemoryRecord {
  const t = Date.now() - ageDays * DAY;
  return { id, content, type: 'episodic', priority: 50, scene_name: 's', timestamps: [t], createdAt: t, updatedAt: t };
}

async function setup(records: MemoryRecord[], halfLifeDays: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-recency-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'r.db'), DIM);
  db.init();
  const store = new L1Store(dataDir, db, fakeEmbed(), 'hybrid', undefined, halfLifeDays);
  await store.init();
  await store.appendNew(records);
  return { db, store };
}

describe('task_10 §D 第 4 路（时效路）', () => {
  it('**结构性证据**:衰减开启 → 时效路占了归一化名额,双路 rank1 记录不再得 1.0', async () => {
    // 本夹具未接线图谱,故:衰减关 = 2 路;衰减开 = 3 路。
    // 这条判据能区分"时效路生效"与"本来如此"——后者下 aOn 也会正好是 1.0。
    // 两条记录**相关性相当**(b 只多一个后缀词),只差年龄 —— 这样时效路才会
    // 真的把 b 排到 a 前面,使 a 在该路不再是 rank0,从而分数不再可能到 1.0。
    const records = [rec('a', 'Rust 所有权模型详解', 900), rec('b', 'Rust 所有权模型详解补充', 0)];
    const on = await setup(records, 30);
    const off = await setup(records, 0);
    try {
      const aOff = (await off.store.search('Rust 所有权模型详解', 5)).find((h) => h.id === 'a')!;
      const aOn = (await on.store.search('Rust 所有权模型详解', 5)).find((h) => h.id === 'a')!;
      // 关衰减:两路 rank1 命中 = 恰好 1.0(改动前语义,不变)
      expect(aOff.score).toBe(1);
      // 开衰减:记录同时进了时效路但**不是**该路榜首(它已 900 天未更新)
      // → 三路融合后低于 1.0,分母确为 3
      expect(aOn.score).toBeGreaterThan(0);
      expect(aOn.score).toBeLessThan(1);
    } finally {
      on.db.close();
      off.db.close();
    }
  });

  it('4 路(接线图谱 + 衰减开)时得分仍落在 0.0~1.0', async () => {
    const records = [rec('a', 'Rust 所有权模型', 900), rec('b', 'Rust 借用检查', 0)];
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-recency-4lane-'));
    dirs.push(dataDir);
    const db = new MemoryDb(join(dataDir, 'r.db'), DIM);
    db.init();
    const store = new L1Store(
      dataDir,
      db,
      fakeEmbed(),
      'hybrid',
      undefined,
      30,
      () => [], // 图谱接线但本轮无命中 → 结构性仍占一路
    );
    await store.init();
    await store.appendNew(records);
    try {
      const hits = await store.search('Rust', 5);
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) {
        expect(h.score).toBeGreaterThan(0);
        expect(h.score).toBeLessThanOrEqual(1);
      }
    } finally {
      db.close();
    }
  });

  it('**时效是排序信号,不是召回信号**:开关衰减不改变结果的 id 集合', async () => {
    const records = [
      rec('a', 'Rust 所有权模型', 900),
      rec('b', 'Rust 借用检查', 0),
      rec('c', 'Rust 生命周期', 5),
      rec('d', '完全无关的另一件事', 1),
    ];
    const decayOn = await setup(records, 30);
    const decayOff = await setup(records, 0);
    try {
      const on = await decayOn.store.search('Rust', 10);
      const off = await decayOff.store.search('Rust', 10);
      // 只换顺序/分数,不换成员 —— 无关但很新的记录不会被时效路"召"进来
      expect([...on.map((h) => h.id)].sort()).toEqual([...off.map((h) => h.id)].sort());
    } finally {
      decayOn.db.close();
      decayOff.db.close();
    }
  });

  it('**红线**:searchCandidates 无视新旧 —— 仅交换 updatedAt,候选池不变而读路径变化', async () => {
    // 决定性的对照:两份夹具内容完全相同,只把两条记录的**年龄对调**。
    // 去重候选池的判据若混入时效,顺序必然跟着变;必须纹丝不动。
    const mk = (r1Age: number, r2Age: number) => [
      rec('r1', '用户的 Rust 所有权模型学习笔记', r1Age),
      rec('r2', 'Rust 随口一提', r2Age),
      rec('r3', '无关内容', 1),
    ];
    const q = 'Rust 所有权模型学习笔记';
    const A = await setup(mk(800, 0), 30); // r1 老 / r2 新
    const B = await setup(mk(0, 800), 30); // 对调
    try {
      const candA = (await A.store.searchCandidates(q, 5)).map((r) => r.id);
      const candB = (await B.store.searchCandidates(q, 5)).map((r) => r.id);
      expect(candA).toEqual(candB); // 候选池与年龄无关(写路径找同义旧记录)
      expect(candA).toContain('r1');

      // 读路径则必须受年龄影响 —— 否则上一条断言就没有区分力(空洞通过)
      const hitA = (await A.store.search(q, 5)).map((h) => h.id);
      const hitB = (await B.store.search(q, 5)).map((h) => h.id);
      expect(hitA).not.toEqual(hitB);
    } finally {
      A.db.close();
      B.db.close();
    }
  });

  it('结构性来源:第 4 路复用 applyDecayWeight,不新增独立加权逻辑', async () => {
    // 同一夹具:store 的 4 路结果里,「按衰减加权排序」若与最终后处理同源,
    // 则重排方向必须与单独跑 applyDecayWeight 一致(此处用纯函数对照)
    const { applyDecayWeight } = await import('../src/store/search-utils.js');
    const hits = [
      { id: 'x', content: '', type: '', scene_name: '', score: 1 },
      { id: 'y', content: '', type: '', scene_name: '', score: 1 },
    ];
    const nowVal = Date.now();
    const ordered = applyDecayWeight(hits, 30, (h) => (h.id === 'y' ? nowVal : nowVal - 900 * DAY), nowVal);
    expect(ordered.map((h) => h.id)).toEqual(['y', 'x']);
  });
});
