/**
 * 成本闸门与断点续跑单测(task_9)。
 *
 * 三条不可退让的要求,各占一组:
 * 1. **预估必须先出**,且**裁掉了什么必须写清**(只报"要跑多少"会让人以为跑全了)
 * 2. **可中断**:中断后已完成的不丢
 * 3. **不重复计费**:续跑跳过已完成条目 —— 且键必须带**内容哈希**
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RECONCILE_BUDGET,
  contentHash,
  executeReconcile,
  loadRunState,
  makeReconcileDeps,
  planReconcile,
  reconcileStatePathFor,
  renderEstimate,
  resetRunState,
  resumeKey,
  type ReconcileBudget,
} from '../src/pipeline/reconcile-run.js';
import type { EvidenceEvent, EvidenceSource } from '../src/store/evidence-source.js';
import type { ConversationAnchor } from '../src/types.js';
import type { ReconcileInput } from '../src/pipeline/reconcile.js';

const EVIDENCE_TEXT = '这次改用 zstd 多帧解码,因为单帧只解出前 192 字节。';

function anchor(turn: number, step?: number): ConversationAnchor {
  const a: ConversationAnchor = { sessionId: 'session-x', turn };
  if (step !== undefined) a.step = step;
  return a;
}

function eventsFixture(): EvidenceEvent[] {
  return [
    { seq: 1, turn: 1, step: 1, type: 'user/message', text: '解码为什么只出 192 字节?' },
    { seq: 2, turn: 1, step: 1, type: 'assistant/message', text: EVIDENCE_TEXT },
  ];
}

function memory(id: string, anchorCount = 1, text = `记忆 ${id}`): ReconcileInput {
  return {
    id,
    text,
    sourceAnchors: Array.from({ length: anchorCount }, (_v, i) => anchor(i + 1)),
  };
}

function depsOf(judgeOverride?: () => Promise<string>) {
  const evidence: EvidenceSource = {
    byAnchors: async () => ({
      ok: true,
      slice: { sessionId: 'session-x', anchors: [anchor(1)], events: eventsFixture(), truncated: false },
    }),
  };
  const judge = vi.fn(
    judgeOverride ??
      (async () => JSON.stringify({ state: 'supported', reason: 'ok', quote: '单帧只解出前 192 字节' })),
  );
  return { deps: makeReconcileDeps(evidence, judge), judge };
}

const budget = (over: Partial<ReconcileBudget> = {}): ReconcileBudget => ({ ...DEFAULT_RECONCILE_BUDGET, ...over });

describe('planReconcile —— 预估与裁剪', () => {
  it('区分计费条数与免费条数(无锚点不花钱)', () => {
    const plan = planReconcile([memory('a'), { id: 'b', text: '无锚点', sourceAnchors: [] }], budget());
    expect(plan.estimate).toMatchObject({ total: 2, billable: 1, skippedNoAnchor: 1, estCalls: 1 });
  });

  it('条数上限生效,且**裁掉多少必须报出来**', () => {
    const plan = planReconcile([memory('a'), memory('b'), memory('c')], budget({ maxRecords: 2 }));
    expect(plan.memories).toHaveLength(2);
    expect(plan.estimate.trimmedByRecords).toBe(1);
    expect(plan.summary).toContain('裁掉');
    expect(plan.summary).toContain('本次不会核对');
  });

  it('调用数上限生效,无锚点条目不吃调用预算', () => {
    const plan = planReconcile(
      [memory('a'), { id: 'free', text: '无锚点', sourceAnchors: [] }, memory('b')],
      budget({ maxCalls: 1 }),
    );
    expect(plan.estimate.estCalls).toBe(1);
    expect(plan.estimate.trimmedByCalls).toBe(1);
    expect(plan.memories.map((m) => m.id)).toContain('free');
  });

  it('单条锚点数被裁剪到上限', () => {
    const plan = planReconcile([memory('a', 5)], budget({ maxAnchorsPerMemory: 2 }));
    expect(plan.memories[0].sourceAnchors).toHaveLength(2);
    expect(plan.estimate.anchors).toBe(2);
  });

  it('预估给出字符与 token 上界,且沿用既有密度口径', () => {
    const plan = planReconcile([memory('a')], budget({ maxEvidenceChars: 400 }));
    // 记忆正文 '记忆 a'(4 字符) + 证据上限 400
    expect(plan.estimate.estInputChars).toBe(404);
    expect(plan.estimate.estInputTokens).toBe(Math.ceil(404 / 4));
  });

  it('已完成条目计入 alreadyDone,不进本次计划', () => {
    const m = memory('a');
    const plan = planReconcile([m], budget(), [resumeKey(m)]);
    expect(plan.estimate.alreadyDone).toBe(1);
    expect(plan.estimate.estCalls).toBe(0);
    expect(plan.memories).toHaveLength(0);
  });

  it('预估说明包含四项关键数字', () => {
    const text = renderEstimate(planReconcile([memory('a')], budget()).estimate, budget());
    expect(text).toContain('候选记忆');
    expect(text).toContain('模型调用');
    expect(text).toContain('token');
    expect(text).toContain('锚点合计');
  });
});

describe('续跑键 —— 内容一变就必须重核', () => {
  it('同一 id 同一内容 → 同键', () => {
    expect(resumeKey(memory('a'))).toBe(resumeKey(memory('a')));
  });

  it('同一 id **改了正文** → 不同键(否则会留一条对旧正文的判定)', () => {
    const before = memory('a', 1, '旧正文');
    const after = memory('a', 1, '新正文');
    expect(resumeKey(before)).not.toBe(resumeKey(after));
  });

  it('哈希固定 8 位', () => {
    expect(contentHash('任意文本')).toHaveLength(8);
  });
});

describe('executeReconcile —— 中断与续跑', () => {
  it('正常跑完:逐条判定并落盘状态', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-recon-run-'));
    try {
      const file = reconcileStatePathFor(dir);
      const { deps } = depsOf();
      const plan = planReconcile([memory('a'), memory('b')], budget());
      const result = await executeReconcile(deps, plan, { stateFile: file });
      expect(result.counts.supported).toBe(2);
      expect(result.interrupted).toBe(false);
      const state = await loadRunState(file);
      expect(state?.done).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('中断后已完成的不丢,且续跑**不重复调用模型**', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-recon-run-'));
    try {
      const file = reconcileStatePathFor(dir);
      const controller = new AbortController();
      const { deps, judge } = depsOf(async () => {
        controller.abort(); // 第一条做完就中断
        return JSON.stringify({ state: 'supported', reason: 'ok', quote: '单帧只解出前 192 字节' });
      });
      const memories = [memory('a'), memory('b'), memory('c')];
      const first = await executeReconcile(deps, planReconcile(memories, budget()), {
        stateFile: file,
        signal: controller.signal,
      });
      expect(first.interrupted).toBe(true);
      expect(first.verdicts).toHaveLength(1);
      expect(judge).toHaveBeenCalledTimes(1);

      // 续跑:第一条已在状态里,只跑剩下两条
      const { deps: deps2, judge: judge2 } = depsOf();
      const second = await executeReconcile(deps2, planReconcile(memories, budget()), { stateFile: file });
      expect(second.verdicts).toHaveLength(2);
      expect(judge2).toHaveBeenCalledTimes(2); // a 没有重跑
      const state = await loadRunState(file);
      expect(state?.done).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('续跑时正文改过的条目**会**重核(不被跳过)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-recon-run-'));
    try {
      const file = reconcileStatePathFor(dir);
      const { deps } = depsOf();
      await executeReconcile(deps, planReconcile([memory('a', 1, '旧正文')], budget()), { stateFile: file });

      const { deps: deps2, judge: judge2 } = depsOf();
      const plan = planReconcile([memory('a', 1, '新正文')], budget(), (await loadRunState(file))?.done ?? []);
      expect(plan.estimate.estCalls).toBe(1); // 重新计费 —— 这是正确的
      await executeReconcile(deps2, plan, { stateFile: file });
      expect(judge2).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('无锚点条目零调用(不花钱)', async () => {
    const { deps, judge } = depsOf();
    const plan = planReconcile([{ id: 'x', text: '无锚点', sourceAnchors: [] }], budget());
    const result = await executeReconcile(deps, plan);
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0].skipped).toBe('no-anchor');
    expect(judge).not.toHaveBeenCalled();
  });

  it('不传 stateFile 时纯内存运行,不落盘', async () => {
    const { deps } = depsOf();
    const result = await executeReconcile(deps, planReconcile([memory('a')], budget()));
    expect(result.state).toBeUndefined();
  });

  it('报告带预估说明在前(不能只报判定结果)', async () => {
    const { deps } = depsOf();
    const result = await executeReconcile(deps, planReconcile([memory('a')], budget()));
    expect(result.report.indexOf('核对预估')).toBeLessThan(result.report.indexOf('# 记忆核对报告'));
  });

  it('resetRunState 后下次会重跑(显式动作,会重复计费)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-recon-run-'));
    try {
      const file = reconcileStatePathFor(dir);
      const { deps } = depsOf();
      await executeReconcile(deps, planReconcile([memory('a')], budget()), { stateFile: file });
      await resetRunState(file);
      const state = await loadRunState(file);
      expect(state?.done).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('状态文件损坏时按空状态处理,不阻止运行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-recon-run-'));
    try {
      const { writeFile } = await import('node:fs/promises');
      const file = reconcileStatePathFor(dir);
      await writeFile(file, '{ 这不是 JSON', 'utf8');
      await expect(loadRunState(file)).resolves.toBeUndefined();
      const { deps } = depsOf();
      const result = await executeReconcile(deps, planReconcile([memory('a')], budget()), { stateFile: file });
      expect(result.verdicts).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('状态路径与既有 pending/state 同目录约定', () => {
    expect(reconcileStatePathFor('C:\\data\\mem')).toBe('C:\\data\\mem/reconcile-state.json');
    expect(reconcileStatePathFor('C:\\data\\mem\\')).toBe('C:\\data\\mem/reconcile-state.json');
  });
});
