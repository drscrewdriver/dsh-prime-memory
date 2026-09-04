/**
 * Hooks 层单元测试:捕获缓冲裁剪铁律/轮次转换/召回查询构造/占用流水持久化。
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CaptureBuffers, isCaptureRelevant, trimBuffer } from '../src/hooks/capture.js';
import { buildRecallQuery, emptyRecallStats } from '../src/hooks/recall.js';
import { OCCUPANCY_SESSION_CAP, OccupancyStore } from '../src/store/occupancy.js';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { OccupancyLedger } from '../src/util/context-occupancy.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-hooks-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function ev(type: string, turn: number, time = 0): SessionEvent {
  return { type, time, data: { turn } } as unknown as SessionEvent;
}

describe('capture buffers', () => {
  it('relevance filter excludes streaming chunks', () => {
    expect(isCaptureRelevant('user/message')).toBe(true);
    expect(isCaptureRelevant('turn/end')).toBe(true);
    expect(isCaptureRelevant('text-delta')).toBe(false);
    expect(isCaptureRelevant('reasoning-delta')).toBe(false);
  });

  it('takeTurn returns turn events and frees entry when buffer empties', () => {
    const buf = new CaptureBuffers();
    buf.push('s1', ev('turn/start', 1));
    buf.push('s1', ev('user/message', 1));
    buf.push('s1', ev('assistant/message', 1));
    buf.push('s1', ev('turn/end', 1));
    const events = buf.takeTurn('s1', 1);
    expect(events.map((e) => e.type)).toEqual(['user/message', 'assistant/message', 'turn/end']);
    expect(buf.size).toBe(0); // 前缀为空即删条目(防慢泄漏)
  });

  it('trimBuffer never cuts an in-progress turn (turn/start without end)', () => {
    const buf: SessionEvent[] = [];
    for (let i = 0; i < 300; i++) buf.push(ev('turn/start', i), ev('turn/end', i));
    // 打开一个未闭合轮次
    buf.push(ev('turn/start', 999));
    buf.push(ev('user/message', 999));
    const before = buf.length;
    trimBuffer(buf);
    expect(buf.length).toBeLessThan(before);
    // 未闭合轮次的事件必须幸存
    expect(buf.some((e) => e.type === 'user/message' && e.data.turn === 999)).toBe(true);
    // 最早保留的事件是未闭合 turn/start 自身
    expect(buf[0].type).toBe('turn/start');
  });
});

describe('recall query', () => {
  it('tail messages + total char cap keep the newest context', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({ content: [{ type: 'text', text: `msg-${i}` }] }));
    expect(buildRecallQuery(messages, 2, 1000)).toBe('msg-18 msg-19');
    const long = Array.from({ length: 2 }, (_, i) => ({
      content: [{ type: 'text', text: `a${i}`.repeat(600) }],
    }));
    const q = buildRecallQuery(long, 8, 100);
    expect(q.length).toBe(100);
    expect(q.endsWith('a1')).toBe(true); // 保留末尾(最新语境)
    expect(buildRecallQuery([], 8, 100)).toBe('');
  });
});

describe('recall stats shape', () => {
  it('zero-value stats carry all counters', () => {
    const s = emptyRecallStats(123);
    expect(s).toEqual({
      injectedTurns: 0, hitTurns: 0, totalHits: 0, timeouts: 0,
      suppressedRecalls: 0, lastHits: 0, lastDurationMs: 0, updatedAt: 123,
    });
  });
});

describe('occupancy store', () => {
  const NOW = Date.now();
  function ledger(over: Partial<OccupancyLedger> = {}): OccupancyLedger {
    return { stockTokens: 100, recallTokens: 60, profileTokens: 40, lastInjectTokens: 20, updatedAt: NOW, ...over };
  }

  it('save/load roundtrip; zero-stock entries dropped from disk', async () => {
    const dataDir = join(await tmp(), `occ-${Date.now()}`);
    const s = new OccupancyStore(dataDir);
    await s.flush();
    s.save('a', ledger({ updatedAt: NOW }));
    s.save('zero', ledger({ stockTokens: 0, recallTokens: 0, profileTokens: 0, updatedAt: NOW + 1 }));
    await s.flush();
    expect(s.load('a')).toEqual(ledger({ updatedAt: NOW }));
    expect(s.load('zero')).toBeNull(); // stock 归零即删

    const s2 = new OccupancyStore(dataDir);
    await s2.flush();
    expect(s2.load('a')).not.toBeNull(); // 重启复生
    expect(s2.load('zero')).toBeNull(); // 归零条目不落盘
  });

  it('unchanged numbers skip disk write but refresh timestamp in memory', async () => {
    const dataDir = join(await tmp(), `occ2-${Date.now()}`);
    const s = new OccupancyStore(dataDir);
    await s.flush();
    s.save('a', ledger({ updatedAt: NOW }));
    await s.flush();
    const raw1 = await readFile(join(dataDir, 'occupancy.json'), 'utf-8');
    s.save('a', ledger({ updatedAt: NOW + 1 })); // 数值相同
    await s.flush();
    const raw2 = await readFile(join(dataDir, 'occupancy.json'), 'utf-8');
    expect(raw2).toBe(raw1); // 未写盘
    expect(s.load('a')?.updatedAt).toBe(NOW + 1); // 内存时间戳已刷新
  });

  it('load returns a copy (mutation via handle does not corrupt store)', async () => {
    const dataDir = join(await tmp(), `occ3-${Date.now()}`);
    const s = new OccupancyStore(dataDir);
    await s.flush();
    s.save('a', ledger({ updatedAt: NOW }));
    const handle = s.load('a');
    handle!.stockTokens = 999; // 原地改副本
    await s.flush();
    expect(s.load('a')?.stockTokens).toBe(100);
  });

  it('session cap evicts oldest entries on serialize', async () => {
    const dataDir = join(await tmp(), `occ4-${Date.now()}`);
    const s = new OccupancyStore(dataDir);
    await s.flush();
    for (let i = 0; i < OCCUPANCY_SESSION_CAP + 5; i++) {
      s.save(`s${i}`, ledger({ updatedAt: NOW + i }));
    }
    await s.flush();
    expect(s.load('s0')).toBeNull(); // 最旧被淘汰
    expect(s.load(`s${OCCUPANCY_SESSION_CAP + 4}`)).not.toBeNull();
  });
});
