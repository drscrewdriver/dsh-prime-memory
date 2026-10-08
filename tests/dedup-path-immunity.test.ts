/**
 * 去重路径免疫(dedup-path immunity)—— 记忆治理升级的**第一交付物**(Wave 0, T0.1)。
 *
 * 红线(P0-1):治理权重(衰减/分级地板/激活/scope 围栏/tier)只准作用于**读召回路径**,
 * 严禁进入 `searchCandidates`(去重候选)——候选池排序一旦被治理因子扰动,老的同义
 * 记录会被挤出候选池,LLM 判 store 而非 merge,同事实双记录正反馈恶化;且 receipts
 * 如实记录被污染的候选池、审计看似正确、症状完全隐形。
 *
 * 本文件三层防线:
 * ① **基线稳定性**——同库同查询,searchCandidates 的 id 序列确定(免疫断言的地基);
 * ② **反向验证机制**——向 searchL1Vector 注入"治理乘子"式重排,比较器必须能检出
 *    差异。检不出差异的免疫断言是假锚(ADR-0012 条4:负式断言不算护栏);
 * ③ **assertNotDedupPath 哨兵**——治理代码在去重路径内自证即抛(dev/test 生效,
 *    生产 no-op),把隐形污染变成显式崩溃。
 *
 * **旋钮矩阵随波扩充**(计划 v2 解 Issue 2):Wave 0 交付时治理旋钮尚不存在,
 * "全旋钮最激进档"是**终态断言而非 Wave 0 退出条件**。后续每交付一个治理旋钮,
 * 必须在 KNOBS 注册并进入「全开 vs 全关」对照:
 * - T1.10b → scope 围栏(recall.scopeFence.*)
 * - T2.5b  → 激活老化 + 分级地板(recall.activation.* / recall.decayFloorByType)
 * - T3.9b  → tier(governance.tier.*),终态=全旋钮最激进档 id 序列逐位等于全关
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { assertNotDedupPath, GOVERNANCE_SENTINEL_ACTIVE, markDedupPath } from '../src/store/search-utils.js';
import type { EmbeddingService } from '../src/store/embedding.js';
import type { MemoryRecord } from '../src/types.js';

const DIM = 16;
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

function rec(id: string, content: string): MemoryRecord {
  const t = Date.now();
  return { id, content, type: 'episodic', priority: 50, scene_name: 's', timestamps: [t], createdAt: t, updatedAt: t };
}

async function setup(records: MemoryRecord[]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-dedup-immunity-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'r.db'), DIM);
  db.init();
  const store = new L1Store(dataDir, db, fakeEmbed(), 'hybrid', undefined, 0);
  await store.init();
  if (records.length > 0) await store.appendNew(records);
  return { db, store };
}

/** 免疫比较器:治理旋钮开/关两侧的 searchCandidates 结果 **id 序列逐位相等**。 */
function idSequenceOf(hits: MemoryRecord[]): string[] {
  return hits.map((h) => h.id);
}

const FIXTURE = [
  rec('a', 'Rust 所有权模型详解'),
  rec('b', 'Rust 借用检查规则'),
  rec('c', 'Rust 生命周期标注实践'),
  rec('d', 'TypeScript 类型收窄技巧'),
  rec('e', '完全无关的另一件事'),
];

describe('去重路径免疫(Wave 0 骨架)', () => {
  it('① 基线稳定性:同库同查询重复调用,searchCandidates id 序列确定', async () => {
    const { db, store } = await setup(FIXTURE);
    try {
      const first = idSequenceOf(await store.searchCandidates('Rust 所有权', 3));
      const second = idSequenceOf(await store.searchCandidates('Rust 所有权', 3));
      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
      // 双库同夹具:两个独立构建的相同库,候选序列也应一致(未来"旋钮开/关"
      // 双库对照的地基——开侧与关侧必须是同分布夹具)
      const twin = await setup(FIXTURE);
      try {
        expect(idSequenceOf(await twin.store.searchCandidates('Rust 所有权', 3))).toEqual(first);
      } finally {
        twin.db.close();
      }
    } finally {
      db.close();
    }
  });

  it('② 反向验证机制可用:治理乘子把头部记录挤出 limit,免疫比较器必须检出差异', async () => {
    // 这是"免疫测试本身可信"的证明(ADR-0012 条4):若把治理乘子搬进
    // searchL1Vector(即 P0-1 的污染形态),比较器检不出差异,则本文件的一切
    // "逐位相等"断言都是假锚,必须停下修锚而不是继续堆机制。
    //
    // 污染通道的精确形态:**成员**而非顺序。searchCandidates 用 getL1ByIds 回填,
    // 而它按 SQL 行序返回——纯重排会被抹掉;乘子真正改变的是「排序 → limit 截断
    // → 候选池成员」。故注入形态取"乘子把 rank1 记录压出 limit"(丢头部),
    // 与真实 P0-1 污染同形。
    const { db, store } = await setup(FIXTURE);
    try {
      const baseline = idSequenceOf(await store.searchCandidates('Rust 所有权', 3));
      const original = db.searchL1Vector.bind(db);
      vi.spyOn(db, 'searchL1Vector').mockImplementation((vec, limit, family, ws) =>
        original(vec, limit, family, ws).slice(1),
      );
      try {
        const polluted = idSequenceOf(await store.searchCandidates('Rust 所有权', 3));
        expect(polluted).not.toEqual(baseline);
      } finally {
        vi.restoreAllMocks();
      }
    } finally {
      db.close();
    }
  });

  it('③ assertNotDedupPath 哨兵:去重路径内治理代码自证即抛,路径外不抛', async () => {
    // 路径外:任何地方调用都不抛
    expect(() => assertNotDedupPath('测试-路径外')).not.toThrow();
    // 路径内(同步):立即抛,信息带肇事者名字
    expect(() => markDedupPath(() => assertNotDedupPath('测试-同步路径内'))).toThrow(/测试-同步路径内/);
    // 路径内(异步下游):AsyncLocalStorage 跨 await 传播——真实污染发生在
    // searchCandidates 的 await 之后,这个形态必须同样能抓到
    await expect(
      markDedupPath(async () => {
        await new Promise((r) => setTimeout(r, 1));
        assertNotDedupPath('测试-异步路径内');
      }),
    ).rejects.toThrow(/测试-异步路径内/);
    // 哨兵开关本身是显式导出的布尔(生产构建=false,整个机制 no-op)
    expect(typeof GOVERNANCE_SENTINEL_ACTIVE).toBe('boolean');
  });

  it('④ 旋钮矩阵(随波扩充):全开 vs 全关 id 序列逐位相等', async () => {
    // Wave 0:治理旋钮尚未交付,矩阵为空——循环体空转是**结构占位**而非跳过:
    // 每波交付新旋钮时在此注册 { name, on, off } 双配置,T1.10b/T2.5b/T3.9b
    // 的扩充全部走这条通路;终态断言见 T3.9b(全旋钮最激进档)。
    const KNOBS: Array<{ name: string }> = [];
    expect(KNOBS.length).toBe(0); // Wave 0 出口:矩阵为空是预期状态(G0 澄清项)
    const { db, store } = await setup(FIXTURE);
    try {
      const allOff = idSequenceOf(await store.searchCandidates('Rust 所有权', 3));
      expect(allOff.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
