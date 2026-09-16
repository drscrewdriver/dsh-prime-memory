/**
 * 保留式重建**接线**单测(task_8c 的交付验证)。
 *
 * `rebuild-preserve.test.ts` 证的是判定逻辑本身;这里证的是
 * `RebuildController.prepare()` 把它**按对的顺序**接上了 —— 判定写对了但接错位置
 * 一样会丢数据,而这类错误纯函数测试看不见。
 *
 * 用真实 `MemoryDb` + 真实 `L1Store`(双写 JSONL 事实源)+ 假 scenes/persona/state,
 * L2/L3 关掉、`live.distill=false`,保证不触 LLM。
 *
 * 四条断言对应四种接错法:
 * 1. 快照在清空**之后**才建 → 快照里会只剩保留集(断言快照条数 == 清空前行数);
 * 2. 恢复在清空**之前** → 恢复的记录被自己清掉(断言清空瞬时检索库为空);
 * 3. 恢复只写检索库 → 新 `records/` 里没有它(断言新事实源含该 id);
 * 4. 闸门没接 → 事实源缺失时照常清空(断言检索库一条没少 + phase=failed)。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemoryConfig, MemoryLogger, MemoryRecord } from '../src/types.js';
import { RebuildController, type RebuildStores } from '../src/pipeline/rebuild.js';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { LiveSettingsHandle } from '../src/settings.js';

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };
const T = 1_700_000_000_000;

function cfg(dataDir: string): MemoryConfig {
  return {
    dataDir,
    family: 'auto',
    capture: { enabled: true, stripCodeBlocks: true, maxMessageChars: 4000 },
    extract: { enabled: true, minMessages: 6, idleSeconds: 300, backgroundMessages: 10, candidatePool: 5 },
    l2: { enabled: false, minNewMemories: 5, maxScenes: 12, sceneContextLimit: 3 },
    l3: { enabled: false, interval: 20 },
    recall: {
      enabled: true,
      maxResults: 5,
      maxCharsPerMemory: 500,
      maxTotalRecallChars: 2000,
      timeoutMs: 5000,
      includePersona: true,
      includeSceneNav: true,
      strategy: 'hybrid',
      scoreThreshold: 0.3,
      decayHalfLifeDays: 30,
    },
    embedding: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: '',
      dimensions: 0,
      maxInputChars: 5000,
      timeoutMs: 10000,
      allowLocalModels: true,
      mirror: 'https://hf-mirror.com',
      proxy: '',
    },
    llm: {
      provider: '',
      model: '',
      mode: 'host',
      baseURL: '',
      apiKey: '',
      maxTokens: 65536,
      reasoningEffort: '',
      maxInputChars: 700000,
      timeoutMs: 120000,
    },
    hall: { enabled: ['work'] },
    tokenCost: { retentionDays: 365 },
    tools: true,
    benchControl: false,
  } as MemoryConfig;
}

const liveHandle = (): LiveSettingsHandle =>
  ({ supported: true, get: () => ({ enabled: true, capture: true, distill: false }), update: async () => {} }) as unknown as LiveSettingsHandle;

function l1Rec(id: string, content: string, scene = '日常'): MemoryRecord {
  return {
    id,
    content,
    type: 'episodic',
    priority: 50,
    scene_name: scene,
    timestamps: [T],
    createdAt: T,
    updatedAt: T,
    version: 0,
    metadata: {},
    sessionId: 'default',
    family: 'chat',
  };
}

/** 事实源副本:导入记忆没有 `source_message_ids`,蒸馏记忆有。 */
function factLine(r: MemoryRecord, sourced: boolean): string {
  return JSON.stringify(sourced ? { ...r, source_message_ids: ['msg-1'] } : r);
}

interface Harness {
  readonly db: MemoryDb;
  readonly l1: L1Store;
  readonly ctl: RebuildController;
  /** 每块蒸馏开跑前采样一次检索库(证明"清空发生在蒸馏之前")。 */
  readonly dbAtChunk: () => string[];
  readonly dataDir: string;
}

async function harness(opts: { factSource?: 'ok' | 'missing'; dbRecords?: MemoryRecord[] } = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-rebuild-wire-'));
  const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
  db.init();

  // L0:一条消息就够 —— 它是重建的"燃料",与保留集无关(清 L1 不动 L0)
  db.upsertL0Batch([
    { sessionId: 's1', recordedAt: new Date(T).toISOString(), id: 'm1', role: 'user', content: '原始对话内容', timestamp: T },
  ]);

  const l1 = new L1Store(dataDir, db, undefined, 'keyword', noopLogger, 30);
  await l1.init();
  for (const r of opts.dbRecords ?? []) db.upsertL1(r);

  // 事实源(默认与检索库同形:导入记忆无来源,蒸馏记忆有来源)
  if (opts.factSource !== 'missing') {
    const recordsDir = join(dataDir, 'records');
    await mkdir(recordsDir, { recursive: true });
    await writeFile(
      join(recordsDir, '2026-09-17.jsonl'),
      (opts.dbRecords ?? []).map((r) => factLine(r, r.id.startsWith('d'))).join('\n') + '\n',
      'utf-8',
    );
  }

  let seenAtChunk: string[] = [];
  const states = { chat: { newMemoriesSinceL2: 0, lastL2At: 0 }, work: { newMemoriesSinceL2: 0, lastL2At: 0 } };
  const runner = {
    states,
    // 同步执行入队任务:测试要在 start() 返回后就能断言终态
    enqueueRebuildTask: (fn: () => Promise<void>) => {
      pending.push(fn());
    },
    runRebuildTurn: async () => {
      seenAtChunk = db.getAllL1().map((r) => r.id).sort();
      return 0;
    },
  };
  const pending: Promise<void>[] = [];

  const stores = {
    l1,
    scenes: { chat: { init: async () => {}, list: async () => [] }, work: { init: async () => {}, list: async () => [] } },
    persona: { chat: { init: async () => {} }, work: { init: async () => {} } },
    state: { reset: () => {}, save: async () => {} },
  } as unknown as RebuildStores;

  const ctl = new RebuildController({} as never, cfg(dataDir), stores, db, runner as never, noopLogger, liveHandle());
  ctl.start();
  // prepare → scheduleChunk → finalize 是一条入队链,逐层 await 到稳定
  for (let i = 0; i < 20 && i < pending.length + 1; i++) {
    const batch = pending.splice(0);
    if (batch.length === 0) break;
    await Promise.all(batch);
  }

  return { db, l1, ctl, dataDir, dbAtChunk: () => seenAtChunk };
}

describe('接线:保留式重建的固定顺序', () => {
  it('导入记忆全程未被动过;蒸馏记忆照常清掉(它会由 L0 重造)', async () => {
    const records = [
      l1Rec('imp_1', '外部导入的记忆', '__manual__'),
      l1Rec('imp_2', '手工写入的记忆', '外部导入/memport'),
      l1Rec('d_1', '由 L0 蒸馏的记忆'),
    ];
    const h = await harness({ dbRecords: records });
    try {
      // ① 清空 + 恢复之后,检索库里只剩两条导入记忆 —— 蒸馏记忆被清掉了(重建会再造)
      expect(h.db.getAllL1().map((r) => r.id).sort()).toEqual(['imp_1', 'imp_2']);
      // ② 逐条内容断言,不只断行数
      const byId = new Map(h.db.getAllL1().map((r) => [r.id, r.content]));
      expect(byId.get('imp_1')).toBe('外部导入的记忆');
      expect(byId.get('imp_2')).toBe('手工写入的记忆');
    } finally {
      h.db.close();
      await rm(h.dataDir, { recursive: true, force: true });
    }
  });

  it('恢复发生在首块蒸馏**之前**(否则重建会把它们当新记忆重复造)', async () => {
    const h = await harness({ dbRecords: [l1Rec('imp_1', '外部导入的记忆', '__manual__')] });
    try {
      expect(h.dbAtChunk()).toEqual(['imp_1']);
    } finally {
      h.db.close();
      await rm(h.dataDir, { recursive: true, force: true });
    }
  });

  it('快照建在清空**之前**:快照里含被清掉的蒸馏记忆,条数等于清空前的全量', async () => {
    const h = await harness({
      dbRecords: [l1Rec('imp_1', '外部导入的记忆', '__manual__'), l1Rec('d_1', '由 L0 蒸馏的记忆')],
    });
    try {
      const snapsDir = join(h.dataDir, 'snapshots');
      const dirs = await readdir(snapsDir);
      expect(dirs).toHaveLength(1);
      expect(dirs[0].startsWith('l1-')).toBe(true);
      expect(dirs[0].endsWith('pre-rebuild')).toBe(true);

      const saved = JSON.parse(await readFile(join(snapsDir, dirs[0], 'l1-records.json'), 'utf-8')) as MemoryRecord[];
      // 快照是"清空前全量"= 2 条;若接在清空之后,这里只会剩 1 条(保留集)
      expect(saved.map((r) => r.id).sort()).toEqual(['d_1', 'imp_1']);
    } finally {
      h.db.close();
      await rm(h.dataDir, { recursive: true, force: true });
    }
  });

  it('恢复是双写:新的 records/ 事实源里有导入记忆(否则下次重建判不出来)', async () => {
    const h = await harness({ dbRecords: [l1Rec('imp_1', '外部导入的记忆', '__manual__')] });
    try {
      const names = (await readdir(join(h.dataDir, 'records'))).filter((n) => n.endsWith('.jsonl'));
      expect(names.length).toBeGreaterThan(0);
      const lines: string[] = [];
      for (const n of names) {
        lines.push(...(await readFile(join(h.dataDir, 'records', n), 'utf-8')).split('\n').filter(Boolean));
      }
      const ids = lines.map((l) => (JSON.parse(l) as MemoryRecord).id);
      expect(ids).toContain('imp_1');
      // 旧的 records/ 被整体改名归档(不是硬删)
      expect((await readdir(h.dataDir)).some((n) => n.startsWith('records.bak.'))).toBe(true);
    } finally {
      h.db.close();
      await rm(h.dataDir, { recursive: true, force: true });
    }
  });

  it('状态里能看见保留了什么(只写日志的话用户无从判断)', async () => {
    const h = await harness({ dbRecords: [l1Rec('imp_1', '外部导入的记忆', '__manual__')] });
    try {
      const st = h.ctl.getStatus();
      expect(st.preserveNote).toContain('保留 1 条');
      expect(st.phase).toBe('done');
    } finally {
      h.db.close();
      await rm(h.dataDir, { recursive: true, force: true });
    }
  });
});

describe('接线:闸门拒绝时一条数据都不动', () => {
  it('事实源目录缺失 + 检索库非空 → failed,且检索库原样', async () => {
    const h = await harness({
      factSource: 'missing',
      dbRecords: [l1Rec('imp_1', '外部导入的记忆', '__manual__'), l1Rec('d_1', '由 L0 蒸馏的记忆')],
    });
    try {
      const st = h.ctl.getStatus();
      expect(st.phase).toBe('failed');
      expect(st.error).toContain('未清空');
      // 关键:清空没发生
      expect(h.db.getAllL1().map((r) => r.id).sort()).toEqual(['d_1', 'imp_1']);
      // 也没建快照、没归档(中止发生在破坏性动作之前)
      expect((await readdir(h.dataDir)).some((n) => n === 'snapshots')).toBe(false);
      expect((await readdir(h.dataDir)).every((n) => !n.startsWith('records.bak.'))).toBe(true);
    } finally {
      h.db.close();
      await rm(h.dataDir, { recursive: true, force: true });
    }
  });
});
