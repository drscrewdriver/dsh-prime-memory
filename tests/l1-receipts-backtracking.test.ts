/**
 * §B task_19 —— 双维回溯的**端到端**用例(真管线 → 真凭证 → 真端点)。
 *
 * 为什么在单测之外还要这一条:`tests/l1-receipts-query.test.ts` 用的是**手搓凭证**,
 * 它只能证明读路径自身自洽,证明不了「真管线写出来的凭证,真端点读得回来」——
 * 而这两段之间隔着 `record_id` 的生成方式、候选池的召回结果、run_id 的构造,
 * 任何一处语义漂移都会让单测全绿而回溯实际不可用。本计划已被这类
 * "断言为真但不是因为端到端可用"咬过四次(task_9/10/14 + 本次的取值面收窄)。
 *
 * 留档:设 `TASK19_EVIDENCE_OUT=<path>` 时,本用例会把真实回溯的**原始 JSON**
 * 写到该路径(供 evidence 归档)。不设则只断言,不落任何文件。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/** 两轮蒸馏各自的抽取输出(按调用次序出队)。 */
const extractQueue: string[] = [];
/** 两轮蒸馏各自的去重动作(每轮一个数组,与提示词里的记录**同序**)。 */
const decisionQueue: string[][] = [];

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    callLLM: vi.fn(async (_ctx: unknown, _cfg: unknown, opts: { layer?: string; user?: string }) => {
      if (opts?.layer !== 'l1-dedup') return extractQueue.shift() ?? '[]';
      // record_id 由 pipeline 在抽取后 `newId('mem')` 生成,模型给的那个被丢弃 →
      // 必须从去重提示词里读回**真实 id**(prompts/l1-dedup.ts 的 `record_id: mem_…)`)
      const ids = [...String(opts.user ?? '').matchAll(/record_id: (\S+?)\)/g)].map((m) => m[1]);
      const actions = decisionQueue.shift();
      if (!actions) return '[]';
      // 逐条给动作:一轮里 store 与 skip 可以并存(正是"回溯要能分辨"的场景)
      return JSON.stringify(ids.map((id, i) => ({ record_id: id, action: actions[i] ?? 'skip' })));
    }),
  };
});

const { runExtraction } = await import('../src/pipeline/l1.js');
const { L1Store } = await import('../src/store/l1.js');
const { MemoryDb } = await import('../src/store/sqlite.js');
const { handleEndpoint, buildEndpointDeps } = await import('../src/stats.js');
type MemoryConfig = import('../src/contract.js').MemoryConfig;
type FamilyStates = import('../src/pipeline/l1.js').FamilyStates;
type ConversationMessage = import('../src/types.js').ConversationMessage;

let root: string;
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} } as never;

function cfg(dataDir: string): MemoryConfig {
  return {
    dataDir, family: 'auto',
    capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 },
    extract: { enabled: true, minMessages: 1, idleSeconds: 300, backgroundMessages: 10, candidatePool: 5 },
    l2: { enabled: true, minNewMemories: 5, maxScenes: 12, sceneContextLimit: 3 },
    l3: { enabled: true, interval: 20 },
    recall: { enabled: true, maxResults: 5, maxCharsPerMemory: 500, maxTotalRecallChars: 2000, timeoutMs: 5000, includePersona: true, includeSceneNav: true, strategy: 'keyword', scoreThreshold: 0.3, decayHalfLifeDays: 30 },
    embedding: { enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 0, maxInputChars: 5000, timeoutMs: 10000, allowLocalModels: true, mirror: 'https://hf-mirror.com', proxy: '' },
    llm: { provider: '', model: '', mode: 'host', baseURL: '', apiKey: '', maxTokens: 65536, reasoningEffort: 'medium', maxInputChars: 700000, timeoutMs: 120000 },
    hall: { enabled: ['work'] },
    tokenCost: { retentionDays: 365 },
    tools: true,
    benchControl: false,
  } as MemoryConfig;
}

function states(): FamilyStates {
  const s = () => ({ lastScene: '', chain: [], lastAt: 0, lastRunAt: 0, warmupThreshold: 0, distilledCount: 0 });
  return { chat: s(), work: s() } as unknown as FamilyStates;
}

function extraction(contents: string[]): string {
  return JSON.stringify([
    {
      scene_name: '端到端回溯场景',
      message_ids: ['m1'],
      memories: contents.map((c) => ({ record_id: '占位(将被丢弃)', content: c, type: 'work_fact', priority: 60, family: 'work', source_message_ids: ['m1'], metadata: {} })),
    },
  ]);
}

const MSGS: ConversationMessage[] = [
  { id: 'm1', role: 'user', content: '本轮要抽取的工作事实', timestamp: 1_700_000_000_000 },
  { id: 'm2', role: 'assistant', content: '收到', timestamp: 1_700_000_001_000 },
];

describe('task_19 端到端回溯:真管线写 → 真端点读', () => {
  it('两轮蒸馏的凭证都能按 run_id 与 record_id 读回,且与库中记录对得上', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-receipts-e2e-'));
    const dataDir = join(root, 'data');
    const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
    db.init();
    const store = new L1Store(dataDir, db, undefined, 'keyword', noopLogger, 0);
    await store.init();

    try {
      // ── 第 1 轮:2 条抽取,决策 = store / skip ──
      extractQueue.push(extraction(['端到端回溯:第一条入库的事实', '端到端回溯:第一条被跳过的事实']));
      decisionQueue.push(['store', 'skip']);
      const ctx = {} as never;
      const c = cfg(dataDir);
      const out1 = await runExtraction(ctx, c, store, states(), MSGS, [], noopLogger, 'work');
      expect(out1.stored).toBe(1); // 2 条抽取,1 条 store 1 条 skip

      // ── 第 2 轮:1 条抽取,候选池应能召回第 1 轮的记录 ──
      extractQueue.push(extraction(['端到端回溯:第二条入库的事实']));
      decisionQueue.push(['store']);
      const out2 = await runExtraction(ctx, c, store, states(), MSGS, [], noopLogger, 'work');
      expect(out2.stored).toBe(1);

      // 端点直调(与面板/curl 同径)
      const deps = buildEndpointDeps(
        { ctx, cfg: c, stores: { l1: store } as never, logger: noopLogger },
        {},
        undefined,
      );
      const byRun1 = (await handleEndpoint('dsh-memory/receipts', { runId: runIdOfFirstRun(db) }, deps)) as {
        dimension: string;
        items: Array<{ kind: string; record_id: string }>;
        total: number;
      };
      expect(byRun1.dimension).toBe('run');
      expect(byRun1.total).toBe(2);
      expect(byRun1.items.map((i) => i.kind).sort()).toEqual(['skip', 'store']);

      // 按 record_id:该记录**确实**入库了 —— 凭证不是自说自话
      const storedId = out1.newRecords[0]?.id ?? '';
      expect(storedId).toMatch(/^mem_/);
      expect(store.getByIds([storedId])).toHaveLength(1);

      const byRecord = (await handleEndpoint('dsh-memory/receipts', { recordId: storedId }, deps)) as {
        dimension: string;
        items: Array<Record<string, unknown>>;
        total: number;
      };
      expect(byRecord.dimension).toBe('record');
      expect(byRecord.total).toBe(1);

      // ── 可选留档:原始 JSON ──
      const out = process.env.TASK19_EVIDENCE_OUT;
      if (out) {
        const secondRun = await handleEndpoint('dsh-memory/receipts', { runId: runIdOfSecondRun(db) }, deps);
        await writeFile(
          out,
          JSON.stringify(
            {
              生成方式: '真 runExtraction × 2(仅 LLM 传输层打桩)→ 真 handleEndpoint(dsh-memory/receipts)',
              生成时间: new Date().toISOString(),
              '按 run_id(第 1 轮)': byRun1,
              '按 run_id(第 2 轮)': secondRun,
              '按 record_id(第 1 轮入库的那条)': byRecord,
              该记录入库核实: store.getByIds([storedId]).length,
              全部凭证: allReceipts(db),
            },
            null,
            2,
          ),
        );
      }
    } finally {
      db.close();
    }
  });
});

/** 取第 1 轮的 run_id(按 decided_at 最早;两轮同毫秒时按 run_id 升序兜底)。 */
function runIdOfFirstRun(db: MemoryDb): string {
  return runIds(db).at(0) ?? '';
}
function runIdOfSecondRun(db: MemoryDb): string {
  return runIds(db).at(-1) ?? '';
}
function runIds(db: MemoryDb): string[] {
  return (db as unknown as { db: { prepare: (s: string) => { all: () => Array<{ run_id: string }> } } }).db
    .prepare('SELECT DISTINCT run_id FROM l1_receipts ORDER BY run_id')
    .all()
    .map((r) => r.run_id);
}
function allReceipts(db: MemoryDb): unknown[] {
  return (db as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }).db
    .prepare('SELECT receipt_id, run_id, record_id, kind, input_digest, decided_at FROM l1_receipts ORDER BY run_id, record_id')
    .all();
}
