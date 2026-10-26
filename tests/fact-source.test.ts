/**
 * issue #14-B：重建事实源抽象。
 *
 * 要证的六件事：
 * 1. 本地 provider 的 `estimate()` **同步且 known=true**（`start()` 的同步门要靠它）；
 * 2. `snapshotIds()` **只读 id 不读正文**（这是"不发 88MB 也能判 post-watermark"的前提）；
 * 3. `chunks()` 按会话流式且顺序 = 首条消息时间升序（上下文链衔接方向）；
 * 4. DRSC provider 恒带 `redact=1`（collector 的 session 缺省是原文臂）；
 * 5. DRSC 的 `snapshotIds()` 返回**空集**——判不出来就保守全保留，不猜；
 * 6. 选 drsc 但客户端缺席 → 显式报错，不静默回退本地表。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DrscFactSource, LocalL0FactSource, groupL0Sessions } from '../src/pipeline/fact-source.js';
import { DrscClient } from '../src/clients/drsc.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { MemoryLogger } from '../src/types.js';

const T = 1_700_000_000_000;

const logger: MemoryLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

async function withDb<T>(fn: (db: MemoryDb) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fact-source-'));
  const db = new MemoryDb(join(dir, 'memory.db'), 0);
  db.init();
  try {
    return await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** 一次 collector 调用的桩响应（按 query 分派，便于断言 URL 细节）。 */
function fakeFetch(routes: (url: string) => unknown): typeof fetch {
  return (async (url: string) => {
    const body = routes(String(url));
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('LocalL0FactSource：同步门 + 只读 id + 按会话流', () => {
  it('estimate() 同步且 known=true；coverage 报出 L0 水位', async () => {
    await withDb(async (db) => {
      db.upsertL0Batch([
        { sessionId: 's1', recordedAt: new Date(T).toISOString(), id: 'm1', role: 'user', content: '你好', timestamp: T },
      ]);
      const p = new LocalL0FactSource(db, logger);
      const est = p.estimate(); // 不是 Promise —— start() 是同步 RPC
      expect(est.known).toBe(true);
      expect(est.sessions).toBe(1);
      expect(est.messages).toBe(1);
      expect(p.coverage().untilIso).toBe(new Date(T).toISOString());
      await expect(p.prepare()).resolves.toMatchObject({ sessions: 1, known: true });
    });
  });

  it('snapshotIds() 只取 id 集（判 post-watermark 用）', async () => {
    await withDb(async (db) => {
      db.upsertL0Batch([
        { sessionId: 's1', recordedAt: new Date(T).toISOString(), id: 'm1', role: 'user', content: 'a', timestamp: T },
        { sessionId: 's1', recordedAt: new Date(T + 1).toISOString(), id: 'm2', role: 'assistant', content: 'b', timestamp: T + 1 },
      ]);
      const ids = await new LocalL0FactSource(db, logger).snapshotIds();
      expect([...ids].sort()).toEqual(['m1', 'm2']);
    });
  });

  it('chunks() 按首条消息时间升序产会话块，且丢弃非法行', async () => {
    await withDb(async (db) => {
      // 交错写入两个会话：s_late 的首条更晚
      db.upsertL0Batch([
        { sessionId: 's_early', recordedAt: new Date(T).toISOString(), id: 'e1', role: 'user', content: '早', timestamp: T },
        { sessionId: 's_late', recordedAt: new Date(T + 100).toISOString(), id: 'l1', role: 'user', content: '晚', timestamp: T + 100 },
        { sessionId: 's_early', recordedAt: new Date(T + 200).toISOString(), id: 'e2', role: 'assistant', content: '  ', timestamp: T + 200 },
      ]);
      const chunks = await collect(new LocalL0FactSource(db, logger).chunks());
      expect(chunks.map((c) => c.sessionId)).toEqual(['s_early', 's_late']);
      // 空白正文被丢弃：s_early 只剩 e1
      expect(chunks[0]!.messages.map((m) => m.id)).toEqual(['e1']);
    });
  });

  it('groupL0Sessions 与流式 chunks 给出同一分组（纯函数与生产路径不许分叉）', async () => {
    await withDb(async (db) => {
      db.upsertL0Batch([
        { sessionId: 'a', recordedAt: new Date(T).toISOString(), id: 'a1', role: 'user', content: 'x', timestamp: T },
        { sessionId: 'b', recordedAt: new Date(T + 50).toISOString(), id: 'b1', role: 'assistant', content: 'y', timestamp: T + 50 },
      ]);
      const p = new LocalL0FactSource(db, logger);
      const viaChunks = await collect(p.chunks());
      const viaSnapshot = groupL0Sessions(await collect(p.snapshot()));
      expect(viaChunks.map((c) => [c.sessionId, c.messages.map((m) => m.id)]))
        .toEqual(viaSnapshot.map((c) => [c.sessionId, c.messages.map((m) => m.id)]));
    });
  });
});

describe('DrscFactSource：N+1 组合 + redact 硬要求', () => {
  const makeClient = (seen: string[]): DrscClient =>
    new DrscClient({
      baseUrl: 'http://127.0.0.1:9',
      fetchImpl: fakeFetch((url) => {
        seen.push(url);
        if (url.includes('op=sessions')) {
          // collector 按 last_time_ms **降序**返回
          return {
            ok: true,
            total: 2,
            rows: [
              { session_id: 's_late', last_time_ms: 200, event_count: 2, turn_count: 1, title: '', cwd: '' },
              { session_id: 's_early', last_time_ms: 100, event_count: 2, turn_count: 1, title: '', cwd: '' },
            ],
          };
        }
        if (url.includes('session=s_early')) {
          return {
            ok: true,
            session: { session_id: 's_early' },
            rows: [
              { seq: 1, turn: 1, step: 0, kind: 'user/message', role: '', time: 10, text: '早问' },
              { seq: 2, turn: 1, step: 1, kind: 'assistant/message', role: '', time: 11, text: '早答' },
              { seq: 3, turn: 1, step: 2, kind: 'tool/call', role: '', time: 12, text: '不该进来' },
            ],
          };
        }
        return {
          ok: true,
          session: { session_id: 's_late' },
          rows: [{ seq: 1, turn: 1, step: 0, kind: 'user/message', role: '', time: 200, text: '晚问' }],
        };
      }),
    });

  it('estimate() 标 known=false（同步报不出数）', () => {
    const p = new DrscFactSource(makeClient([]), logger);
    expect(p.estimate().known).toBe(false);
  });

  it('chunks() 按 last_time_ms 升序（反转 collector 的降序），只留 user/assistant', async () => {
    const seen: string[] = [];
    const p = new DrscFactSource(makeClient(seen), logger);
    const chunks = await collect(p.chunks());
    expect(chunks.map((c) => c.sessionId)).toEqual(['s_early', 's_late']);
    // tool/call 段不进事实源
    expect(chunks[0]!.messages.map((m) => m.id)).toEqual(['drsc:s_early:1', 'drsc:s_early:2']);
  });

  it('每次 session 请求都带 redact=1（缺省是原文臂）', async () => {
    const seen: string[] = [];
    await collect(new DrscFactSource(makeClient(seen), logger).chunks());
    const sessionCalls = seen.filter((u) => u.includes('op=session&'));
    expect(sessionCalls.length).toBeGreaterThan(0);
    for (const u of sessionCalls) expect(u).toContain('redact=1');
  });

  it('prepare() 枚举会话并缓存，chunks() 不重复拉 sessions', async () => {
    const seen: string[] = [];
    const p = new DrscFactSource(makeClient(seen), logger);
    const est = await p.prepare();
    expect(est).toMatchObject({ sessions: 2, known: true });
    await collect(p.chunks());
    expect(seen.filter((u) => u.includes('op=sessions')).length).toBe(1);
  });

  it('snapshotIds() 返回空集：判不出就保守全保留，不猜', async () => {
    const ids = await new DrscFactSource(makeClient([]), logger).snapshotIds();
    expect(ids.size).toBe(0);
  });
});
