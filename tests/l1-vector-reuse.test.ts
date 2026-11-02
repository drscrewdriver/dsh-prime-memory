/**
 * L1 写侧向量复用（`appendNew(records, { vectors })` / `upsert(record, { vector })`）。
 *
 * 为什么值得单测：批内自去重已经把「同一条记忆」的向量算过一次（候选召回 + 批内聚类），
 * 若写侧再 `helper.batch` 一次，就是**同一条正文嵌两遍**——bge-m3 q8 实测约 1.1s/条，
 * 这是纯浪费且随蒸馏条数线性放大。
 *
 * 判据不看内部实现，看**外部可观测**：注入一个会记账的 `EmbeddingService`，断言
 * ① 复用位不再触发 embedBatch；② 未命中位仍实嵌（不能把该嵌的也省掉）；
 * ③ merge 产出的新正文（同 record_id、不同 content）不得复用旧向量。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { EmbeddingProviderInfo, EmbeddingService } from '../src/store/embedding.js';
import type { MemoryLogger, MemoryRecord } from '../src/types.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'l1-vec-reuse-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** 记账型嵌入服务：记录每次被要求嵌入的文本。 */
function countingEmbed(): { svc: EmbeddingService; calls: string[][] } {
  const calls: string[][] = [];
  const vec = () => new Float32Array([0.5, 0.5, 0.5, 0.5]);
  const svc: EmbeddingService = {
    embed: async (t) => {
      calls.push([t]);
      return vec();
    },
    embedBatch: async (texts) => {
      calls.push([...texts]);
      return texts.map(() => vec());
    },
    getDimensions: () => 4,
    getProviderInfo: (): EmbeddingProviderInfo => ({ provider: 'fake', model: 'fake', dimensions: 4 }),
    isReady: () => true,
  };
  return { svc, calls };
}

function rec(id: string, content: string): MemoryRecord {
  const now = Date.now();
  return {
    id,
    content,
    type: 'preference',
    priority: 50,
    scene_name: '日常',
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 0,
    metadata: {},
    family: 'chat',
  } as MemoryRecord;
}

function makeStore(): { store: L1Store; calls: string[][]; db: MemoryDb } {
  const d = tmp();
  const db = new MemoryDb(join(d, 'memory.db'), 0);
  db.init();
  const { svc, calls } = countingEmbed();
  const store = new L1Store(d, db, svc, 'keyword', noopLogger, 0);
  return { store, calls, db };
}

describe('L1 写侧向量复用', () => {
  it('appendNew：复用位不再嵌入，未命中位仍实嵌', async () => {
    const { store, calls, db } = makeStore();
    const vectors = [new Float32Array([0.1, 0.1, 0.1, 0.1]), undefined, new Float32Array([0.3, 0.3, 0.3, 0.3])];
    await store.appendNew([rec('a', '第一条'), rec('b', '第二条'), rec('c', '第三条')], { vectors });
    // 只有 b 需要现嵌 → 只需一次 embedBatch，且文本只有第二条
    expect(calls).toEqual([['第二条']]);
    expect(db.countL1()).toBe(3);
    db.close();
  });

  it('appendNew：不传 vectors 时按旧路整批实嵌（回归）', async () => {
    const { store, calls, db } = makeStore();
    await store.appendNew([rec('x', '甲'), rec('y', '乙')]);
    expect(calls).toEqual([['甲', '乙']]);
    db.close();
  });

  it('appendNew：vectors 长度不匹配 → 整批回落实嵌（不猜位置）', async () => {
    const { store, calls, db } = makeStore();
    await store.appendNew([rec('p', '子'), rec('q', '丑')], { vectors: [new Float32Array(4)] });
    expect(calls).toEqual([['子', '丑']]);
    db.close();
  });

  it('appendNew：vectors 全为 undefined → 整批实嵌（等价未传）', async () => {
    const { store, calls, db } = makeStore();
    await store.appendNew([rec('m', '寅')], { vectors: [undefined] });
    expect(calls).toEqual([['寅']]);
    db.close();
  });

  it('upsert：给 vector 即复用；不给则现嵌（merge 新正文走这条）', async () => {
    const { store, calls, db } = makeStore();
    await store.upsert(rec('u1', '旧正文'), { vector: new Float32Array([0.2, 0.2, 0.2, 0.2]) });
    expect(calls).toEqual([]); // 复用，未触发嵌入
    await store.upsert(rec('u1', '合并后的新正文'));
    expect(calls).toEqual([['合并后的新正文']]); // 新正文必须实嵌
    db.close();
  });
});
