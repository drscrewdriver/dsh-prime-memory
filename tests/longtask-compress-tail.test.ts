import { describe, expect, it, vi } from 'vitest';
import { compressTailTurns } from '../src/stats.js';
import type { SessionModeStore } from '../src/store/session-modes.js';
import type { L0Store } from '../src/store/l0.js';
import type { MemoryRunner } from '../src/pipeline/runner.js';
import type { MemoryLogger } from '../src/types.js';
import type { ConversationMessage } from '../src/types.js';

function message(turn: number): ConversationMessage {
  return { id: `m${turn}`, role: 'user', content: `turn-${turn}`, timestamp: turn, anchor: { sessionId: 's1', turn } };
}

function makeIo(opts: {
  capturedTurn: number | undefined;
  watermark?: number;
  mode?: 'auto' | 'chat' | 'work' | 'off';
  turnsInWindow?: number;
}) {
  const watermarks: number[] = [];
  const enqueued: ConversationMessage[][] = [];
  const modes = {
    getTailWatermark: () => opts.watermark,
    setTailWatermark: (_sid: string, turn: number) => watermarks.push(turn),
    get: () => opts.mode ?? 'auto',
  } as unknown as SessionModeStore;
  const l0 = {
    maxCapturedTurn: () => opts.capturedTurn,
    recentBySession: async (_sid: string, limit: number) => {
      const n = opts.turnsInWindow ?? opts.capturedTurn ?? 0;
      return Array.from({ length: Math.min(n, limit) }, (_, i) => message(i + 1));
    },
  } as unknown as L0Store;
  const runner = { enqueue: (_sid: string, msgs: ConversationMessage[]) => enqueued.push(msgs) } as unknown as MemoryRunner;
  const logger: MemoryLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { modes, l0, runner, logger, watermarks, enqueued };
}

describe('compressTailTurns', () => {
  it('enqueues messages within (watermark, captured] and advances the watermark', async () => {
    const io = makeIo({ capturedTurn: 10, watermark: 4 });
    const r = await compressTailTurns('s1', 6, io);
    expect(r.enqueued).toBeGreaterThan(0);
    expect(r.fromTurn).toBe(5);
    expect(r.toTurn).toBe(10);
    expect(io.watermarks).toEqual([10]);
    expect(io.enqueued[0].every((m) => (m.anchor?.turn ?? 0) >= 5)).toBe(true);
  });

  it('no-op when no captured turns or window already compressed', async () => {
    const empty = makeIo({ capturedTurn: undefined });
    expect(await compressTailTurns('s1', 6, empty)).toEqual({ enqueued: 0, fromTurn: null, toTurn: null });
    const done = makeIo({ capturedTurn: 10, watermark: 10 });
    const r = await compressTailTurns('s1', 6, done);
    expect(r.enqueued).toBe(0);
    expect(done.watermarks).toEqual([]);
  });

  it('off-mode sessions stay invisible (never compressed)', async () => {
    const io = makeIo({ capturedTurn: 10, mode: 'off' });
    const r = await compressTailTurns('s1', 6, io);
    expect(r.enqueued).toBe(0);
    expect(io.watermarks).toEqual([]);
  });

  it('first compression includes legacy anchorless rows (watermark=0), later runs exclude them', async () => {
    const io = makeIo({ capturedTurn: 8, turnsInWindow: 8 });
    const r = await compressTailTurns('s1', 3, io);
    expect(r.enqueued).toBe(3);
    // 二次:水位线已到 8,窗口空
    const io2 = makeIo({ capturedTurn: 8, watermark: 8, turnsInWindow: 8 });
    const r2 = await compressTailTurns('s1', 3, io2);
    expect(r2.enqueued).toBe(0);
  });
});
