/**
 * §B task_17 —— 凭证写入点接入。
 *
 * 两条必须钉死的性质:
 * ① **幂等**:同一次 run 重放不产生重复凭证(`receipt_id` 是 run×record 的确定性函数);
 * ② **失败隔离**:凭证写失败**绝不中断 L1 蒸馏**——凭证是旁路观测设施,
 *    绝不能变成「产生记忆」这条主链路的单点。
 *
 * 第 ② 条刻意做成**真集成用例**(跑真实 `runExtraction`,只把 `recordReceipts`
 * 换成抛错的实现),而不是只测 `persistReceiptsSafely` 这个工具函数——
 * 后者只能证明"隔离机制本身работает",证明不了"runExtraction 真的用了它"。
 * 本计划已被这类"断言为真但不是因为被测改动为真"咬过三次(task_9/10/14)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** LLM 打桩:按 layer 区分「抽取」与「去重」两次调用。 */
const llmResponses = { extract: '[]' };
let decisionAction: string | null = 'store';
vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    callLLM: vi.fn(async (_ctx: unknown, _cfg: unknown, opts: { layer?: string; user?: string }) => {
      if (opts?.layer !== 'l1-dedup') return llmResponses.extract;
      // 关键:record_id 由 pipeline 在抽取后 `newId('mem')` 生成,**模型给的那个被丢弃**,
      // 故打桩必须从去重提示词里把**真实 id** 读回来,而不是自己编一个。
      // (prompts/l1-dedup.ts:257 `### 第 N 条新记忆 (record_id: mem_…)`)
      const ids = [...String(opts.user ?? '').matchAll(/record_id: (\S+?)\)/g)].map((m) => m[1]);
      if (decisionAction === null) return '[]';
      return JSON.stringify(ids.map((id) => ({ record_id: id, action: decisionAction })));
    }),
  };
});

const { runExtraction } = await import('../src/pipeline/l1.js');
const { L1Store } = await import('../src/store/l1.js');
const { MemoryDb } = await import('../src/store/sqlite.js');
const { buildReceipts, inputDigest, normalizeKind, persistReceiptsSafely, receiptIdFor } =
  await import('../src/store/receipts.js');
type MemoryConfig = import('../src/contract.js').MemoryConfig;
type FamilyStates = import('../src/pipeline/l1.js').FamilyStates;
type ConversationMessage = import('../src/types.js').ConversationMessage;

let root: string;
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function cfg(): MemoryConfig {
  return {
    dataDir: '', family: 'auto',
    capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 },
    extract: { enabled: true, minMessages: 1, idleSeconds: 300, backgroundMessages: 10, candidatePool: 5 },
    l2: { enabled: true, minNewMemories: 5, maxScenes: 12, sceneContextLimit: 3 },
    l3: { enabled: true, interval: 20 },
    recall: { enabled: true, maxResults: 5, maxCharsPerMemory: 500, maxTotalRecallChars: 2000, timeoutMs: 5000, includePersona: true, includeSceneNav: true, strategy: 'hybrid', scoreThreshold: 0.3, decayHalfLifeDays: 30 },
    embedding: { enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 0, maxInputChars: 5000, timeoutMs: 10000, allowLocalModels: true, mirror: 'https://hf-mirror.com', proxy: '' },
    llm: { provider: '', model: '', mode: 'host', baseURL: '', apiKey: '', maxTokens: 65536, reasoningEffort: 'medium', maxInputChars: 700000, timeoutMs: 120000 },
    hall: { enabled: ['work'] },
    tokenCost: { retentionDays: 365 },
    tools: true,
    benchControl: false,
    conflictFreeze: { enabled: false },
  } as MemoryConfig;
}

function states(): FamilyStates {
  const s = () => ({ lastScene: '', chain: [], lastAt: 0, lastRunAt: 0, warmupThreshold: 0, distilledCount: 0 });
  return { chat: s(), work: s() } as unknown as FamilyStates;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} } as never;

/** 一条抽取结果;去重决策由 `decisionAction` 控制(打桩会回填真实 record_id)。 */
function stubLlm(action: string | null): void {
  decisionAction = action;
  llmResponses.extract = JSON.stringify([
    {
      scene_name: '测试场景',
      message_ids: ['m1'],
      memories: [
        {
          record_id: '被丢弃的占位 id',
          content: '用户在测试凭证链',
          type: 'episodic',
          priority: 60,
          scene_name: '测试场景',
          family: 'chat',
          source_message_ids: ['m1'],
          metadata: {},
        },
      ],
    },
  ]);
}

const messages = (): ConversationMessage[] => [
  { id: 'm1', role: 'user', content: '我在测试凭证链', timestamp: 1_700_000_000_000 },
  { id: 'm2', role: 'assistant', content: '好的', timestamp: 1_700_000_001_000 },
];

async function setup() {
  const dir = await mkdtemp(join(root, 'run-'));
  const db = new MemoryDb(join(dir, 'm.db'), 0);
  db.init();
  const store = new L1Store(dir, db, undefined, 'keyword', noopLogger as never, 0);
  await store.init();
  return { db, store };
}

/** 只读凭证行(测试用;task_19 才会提供正式回溯工具)。 */
function receiptsOf(db: MemoryDb): Array<Record<string, unknown>> {
  return (db as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }).db
    .prepare('SELECT receipt_id, run_id, record_id, kind, input_digest, decided_at FROM l1_receipts ORDER BY record_id')
    .all() as Array<Record<string, unknown>>;
}

describe('task_17 §B 凭证写入点', () => {
  it('store 决策留下凭证,kind / input_digest / run_id 均就位', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-receipt-write-'));
    stubLlm('store');
    const { db, store } = await setup();
    try {
      const out = await runExtraction({} as never, cfg(), store, states(), messages(), [], noopLogger, 'auto');
      expect(out.stored).toBe(1);
      const rows = receiptsOf(db);
      expect(rows).toHaveLength(1);
      // record_id 是 pipeline 运行时生成的(`newId('mem')`),不是模型给的那个
      expect(String(rows[0].record_id)).toMatch(/^mem_/);
      expect(rows[0].kind).toBe('store');
      expect(String(rows[0].run_id)).toMatch(/^run_/);
      expect(rows[0].input_digest).toBe(inputDigest([])); // 空库 → 空候选池
      expect(String(rows[0].decided_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // 凭证指向的记录确实入库了(凭证不是自说自话)
      expect(store.getByIds([String(rows[0].record_id)])).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('**skip 也留痕**(应用循环会 continue 跳过它,这正是 §B 要补的缺口)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-receipt-skip-'));
    stubLlm('skip');
    const { db, store } = await setup();
    try {
      const out = await runExtraction({} as never, cfg(), store, states(), messages(), [], noopLogger, 'auto');
      expect(out.stored).toBe(0);
      const rows = receiptsOf(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('skip');
      // 前置:该记录确实没进库 —— 否则"留痕"这条断言没有对照
      expect(store.getByIds([String(rows[0].record_id)])).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('**模型没返回决策**记 `skip_missing`,与模型主动 skip 区分开', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-receipt-missing-'));
    stubLlm(null);
    const { db, store } = await setup();
    try {
      await runExtraction({} as never, cfg(), store, states(), messages(), [], noopLogger, 'auto');
      const rows = receiptsOf(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('skip_missing');
    } finally {
      db.close();
    }
  });

  it('**幂等**:同一次 run 内同一条记录重复落盘,只留一条', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-receipt-idem-'));
    stubLlm('store');
    const { db, store } = await setup();
    try {
      // 用真实路径跑一次,拿到它写下的那批 rows
      await runExtraction({} as never, cfg(), store, states(), messages(), [], noopLogger, 'auto');
      const written = receiptsOf(db);
      expect(written).toHaveLength(1);
      const runId = String(written[0].run_id);
      const recordId = String(written[0].record_id);
      // 同一 (run, record) 再落一次 → INSERT OR IGNORE 吃掉,新增 0 条
      const again = buildReceipts(runId, new Date().toISOString(), [
        { recordId, candidateIds: [], action: 'store' },
      ]);
      expect(store.recordReceipts(again)).toBe(0);
      expect(receiptsOf(db)).toHaveLength(1);
      // 而换一条记录则是新的（幂等不等于"什么都不写"）
      const other = buildReceipts(runId, new Date().toISOString(), [
        { recordId: 'mem_other', candidateIds: [], action: 'store' },
      ]);
      expect(store.recordReceipts(other)).toBe(1);
      expect(receiptsOf(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('**失败隔离(真集成)**:recordReceipts 抛错时,蒸馏主链路仍完成', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-receipt-fail-'));
    stubLlm('store');
    const { db, store } = await setup();
    const warn = vi.fn();
    vi.spyOn(store, 'recordReceipts').mockImplementation(() => {
      throw new Error('receipt boom');
    });
    try {
      const out = await runExtraction(
        {} as never, cfg(), store, states(), messages(), [], { info: () => {}, warn, error: () => {} } as never, 'auto',
      );
      // 主链路结果不受影响
      expect(out.stored).toBe(1);
      expect(out.skipped).toBe(false);
      expect(store.size).toBe(1); // 记录确实落库了
      // 且失败被观测到(不是静默吞掉)
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain('凭证');
      expect(receiptsOf(db)).toHaveLength(0); // 凭证确实没写成
    } finally {
      vi.restoreAllMocks();
      db.close();
    }
  });
});

describe('task_17 配套纯函数', () => {
  it('normalizeKind:只认四个合法动作,非法/缺失一律 skip_missing', () => {
    expect(normalizeKind('store')).toBe('store');
    expect(normalizeKind('update')).toBe('update');
    expect(normalizeKind('merge')).toBe('merge');
    expect(normalizeKind('skip')).toBe('skip');
    expect(normalizeKind(undefined)).toBe('skip_missing');
    expect(normalizeKind('delete')).toBe('skip_missing'); // 模型幻觉出的动作不采信
    expect(normalizeKind('')).toBe('skip_missing');
  });

  it('receiptIdFor 是 run×record 的确定性函数(幂等的落点)', () => {
    expect(receiptIdFor('run', 'r1')).toBe(receiptIdFor('run', 'r1'));
    expect(receiptIdFor('run', 'r1')).not.toBe(receiptIdFor('run', 'r2'));
    expect(receiptIdFor('runA', 'r1')).not.toBe(receiptIdFor('runB', 'r1'));
  });

  it('buildReceipts:候选池进摘要,顺序不同则摘要不同', () => {
    const a = buildReceipts('run', 't', [{ recordId: 'r1', candidateIds: ['c1', 'c2'], action: 'merge' }]);
    const b = buildReceipts('run', 't', [{ recordId: 'r1', candidateIds: ['c2', 'c1'], action: 'merge' }]);
    expect(a[0].inputDigest).toBe(inputDigest(['c1', 'c2']));
    expect(a[0].inputDigest).not.toBe(b[0].inputDigest);
  });

  it('persistReceiptsSafely:空集合不调用写入;抛错被吞成 warn', () => {
    const write = vi.fn(() => 0);
    persistReceiptsSafely(write, []);
    expect(write).not.toHaveBeenCalled();

    const warn = vi.fn();
    expect(() =>
      persistReceiptsSafely(() => {
        throw new Error('x');
      }, [{ receiptId: 'r', runId: 'u', recordId: 'd', kind: 'store', inputDigest: 'h', decidedAt: 't' }], { warn }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

beforeEach(() => {
  llmResponses.extract = '[]';
  decisionAction = 'store';
});
