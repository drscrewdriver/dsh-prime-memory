/**
 * 同批次矛盾也可冻结(2026-09-18 R6 修复的回归测试)。
 *
 * 修的是什么:此前 `validateConflictPair` 的对手集只有「候选池 ∪ target_ids」,
 * 而**同批次新记忆的 id 不在其中**(本轮刚生成、尚未入库)。于是"本轮两条新记忆
 * 互相矛盾"这种最典型的"机器判不了"情形,模型即便正确 emit `conflict` 也必然
 * 被判不成对而回落 store —— 实测模型在生产 prompt 下会 emit(2/2),但那跳从未落库。
 *
 * 本文件钉死三件事:
 * ① 同批次对手现在能构成冻结对并真的落进 `conflict_pending`;
 * ② 队满时的**护栏**:败方是本轮新记忆则不做自动了结(否则刚抽取的产出立即退场);
 * ③ 校验函数本身的边界(batchIds 缺省时维持旧行为)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const extractQueue: string[] = [];
/** 去重决策形态:同批次互斥,或全 store。 */
let conflictMode: 'sameBatch' | 'none' = 'none';

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    callLLM: vi.fn(async (_ctx: unknown, _cfg: unknown, opts: { layer?: string; user?: string }) => {
      if (opts?.layer !== 'l1-dedup') return extractQueue.shift() ?? '[]';
      // record_id 由 pipeline 运行时生成,必须从提示词里读回真实值
      const ids = [...String(opts.user ?? '').matchAll(/record_id: (\S+?)\)/g)].map((m) => m[1]);
      if (conflictMode === 'sameBatch' && ids.length >= 2) {
        return JSON.stringify([
          { record_id: ids[0], action: 'conflict', winner: ids[0], loser: ids[1] },
          { record_id: ids[1], action: 'store' },
        ]);
      }
      return JSON.stringify(ids.map((id) => ({ record_id: id, action: 'store' })));
    }),
  };
});

const { runExtraction } = await import('../src/pipeline/l1.js');
const { validateConflictPair } = await import('../src/store/conflicts.js');
const { L1Store } = await import('../src/store/l1.js');
const { MemoryDb } = await import('../src/store/sqlite.js');
type MemoryConfig = import('../src/contract.js').MemoryConfig;
type FamilyStates = import('../src/pipeline/l1.js').FamilyStates;
type ConversationMessage = import('../src/types.js').ConversationMessage;

let root: string;
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} } as never;

function cfg(maxPending: number): MemoryConfig {
  return {
    dataDir: '', family: 'auto',
    capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 },
    extract: { enabled: true, minMessages: 1, idleSeconds: 300, backgroundMessages: 10, candidatePool: 5 },
    l2: { enabled: true, minNewMemories: 5, maxScenes: 12, sceneContextLimit: 3 },
    l3: { enabled: true, interval: 20 },
    recall: { enabled: true, maxResults: 5, maxCharsPerMemory: 500, maxTotalRecallChars: 2000, timeoutMs: 5000, includePersona: true, includeSceneNav: true, strategy: 'keyword', scoreThreshold: 0, decayHalfLifeDays: 0 },
    embedding: { enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 0, maxInputChars: 5000, timeoutMs: 10000, allowLocalModels: true, mirror: '', proxy: '' },
    llm: { provider: '', model: '', mode: 'host', baseURL: '', apiKey: '', maxTokens: 65536, reasoningEffort: 'medium', maxInputChars: 700000, timeoutMs: 120000 },
    hall: { enabled: ['work'] },
    tokenCost: { retentionDays: 365 },
    tools: true,
    benchControl: false,
    conflictFreeze: { enabled: true, maxPending, timeoutDays: 0 },
  } as MemoryConfig;
}

function states(): FamilyStates {
  const s = () => ({ lastScene: '', chain: [], lastAt: 0, lastRunAt: 0, warmupThreshold: 0, distilledCount: 0 });
  return { chat: s(), work: s() } as unknown as FamilyStates;
}

const messages = (): ConversationMessage[] => [
  { id: 'm1', role: 'user', content: '项目 Zeta 负责人是甲', timestamp: 1_700_000_000_000 },
  { id: 'm2', role: 'assistant', content: '收到', timestamp: 1_700_000_001_000 },
];

/** 一次抽出**两条互相矛盾**的新记忆(同批次)。 */
function seedTwoContradicting(): void {
  extractQueue.push(
    JSON.stringify([
      {
        scene_name: '同批次矛盾',
        message_ids: ['m1'],
        memories: [
          { record_id: '占位A', content: '项目 Zeta 负责人是甲', type: 'work_fact', priority: 70, source_message_ids: ['m1'], metadata: { hall: 'work' } },
          { record_id: '占位B', content: '项目 Zeta 负责人是乙', type: 'work_fact', priority: 70, source_message_ids: ['m2'], metadata: { hall: 'work' } },
        ],
      },
    ]),
  );
}

async function setup() {
  const dir = await mkdtemp(join(root, 'same-batch-'));
  const db = new MemoryDb(join(dir, 'm.db'), 0);
  db.init();
  const store = new L1Store(dir, db, undefined, 'keyword', noopLogger, 0);
  await store.init();
  return { db, store };
}

const pendingRows = (db: MemoryDb): Array<{ winner_id: string; loser_id: string; resolution: string; resolved_at: string }> =>
  (db as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }).db
    .prepare('SELECT winner_id, loser_id, resolution, resolved_at FROM conflict_pending')
    .all() as never;

describe('同批次矛盾冻结(回归 R6 结构性拒收)', () => {
  it('两条同批次新记忆互斥 → 真的落进 conflict_pending', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-samebatch-'));
    conflictMode = 'sameBatch';
    seedTwoContradicting();
    const { db, store } = await setup();
    try {
      const out = await runExtraction({} as never, cfg(100), store, states(), messages(), [], noopLogger, 'work');
      expect(out.stored).toBe(2); // 两条都照常入库(冻结不改写任何一方)
      const rows = pendingRows(db);
      expect(rows, '同批次矛盾必须能停放').toHaveLength(1);
      const ids = out.newRecords.map((r) => r.id);
      expect(ids).toContain(rows[0].winner_id);
      expect(ids).toContain(rows[0].loser_id);
      expect(rows[0].winner_id).not.toBe(rows[0].loser_id);
      expect(rows[0].resolved_at).toBe(''); // 未裁决,等人
      // 双方内容都不被改写、且都还在检索面(冻结不是退场)
      for (const id of ids) {
        expect(store.getByIds([id])[0]?.validTo).toBeUndefined();
      }
    } finally {
      db.close();
    }
  });

  it('护栏:队满时**不**对含新记忆的对做自动了结(新记忆不会被立即退场)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-samebatch-cap-'));
    conflictMode = 'sameBatch';
    seedTwoContradicting();
    const { db, store } = await setup();
    try {
      // maxPending=0 → 上限判据必然命中
      const out = await runExtraction({} as never, cfg(0), store, states(), messages(), [], noopLogger, 'work');
      expect(out.stored).toBe(2);
      // 没停放(队列有界性成立)
      expect(pendingRows(db)).toHaveLength(0);
      // 关键:没有任何一条被"自动了结"退场
      for (const r of out.newRecords) {
        const row = store.getByIds([r.id])[0];
        expect(row, '新记忆必须在库').toBeDefined();
        expect(row.validTo, '新记忆不得因队满被自动退场').toBeUndefined();
      }
      expect(store.listRetired({ limit: 10, offset: 0 }).total).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('validateConflictPair 的对手集边界', () => {
  const known = new Set(['mem_old_1']);
  const batch = new Set(['mem_new_A', 'mem_new_B']);

  it('同批次对手:传了 batchIds 才认', () => {
    // 本条是 mem_new_A,对手是同批次的 mem_new_B
    expect(validateConflictPair('mem_new_A', 'mem_new_A', 'mem_new_B', known, batch)).toEqual({
      winnerId: 'mem_new_A',
      loserId: 'mem_new_B',
    });
    // 不传 batchIds → 维持旧行为(拒绝)
    expect(validateConflictPair('mem_new_A', 'mem_new_A', 'mem_new_B', known)).toBeNull();
  });

  it('候选池对手仍照常认(未回归)', () => {
    expect(validateConflictPair('mem_new_A', 'mem_new_A', 'mem_old_1', known, batch)).toEqual({
      winnerId: 'mem_new_A',
      loserId: 'mem_old_1',
    });
    expect(validateConflictPair('mem_new_A', 'mem_old_1', 'mem_new_A', known, batch)).toEqual({
      winnerId: 'mem_old_1',
      loserId: 'mem_new_A',
    });
  });

  it('两队都不是本条新记忆 / 同 id / 幻觉 id → 一律拒绝', () => {
    // 两个都是同批次兄弟,但都不是"本条" → 拒绝(否则同一对会被每个兄弟重复申报)
    expect(validateConflictPair('mem_new_A', 'mem_new_B', 'mem_old_1', known, batch)).toBeNull();
    expect(validateConflictPair('mem_new_A', 'mem_new_A', 'mem_new_A', known, batch)).toBeNull();
    expect(validateConflictPair('mem_new_A', 'mem_new_A', 'mem_ghost', known, batch)).toBeNull();
    expect(validateConflictPair('mem_new_A', 'mem_new_A', '', known, batch)).toBeNull();
    expect(validateConflictPair('mem_new_A', 42, 'mem_old_1', known, batch)).toBeNull();
  });
});

beforeEach(() => {
  extractQueue.length = 0;
  conflictMode = 'none';
});
