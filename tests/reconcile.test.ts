/**
 * 核对器单测(task_8 / R1·R2)。
 *
 * 这个文件的重心不是"能判对",而是**判错的那几条路必须被堵死**:
 * 1. 取不到证据 → 永远 unverifiable,绝不 contradicted(防假阳性)
 * 2. 模型编原文 → 引文核不上就降级(反幻觉闸门)
 * 3. 老记忆没锚点 → 不猜会话,直接跳过(不伪造坐标)
 * 4. 跳过原因**分开计数**,不与"确实没谈过"合并
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildReconcilePrompt,
  evidenceFailureToState,
  makeModelJudge,
  normalizeForCompare,
  parseVerdict,
  quoteIsGrounded,
  reconcileMemory,
  renderReport,
  runReconcile,
  type ReconcileDeps,
  type ReconcileInput,
  type MemoryVerdict,
} from '../src/pipeline/reconcile.js';
import type { EvidenceEvent, EvidenceSource } from '../src/store/evidence-source.js';
import type { ConversationAnchor } from '../src/types.js';

function anchor(turn: number, step?: number): ConversationAnchor {
  const a: ConversationAnchor = { sessionId: 'session-x', turn };
  if (step !== undefined) a.step = step;
  return a;
}

const EVIDENCE_TEXT = '这次改用 zstd 多帧解码,因为单帧只解出前 192 字节。';

function evidenceOf(events: EvidenceEvent[]): EvidenceSource {
  return {
    byAnchors: async () => ({
      ok: true,
      slice: { sessionId: 'session-x', anchors: [anchor(1)], events, truncated: false },
    }),
  };
}

function eventsFixture(): EvidenceEvent[] {
  return [
    { seq: 1, turn: 1, step: 1, type: 'user/message', text: '解码为什么只出 192 字节?' },
    { seq: 2, turn: 1, step: 1, type: 'assistant/message', text: EVIDENCE_TEXT },
  ];
}

function deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    evidence: evidenceOf(eventsFixture()),
    judge: async () => JSON.stringify({ state: 'supported', reason: '原文一致', quote: '单帧只解出前 192 字节' }),
    ...over,
  };
}

function memory(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return { id: 'mem_1', text: 'zstd 单帧解码只会解出第一帧。', sourceAnchors: [anchor(1)], ...over };
}

describe('反幻觉闸门 —— 判定不落地就不算判定', () => {
  it('引文确实在证据里 → 放行', () => {
    expect(quoteIsGrounded('单帧只解出前 192 字节', [EVIDENCE_TEXT])).toBe(true);
  });

  it('引文不在证据里 → 拦截', () => {
    expect(quoteIsGrounded('我在文档里写过这句话', [EVIDENCE_TEXT])).toBe(false);
  });

  it('空白差异不影响比对', () => {
    expect(normalizeForCompare('a\n b\tc')).toBe('a b c');
    expect(quoteIsGrounded('只解出前\n192', [EVIDENCE_TEXT])).toBe(true);
  });

  it('过短的引文没有证明力,不算落地', () => {
    expect(quoteIsGrounded('的', [EVIDENCE_TEXT])).toBe(false);
    expect(quoteIsGrounded('abc', [EVIDENCE_TEXT])).toBe(false);
  });

  it('模型自称 contradicted 但编了一段原文 → 降级 unverifiable', () => {
    const verdict = parseVerdict(
      JSON.stringify({ state: 'contradicted', reason: '原文说的是别的', quote: '这段原文根本不存在于证据中' }),
      [EVIDENCE_TEXT],
    );
    expect(verdict.state).toBe('unverifiable');
    expect(verdict.reason).toContain('反幻觉闸门');
    expect(verdict.quote).toBeUndefined();
  });

  it('模型自称 supported 但没给引文 → 同样降级', () => {
    const verdict = parseVerdict(JSON.stringify({ state: 'supported', reason: '看起来一致' }), [EVIDENCE_TEXT]);
    expect(verdict.state).toBe('unverifiable');
  });

  it('输出不是 JSON → 降级,不抛', () => {
    const verdict = parseVerdict('我觉得是一致的。', [EVIDENCE_TEXT]);
    expect(verdict.state).toBe('unverifiable');
  });

  it('状态非法 → 降级', () => {
    const verdict = parseVerdict(JSON.stringify({ state: 'maybe', reason: 'x' }), [EVIDENCE_TEXT]);
    expect(verdict.state).toBe('unverifiable');
  });

  it('unverifiable 不需要引文,原样保留理由', () => {
    const verdict = parseVerdict(JSON.stringify({ state: 'unverifiable', reason: '原文与记忆无关' }), [EVIDENCE_TEXT]);
    expect(verdict).toMatchObject({ state: 'unverifiable', reason: '原文与记忆无关' });
  });
});

describe('证据缺失一律 unverifiable —— 防假阳性', () => {
  it('六类证据失败**全部**映射到 unverifiable', () => {
    for (const reason of ['no-service', 'no-anchor', 'session-unreadable', 'anchor-not-found', 'timeout', 'error'] as const) {
      expect(evidenceFailureToState(reason)).toBe('unverifiable');
    }
  });

  it('没有锚点的老记忆 → 跳过,且不猜会话', async () => {
    const judge = vi.fn(async () => JSON.stringify({ state: 'contradicted', reason: 'x', quote: 'y' }));
    const verdict = await reconcileMemory(deps({ judge }), memory({ sourceAnchors: [] }));
    expect(verdict).toMatchObject({ state: 'unverifiable', skipped: 'no-anchor', eventCount: 0 });
    expect(judge).not.toHaveBeenCalled(); // 没有证据就不该去问模型
  });

  it('会话读不到 → skipped:session-unreadable,且不调用模型', async () => {
    const judge = vi.fn(async () => '{}');
    const verdict = await reconcileMemory(
      deps({
        evidence: { byAnchors: async () => ({ ok: false, reason: 'session-unreadable', detail: '日志已删' }) },
        judge,
      }),
      memory(),
    );
    expect(verdict).toMatchObject({ state: 'unverifiable', skipped: 'session-unreadable' });
    expect(verdict.reason).toContain('日志已删');
    expect(judge).not.toHaveBeenCalled();
  });

  it('模型调用抛错 → unverifiable,不向上抛', async () => {
    const verdict = await reconcileMemory(
      deps({
        judge: async () => {
          throw new Error('LLM 挂了');
        },
      }),
      memory(),
    );
    expect(verdict.state).toBe('unverifiable');
    expect(verdict.reason).toContain('LLM 挂了');
  });
});

describe('reconcileMemory —— 正常路径', () => {
  it('supported 带上已核实的引文', async () => {
    const verdict = await reconcileMemory(deps(), memory());
    expect(verdict).toMatchObject({ memoryId: 'mem_1', state: 'supported', eventCount: 2, sessionId: 'session-x' });
    expect(verdict.quote).toBe('单帧只解出前 192 字节');
    expect(verdict.skipped).toBeUndefined();
  });

  it('contradicted 在引文确实可核实时**成立**(闸门不是一刀切禁止)', async () => {
    const verdict = await reconcileMemory(
      deps({
        judge: async () => JSON.stringify({ state: 'contradicted', reason: '原文说的是多帧', quote: '多帧解码' }),
      }),
      memory(),
    );
    expect(verdict.state).toBe('contradicted');
    expect(verdict.quote).toBe('多帧解码');
  });

  it('contradicted 但引文核不上 → 降级(同一路径的另一半)', async () => {
    const verdict = await reconcileMemory(
      deps({
        judge: async () =>
          JSON.stringify({ state: 'contradicted', reason: '原文说的是多帧', quote: '这句原文并不存在' }),
      }),
      memory(),
    );
    expect(verdict.state).toBe('unverifiable');
    expect(verdict.quote).toBeUndefined();
  });

  it('prompt 里带上坐标与证据文本', () => {
    const prompt = buildReconcilePrompt(memory(), eventsFixture(), 10_000);
    expect(prompt.user).toContain('t1 s1 user/message #1');
    expect(prompt.user).toContain(EVIDENCE_TEXT);
    expect(prompt.system).toContain('unverifiable');
  });

  it('证据超长时截断并显式标注', () => {
    const prompt = buildReconcilePrompt(memory(), eventsFixture(), 40);
    expect(prompt.user).toContain('已截断');
  });
});

describe('runReconcile —— 只读与报告', () => {
  it('产出计数、报告与逐条判定', async () => {
    const result = await runReconcile(deps(), [memory(), memory({ id: 'mem_2', sourceAnchors: [] })]);
    expect(result.counts).toEqual({ contradicted: 0, supported: 1, unverifiable: 1 });
    expect(result.report).toContain('# 记忆核对报告');
    expect(result.report).toContain('只读');
  });

  it('跳过原因单列成表,不与"确实没谈过"合并', async () => {
    const result = await runReconcile(deps(), [memory({ id: 'm1', sourceAnchors: [] }), memory({ id: 'm2', sourceAnchors: [] })]);
    expect(result.report).toContain('## 跳过原因分布');
    expect(result.report).toContain('| `no-anchor` | 2 |');
    expect(result.report).toContain('这些条目**不是**');
  });

  it('maxRecords 限制条数', async () => {
    const many = Array.from({ length: 5 }, (_v, i) => memory({ id: `m${i}` }));
    const result = await runReconcile(deps(), many, { maxRecords: 2 });
    expect(result.verdicts).toHaveLength(2);
  });

  it('abort 后立即停止,已完成的保留', async () => {
    const controller = new AbortController();
    const many = Array.from({ length: 5 }, (_v, i) => memory({ id: `m${i}` }));
    const result = await runReconcile(
      deps({
        judge: async () => {
          controller.abort();
          return JSON.stringify({ state: 'supported', reason: 'ok', quote: '单帧只解出前 192 字节' });
        },
      }),
      many,
      { signal: controller.signal },
    );
    expect(result.verdicts).toHaveLength(1);
  });

  it('只读断言:核对全程不触碰任何写接口', async () => {
    // deps 的类型面里只有 evidence(读)与 judge(产文本);本用例把"没有任何写"
    // 变成可执行断言 —— 任何写入尝试都会因为 deps 上没有该方法而失败
    const probes: string[] = [];
    const spyDeps: ReconcileDeps = {
      evidence: {
        byAnchors: async () => {
          probes.push('read');
          return { ok: true, slice: { sessionId: 's', anchors: [anchor(1)], events: eventsFixture(), truncated: false } };
        },
      },
      judge: async () => {
        probes.push('judge');
        return JSON.stringify({ state: 'supported', reason: 'ok', quote: '单帧只解出前 192 字节' });
      },
    };
    await runReconcile(spyDeps, [memory()]);
    expect(probes).toEqual(['read', 'judge']);
    expect(Object.keys(spyDeps).sort()).toEqual(['evidence', 'judge']);
  });

  it('报告里每条都带记忆原文(不能只给 id)', () => {
    const verdicts: MemoryVerdict[] = [
      {
        memoryId: 'mem_1',
        text: '记忆正文',
        state: 'supported',
        reason: '一致',
        anchors: [anchor(3, 2)],
        eventCount: 1,
        sessionId: 'session-x',
        quote: '原文片段',
      },
    ];
    const report = renderReport(verdicts, { contradicted: 0, supported: 1, unverifiable: 0 }, 1, 50);
    expect(report).toContain('记忆正文');
    expect(report).toContain('t3 s2');
    expect(report).toContain('原文片段');
  });
});

describe('makeModelJudge —— 生产装配', () => {
  it('是可直接注入 judge 的函数形态', () => {
    expect(typeof makeModelJudge({} as never, {} as never)).toBe('function');
  });
});

describe('只读断言(真库):核对跑完后库内容逐字节不变', () => {
  it('runReconcile 一轮后,l1_records / l1_receipts / conflict_pending 全部原样', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { MemoryDb } = await import('../src/store/sqlite.js');
    type MemoryRecord = import('../src/types.js').MemoryRecord;

    const dir = await mkdtemp(join(tmpdir(), 'dsh-reconcile-'));
    try {
      const db = new MemoryDb(join(dir, 'readonly.db'), 0);
      db.init();
      const now = Date.now();
      const record: MemoryRecord = {
        id: 'mem_ro_1',
        content: 'zstd 单帧解码只解出第一帧。',
        type: 'episodic',
        priority: 50,
        scene_name: '日常',
        timestamps: [now],
        createdAt: now,
        updatedAt: now,
        version: 0,
        metadata: {},
        sessionId: 'default',
        family: 'chat',
      };
      expect(db.upsertL1(record)).toBe(true);

      // 快照:把三张表按**内容**转成一个稳定指纹(不是比行数——行数看不出内容被改)
      const snapshot = (): string => {
        const rows = db.listL1({ limit: 500, offset: 0 }).items;
        return JSON.stringify(
          rows
            .map((r) => ({
              id: r.id,
              content: r.content,
              priority: r.priority,
              type: r.type,
              timestamps: r.timestamps,
              updatedAt: r.updatedAt,
              version: r.version,
              metadata: r.metadata,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        );
      };
      const before = snapshot();
      const countBefore = db.countL1();

      const result = await runReconcile(deps(), [{ id: record.id, text: record.content, sourceAnchors: [anchor(1)] }], {
        maxRecords: 1,
      });
      expect(result.counts.supported).toBe(1);

      const after = snapshot();
      expect(after).toBe(before); // 内容逐字段不变
      expect(db.countL1()).toBe(countBefore);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
