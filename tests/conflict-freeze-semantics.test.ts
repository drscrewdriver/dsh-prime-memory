/**
 * §C 矛盾冻结 / task_22:冻结落盘语义(端到端真管线)。
 *
 * 承重主张:**冻结不是"拦住写入"**——新记忆照常入 L1,与冲突的旧记忆构成冻结对,
 * **双方都不被覆盖、不被合并、不被删除**,只是把这一对停放到待人工裁决区。
 * 这是 §C 与"自动裁决"的分界线:我们有检测冲突的名字(CONFLICT_DETECTION_),
 * 却一直没有"停下来等人裁决"这个选项(findings.md §3)。
 *
 * 三条判据分别咬住三种"看起来对"的失败:
 * ① 新记忆照常入 L1 —— 防止实现成"拦住写入"(那样会丢信息);
 * ② 旧记忆**内容与版本逐字未变** —— 防止偷偷走 update 分支(那正是要消灭的行为);
 * ③ 冲突对确实停放且 `resolved_at` 为空 —— 防止"只是没删,但也没登记"。
 *
 * 另附图谱域 `disputed` 标记的存储级用例:节点由 L1 投影而来,
 * 冻结必须把**来源含冲突记录的节点**标成 disputed,否则图谱侧看不出争议。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/** 每轮抽取输出(按调用次序出队)。 */
const extractQueue: string[] = [];
/** 每轮去重决策模板:`conflict` / `store`;`conflict` 由 mock 填真 id。 */
const actionQueue: string[] = [];

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    callLLM: vi.fn(async (_ctx: unknown, _cfg: unknown, opts: { layer?: string; user?: string }) => {
      if (opts?.layer !== 'l1-dedup') return extractQueue.shift() ?? '[]';
      const user = String(opts.user ?? '');
      // 新记忆 id 由 pipeline 在抽取后 `newId('mem')` 生成,模型给的那个被丢弃
      const ids = [...user.matchAll(/record_id: (\S+?)\)/g)].map((m) => m[1]);
      // 关联候选 id 来自提示词里的【关联候选 ID】行
      const candIds = [...user.matchAll(/【关联候选 ID】\["(\S+?)"\]/g)].map((m) => m[1]);
      const action = actionQueue.shift() ?? 'store';
      return JSON.stringify(
        ids.map((id, i) => {
          if (action === 'conflict') {
            const other = candIds[i];
            // winner/loser 二者之一必须是本条新记忆;另一方是候选池里的旧记忆
            return { record_id: id, action: 'conflict', winner: id, loser: other };
          }
          if (action === 'conflict_same') {
            // 非法输出:winner === loser 必须被拒,回落 store
            return { record_id: id, action: 'conflict', winner: id, loser: id };
          }
          if (action === 'conflict_unknown') {
            // 非法输出:对侧不在候选池里,无法构成冻结对
            return { record_id: id, action: 'conflict', winner: id, loser: 'mem_不存在' };
          }
          return { record_id: id, action };
        }),
      );
    }),
  };
});

const { runExtraction } = await import('../src/pipeline/l1.js');
const { L1Store } = await import('../src/store/l1.js');
const { MemoryDb } = await import('../src/store/sqlite.js');
type MemoryConfig = import('../src/contract.js').MemoryConfig;

let root: string;
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} } as never;

function mkCfg(dataDir: string, freeze: boolean): MemoryConfig {
  return {
    dataDir, family: 'auto',
    capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 },
    extract: { enabled: true, minMessages: 1, idleSeconds: 300, backgroundMessages: 10, candidatePool: 5 },
    l2: { enabled: true, minNewMemories: 5, maxScenes: 12, sceneContextLimit: 3 },
    l3: { enabled: true, interval: 20 },
    graph: { enabled: false },
    conflictFreeze: { enabled: freeze },
    recall: { enabled: true, maxResults: 5, maxCharsPerMemory: 500, maxTotalRecallChars: 2000, timeoutMs: 5000, includePersona: true, includeSceneNav: true, strategy: 'keyword', scoreThreshold: 0.3, decayHalfLifeDays: 30 },
    embedding: { enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 0, maxInputChars: 5000, timeoutMs: 10000, allowLocalModels: true, mirror: 'https://hf-mirror.com', proxy: '' },
    llm: { provider: '', model: '', mode: 'host', baseURL: '', apiKey: '', maxTokens: 65536, reasoningEffort: 'medium', maxInputChars: 700000, timeoutMs: 120000 },
    hall: { enabled: ['work'] },
    tokenCost: { retentionDays: 365 },
    tools: true,
    benchControl: false,
  } as MemoryConfig;
}

function mkStates(): never {
  const s = () => ({ lastScene: '', chain: [], lastAt: 0, lastRunAt: 0, warmupThreshold: 0, distilledCount: 0 });
  return { chat: s(), work: s() } as never;
}

function extraction(content: string): string {
  return JSON.stringify([
    {
      scene_name: '矛盾冻结验证场景',
      message_ids: ['m1'],
      memories: [
        {
          record_id: '占位(将被丢弃)',
          content,
          type: 'work_fact',
          priority: 60,
          family: 'work',
          source_message_ids: ['m1'],
          metadata: {},
        },
      ],
    },
  ]);
}

const MSGS = [
  { id: 'm1', role: 'user', content: '矛盾冻结验证', timestamp: 1_700_000_000_000 },
  { id: 'm2', role: 'assistant', content: '收到', timestamp: 1_700_000_001_000 },
] as never;

/** 直读 conflict_pending(不经过被测实现,避免"用实现验证实现")。 */
function pendingRows(db: MemoryDb): Array<Record<string, unknown>> {
  return (
    db as unknown as {
      db: { prepare: (s: string) => { all: () => Array<Record<string, unknown>> } };
    }
  ).db
    .prepare(
      'SELECT pair_id, run_id, winner_id, loser_id, created_at, resolved_at, resolution FROM conflict_pending ORDER BY created_at',
    )
    .all();
}

const OLD_TEXT = '矛盾冻结验证:项目 Alpha 的负责人在 2026 年是张三';
const NEW_TEXT = '矛盾冻结验证:项目 Alpha 的负责人在 2026 年是李四';

interface Setup {
  store: InstanceType<typeof L1Store>;
  db: MemoryDb;
  cfg: MemoryConfig;
  oldId: string;
  close: () => void;
}

async function setup(tag: string, freeze: boolean): Promise<Setup> {
  root = root ?? (await mkdtemp(join(tmpdir(), 'dsh-conflict-e2e-')));
  const dataDir = join(root, `${tag}-${Date.now()}`);
  const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
  db.init();
  const store = new L1Store(dataDir, db, undefined, 'keyword', noopLogger, 0);
  await store.init();
  const cfg = mkCfg(dataDir, freeze);

  // 先跑一轮 store 建立旧记忆
  extractQueue.push(extraction(OLD_TEXT));
  actionQueue.push('store');
  const first = await runExtraction({} as never, cfg, store, mkStates(), MSGS, [], noopLogger, 'work');
  const oldId = first.newRecords[0]?.id ?? '';
  expect(oldId).toMatch(/^mem_/);

  return { store, db, cfg, oldId, close: () => db.close() };
}

describe('task_22 冻结落盘:新记忆照常入 L1,双方均不被改写', () => {
  it('冲突决策下:新记忆入库、旧记忆内容与版本逐字未变、冲突对停放且未裁决', async () => {
    const s = await setup('freeze', true);
    try {
      const before = s.store.getByIds([s.oldId])[0];
      expect(before?.content).toBe(OLD_TEXT);

      extractQueue.push(extraction(NEW_TEXT));
      actionQueue.push('conflict');
      const out = await runExtraction({} as never, s.cfg, s.store, mkStates(), MSGS, [], noopLogger, 'work');
      // ① 新记忆照常入 L1 —— 冻结不是"拦住写入"
      expect(out.stored).toBe(1);
      const newId = out.newRecords[0]?.id ?? '';
      expect(newId).toMatch(/^mem_/);
      // **区分性断言**:必须是 store 语义(全新记录,version=0)。若实现把 conflict
      // 漏进 update/merge 分支,新记录会被算成"替换了 0 条"的合并产物,version=1。
      expect(out.newRecords[0]?.version).toBe(0);

      // ② 旧记忆**未被覆盖、未被删除、版本未变**
      const after = s.store.getByIds([s.oldId])[0];
      expect(after).toBeDefined();
      expect(after.content).toBe(OLD_TEXT);
      expect(after.version).toBe(before.version);

      // 新记忆也不是"合并产物"——内容逐字等于抽取结果
      expect(s.store.getByIds([newId])[0]?.content).toBe(NEW_TEXT);

      // ③ 冲突对确实停放,且 resolved_at 为空(未裁决)
      const rows = pendingRows(s.db);
      expect(rows).toHaveLength(1);
      expect(rows[0].winner_id).toBe(newId);
      expect(rows[0].loser_id).toBe(s.oldId);
      expect(rows[0].resolved_at).toBe('');
      expect(rows[0].resolution).toBe('');
    } finally {
      s.close();
    }
  });

  it('非法的 conflict 输出(winner === loser)被拒,回落 store 且不停放', async () => {
    const s = await setup('same', true);
    try {
      extractQueue.push(extraction(NEW_TEXT));
      actionQueue.push('conflict_same');
      const out = await runExtraction({} as never, s.cfg, s.store, mkStates(), MSGS, [], noopLogger, 'work');
      expect(out.stored).toBe(1); // 信息不丢
      expect(out.newRecords[0]?.version).toBe(0); // 回落的是 store,不是 update/merge
      expect(pendingRows(s.db)).toHaveLength(0);
      expect(s.store.getByIds([s.oldId])[0]?.content).toBe(OLD_TEXT); // 也没误删旧记忆
    } finally {
      s.close();
    }
  });

  it('对侧不在候选池里的 conflict 被拒,回落 store 且不停放', async () => {
    const s = await setup('unknown', true);
    try {
      extractQueue.push(extraction(NEW_TEXT));
      actionQueue.push('conflict_unknown');
      const out = await runExtraction({} as never, s.cfg, s.store, mkStates(), MSGS, [], noopLogger, 'work');
      expect(out.stored).toBe(1);
      expect(out.newRecords[0]?.version).toBe(0); // 回落的是 store,不是 update/merge
      expect(pendingRows(s.db)).toHaveLength(0);
    } finally {
      s.close();
    }
  });

  it('**开关关闭**时即使模型硬给出 conflict 也按 store 处理,绝不静默变成覆盖', async () => {
    // 关闭态 prompt 里没有 conflict 动作(零漂移见 task_23),但模型可能凭惯性输出它。
    // 这里的危险不是"冻结没生效",而是"落到下面的 update/merge 分支被当成合并/覆盖"——
    // 那正是 §C 要消灭的行为,且它会在**新记录 version=1** 上留痕。
    const s = await setup('off', false);
    try {
      extractQueue.push(extraction(NEW_TEXT));
      actionQueue.push('conflict');
      const out = await runExtraction({} as never, s.cfg, s.store, mkStates(), MSGS, [], noopLogger, 'work');
      expect(out.stored).toBe(1);
      expect(out.newRecords[0]?.version).toBe(0);
      expect(pendingRows(s.db)).toHaveLength(0); // 开关关 → 不停放
      expect(s.store.getByIds([s.oldId])[0]?.content).toBe(OLD_TEXT); // 旧记忆逐字未变
    } finally {
      s.close();
    }
  });
});

describe('task_22 图谱域 disputed 标记(存储级)', () => {
  function seedNode(db: MemoryDb, ref: string, sourceRecordIds: string[]): void {
    db.graphStore.queueGraphProjection(sourceRecordIds, 10_000);
    const claim = db.graphStore.claimNext();
    expect(claim).not.toBeNull();
    db.graphStore.complete(claim?.job.id ?? '', {
      reason: '',
      nodes: [{ ref, name: `实体-${ref}`, type: 'project', sourceRecordIds }],
      edges: [],
    });
  }

  function l1Row(id: string): Record<string, unknown> {
    return {
      id,
      content: id,
      type: 'work_fact',
      priority: 60,
      scene_name: 's',
      timestamps: [1],
      createdAt: 1,
      updatedAt: 1,
      version: 0,
      source_message_ids: [],
      metadata: {},
      family: 'work',
    };
  }

  it('来源含冲突记录的节点被标 disputed,无关节点保持 active', async () => {
    root = root ?? (await mkdtemp(join(tmpdir(), 'dsh-conflict-graph-')));
    const dataDir = join(root, `graph-${Date.now()}`);
    const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
    db.init();
    try {
      // 真实投影路径要求来源是存活 L1 记录,故先落两条
      db.upsertL1Batch([l1Row('rec-a'), l1Row('rec-b')] as never);
      seedNode(db, 'a', ['rec-a']);
      seedNode(db, 'b', ['rec-b']);

      const marked = db.markSourcesDisputed(['rec-a']);
      expect(marked).toBe(1);

      const byName = new Map(db.graphStore.loadGraph().nodes.map((n) => [n.name, n.status]));
      expect(byName.get('实体-a')).toBe('disputed');
      expect(byName.get('实体-b')).toBe('active');
    } finally {
      db.close();
    }
  });

  it('已是 disputed 的节点不重复计数(幂等)', async () => {
    root = root ?? (await mkdtemp(join(tmpdir(), 'dsh-conflict-graph2-')));
    const dataDir = join(root, `graph2-${Date.now()}`);
    const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
    db.init();
    try {
      db.upsertL1Batch([l1Row('rec-a')] as never);
      seedNode(db, 'a', ['rec-a']);

      expect(db.markSourcesDisputed(['rec-a'])).toBe(1);
      expect(db.markSourcesDisputed(['rec-a'])).toBe(0); // 幂等:已 disputed 不再计数
      expect(db.graphStore.loadGraph().nodes[0]?.status).toBe('disputed');
    } finally {
      db.close();
    }
  });
});
