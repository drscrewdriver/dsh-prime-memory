/**
 * 证据读取器单测(task_7 / R1)。
 *
 * 重点不在"能取回文本",而在**失败必须可分类**——task_8b 要求「找不到」能区分
 * "确实没谈过"与"读不到",因为后者一旦被当成前者,21.7% 的归档会话会被系统性
 * 误判。故本文件里失败路径的用例数与成功路径相当。
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import {
  anchorMatches,
  createEvidenceSource,
  foldEventAnchors,
  projectEventText,
  sessionIdCandidates,
  type SessionQueryLike,
} from '../src/store/evidence-source.js';
import type { ConversationAnchor } from '../src/types.js';

function ev(seq: number, type: string, data: unknown, time?: number): SessionEvent {
  return { seq, type, data, time } as unknown as SessionEvent;
}

/** 一个最小会话:turn 1 两个 step、turn 2 一个 step,含工具结果。 */
function sampleEvents(): SessionEvent[] {
  return [
    ev(0, 'turn/start', { turn: 1 }, 1000),
    ev(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮的问题' }] }, 1001),
    ev(2, 'step/start', { turn: 1, step: 1 }),
    ev(3, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '第一轮回答' }] } }, 1002),
    ev(4, 'step/start', { turn: 1, step: 2 }),
    ev(5, 'tool/result', { turn: 1, step: 2, content: [{ type: 'text', text: '工具输出' }] }, 1003),
    ev(6, 'turn/end', { turn: 1 }),
    ev(7, 'turn/start', { turn: 2 }, 2000),
    ev(8, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮的问题' }] }, 2001),
    ev(9, 'step/start', { turn: 2, step: 1 }),
    ev(10, 'assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: '第二轮回答' }] } }, 2002),
  ];
}

function anchor(turn: number, step?: number): ConversationAnchor {
  const a: ConversationAnchor = { sessionId: 'session-x', turn };
  if (step !== undefined) a.step = step;
  return a;
}

function queryOf(events: readonly SessionEvent[], id = 'session-x'): SessionQueryLike {
  return { listEvents: async () => events, readSession: async () => ({ session: { id }, events }) };
}

describe('sessionIdCandidates —— 两种 id 形态都要试', () => {
  it('纯 uuid 同时给出前缀形态', () => {
    expect(sessionIdCandidates('abc-123')).toEqual(['abc-123', 'session-abc-123']);
  });

  it('带前缀的 id 同时给出裸形态', () => {
    expect(sessionIdCandidates('session-abc-123')).toEqual(['session-abc-123', 'abc-123']);
  });

  it('原值永远排首位,且不重复', () => {
    expect(sessionIdCandidates('session-session-abc')[0]).toBe('session-session-abc');
    expect(new Set(sessionIdCandidates('x')).size).toBe(sessionIdCandidates('x').length);
  });

  it('空白输入返回空列表(不编 id)', () => {
    expect(sessionIdCandidates('   ')).toEqual([]);
  });
});

describe('foldEventAnchors —— 与捕获侧同一条 fold 规则', () => {
  it('turn/start 推进 turn 并清空 step', () => {
    const folded = foldEventAnchors(sampleEvents());
    expect(folded.get(1)).toMatchObject({ turn: 1 }); // 轮首、step 未开始
    expect(folded.get(1)?.step).toBeUndefined();
    expect(folded.get(3)).toMatchObject({ turn: 1, step: 1 });
    expect(folded.get(5)).toMatchObject({ turn: 1, step: 2 });
    expect(folded.get(10)).toMatchObject({ turn: 2, step: 1 });
  });

  it('边界事件之前的事件坐标留空,不拿上一轮顶替', () => {
    const events = [ev(0, 'user/message', { source: { kind: 'user' }, content: [] }), ev(1, 'turn/start', { turn: 5 })];
    const folded = foldEventAnchors(events);
    expect(folded.has(0)).toBe(false);
    expect(folded.get(1)).toMatchObject({ turn: 5 });
  });

  it('事件自带坐标优先于 fold 值', () => {
    const events = [ev(0, 'turn/start', { turn: 1 }), ev(1, 'assistant/message', { turn: 9, step: 3, message: { content: [] } })];
    expect(foldEventAnchors(events).get(1)).toMatchObject({ turn: 9, step: 3 });
  });
});

describe('anchorMatches —— step 缺失的锚点整轮皆命中', () => {
  it('无 step 的锚点命中该轮任意 step', () => {
    expect(anchorMatches(anchor(1), anchor(1, 2))).toBe(true);
  });

  it('带 step 的锚点只命中该 step', () => {
    expect(anchorMatches(anchor(1, 1), anchor(1, 2))).toBe(false);
    expect(anchorMatches(anchor(1, 1), anchor(1, 1))).toBe(true);
  });

  it('轮次不同一律不命中', () => {
    expect(anchorMatches(anchor(1, 1), anchor(2, 1))).toBe(false);
  });
});

describe('projectEventText —— 忠实投影,但注入上下文不算证据', () => {
  it('真实用户消息产出文本', () => {
    expect(projectEventText(ev(0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }))).toBe('hi');
  });

  it('插件注入的上下文不当证据(source.kind !== user)', () => {
    expect(projectEventText(ev(0, 'user/message', { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'ctx' }] }))).toBe('');
  });

  it('助手消息产出文本', () => {
    expect(projectEventText(ev(0, 'assistant/message', { message: { content: [{ type: 'text', text: 'yo' }] } }))).toBe('yo');
  });

  it('工具结果宽容读取:形状不符时给空串而不是抛错', () => {
    expect(projectEventText(ev(0, 'tool/result', { content: [{ type: 'text', text: 'out' }] }))).toBe('out');
    expect(projectEventText(ev(0, 'tool/result', {}))).toBe('');
  });

  it('未知事件类型投影为空串(不猜形状)', () => {
    expect(projectEventText(ev(0, 'whatever/unknown', { text: 'x' }))).toBe('');
  });
});

describe('createEvidenceSource —— 成功路径', () => {
  it('按锚点取回对应事件,并回显命中的 id 形态', async () => {
    const source = createEvidenceSource(queryOf(sampleEvents()));
    const result = await source.byAnchors({ sessionId: 'session-x', anchors: [anchor(1, 1)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slice.sessionId).toBe('session-x');
    expect(result.slice.events.map((e) => e.text)).toContain('第一轮回答');
    expect(result.slice.truncated).toBe(false);
  });

  it('无 step 的锚点取回整轮(含轮首消息)', async () => {
    const source = createEvidenceSource(queryOf(sampleEvents()));
    const result = await source.byAnchors({ sessionId: 'session-x', anchors: [anchor(1)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const texts = result.slice.events.map((e) => e.text);
    expect(texts).toContain('第一轮的问题');
    expect(texts).toContain('第一轮回答');
    expect(texts).toContain('工具输出');
    expect(texts).not.toContain('第二轮回答');
  });

  it('边界事件不进证据(零文本条目不得占配额)', async () => {
    const source = createEvidenceSource(queryOf(sampleEvents()));
    const result = await source.byAnchors({ sessionId: 'session-x', anchors: [anchor(1)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const types = result.slice.events.map((e) => e.type);
    expect(types).not.toContain('turn/start');
    expect(types).not.toContain('step/start');
    expect(types).not.toContain('turn/end');
    expect(types.every((t) => t === 'user/message' || t === 'assistant/message' || t === 'tool/result')).toBe(true);
  });

  it('插件注入的上下文不进证据(只认 source.kind === user)', async () => {
    const events = [
      ev(0, 'turn/start', { turn: 1 }),
      ev(1, 'user/message', { source: { kind: 'plugin' }, content: [{ type: 'text', text: '注入的上下文' }] }),
      ev(2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '真实发言' }] }),
    ];
    const source = createEvidenceSource(queryOf(events));
    const result = await source.byAnchors({ sessionId: 'session-x', anchors: [anchor(1)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const texts = result.slice.events.map((e) => e.text);
    expect(texts).toEqual(['真实发言']);
  });

  it('只认前缀形态的服务也能命中裸 uuid 请求(归一化生效)', async () => {    const source = createEvidenceSource({
      listEvents: async (id) => (id === 'session-abc' ? sampleEvents() : []),
    });
    const result = await source.byAnchors({ sessionId: 'abc', anchors: [anchor(2, 1)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slice.sessionId).toBe('session-abc');
  });

  it('超长证据按 maxChars 裁剪并显式标 truncated', async () => {
    const source = createEvidenceSource(queryOf(sampleEvents()));
    const result = await source.byAnchors({ sessionId: 'session-x', anchors: [anchor(1)], maxChars: 6 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slice.truncated).toBe(true);
    expect(result.slice.events.length).toBeLessThan(3);
  });

  it('超过 maxEvents 也标 truncated', async () => {
    const source = createEvidenceSource(queryOf(sampleEvents()));
    const result = await source.byAnchors({ sessionId: 'session-x', anchors: [anchor(1)], maxEvents: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slice.events).toHaveLength(1);
    expect(result.slice.truncated).toBe(true);
  });
});

describe('createEvidenceSource —— 失败必须可分类(不得一律"没谈过")', () => {
  it('无锚点 → no-anchor(老记忆需要先定位候选)', async () => {
    const source = createEvidenceSource(queryOf(sampleEvents()));
    const result = await source.byAnchors({ sessionId: 'session-x', anchors: [] });
    expect(result).toMatchObject({ ok: false, reason: 'no-anchor' });
  });

  it('内核未挂 sessionQuery → no-service(能力缺失,不处置记忆)', async () => {
    const source = createEvidenceSource(undefined);
    const result = await source.byAnchors({ sessionId: 'session-x', anchors: [anchor(1)] });
    expect(result).toMatchObject({ ok: false, reason: 'no-service' });
  });

  it('会话读不到 → session-unreadable(日志已删,第③类)', async () => {
    const source = createEvidenceSource({ listEvents: async () => [], readSession: async () => ({ session: {}, events: [] }) });
    const result = await source.byAnchors({ sessionId: 'gone', anchors: [anchor(1)] });
    expect(result).toMatchObject({ ok: false, reason: 'session-unreadable' });
    if (result.ok) return;
    expect(result.detail).toContain('session-gone'); // 两种形态都试过
  });

  it('会话在但没有该轮 → anchor-not-found(与整个读不到分开)', async () => {
    const source = createEvidenceSource(queryOf(sampleEvents()));
    const result = await source.byAnchors({ sessionId: 'session-x', anchors: [anchor(99)] });
    expect(result).toMatchObject({ ok: false, reason: 'anchor-not-found' });
  });

  it('读取抛错 → error,不向上抛', async () => {
    const source = createEvidenceSource({
      listEvents: async () => {
        throw new Error('boom');
      },
      readSession: async () => {
        throw new Error('boom');
      },
    });
    const result = await source.byAnchors({ sessionId: 'x', anchors: [anchor(1)] });
    // 两种形态都读不到 ⇒ 归为会话不可读;关键是**没有异常逃逸**
    expect(result.ok).toBe(false);
  });

  it('读取挂起 → timeout,不悬挂调用方', async () => {
    vi.useFakeTimers();
    try {
      const hanging: SessionQueryLike = {
        listEvents: () => new Promise<never>(() => {}),
        readSession: () => new Promise<never>(() => {}),
      };
      const source = createEvidenceSource(hanging);
      const pending = source.byAnchors({ sessionId: 'x', anchors: [anchor(1)], timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('取证失败时绝不退回 docs.text —— 只用内核事件,失败即失败', async () => {
    const source = createEvidenceSource(undefined);
    const result = await source.byAnchors({ sessionId: 'session-x', anchors: [anchor(1)] });
    expect(result.ok).toBe(false);
    // 断言面:失败结果里没有任何"文本"字段可被误当作原文
    expect(result).not.toHaveProperty('slice');
  });
});
