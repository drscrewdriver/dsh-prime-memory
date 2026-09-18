/**
 * R7 锚点纯函数层单测(task_30/31 的坐标正确性核心)。
 *
 * 覆盖三类:
 * 1. fold 前的"无坐标"语义 —— 不得编造 step
 * 2. 归并去重与排序
 * 3. 读侧形状校验从严 —— 宁可报"无锚点",不喂半截坐标
 */
import { describe, expect, it } from 'vitest';
import {
  ANCHOR_METADATA_KEY,
  buildAnchorMap,
  readSourceAnchors,
  resolveSourceAnchors,
  withSourceAnchors,
} from '../src/pipeline/anchors.js';
import type { ConversationAnchor, ConversationMessage } from '../src/types.js';

function msg(id: string, anchor?: ConversationAnchor): ConversationMessage {
  const m: ConversationMessage = { id, role: 'user', content: 'x', timestamp: 0 };
  if (anchor !== undefined) m.anchor = anchor;
  return m;
}

describe('buildAnchorMap', () => {
  it('只收录带锚点的消息', () => {
    const map = buildAnchorMap([
      msg('a', { sessionId: 's1', turn: 1 }),
      msg('b'), // 无锚点(老数据/未打戳)
      msg('c', { sessionId: 's1', turn: 2, step: 3 }),
    ]);
    expect([...map.keys()].sort()).toEqual(['a', 'c']);
    expect(map.get('b')).toBeUndefined();
  });

  it('turn 非有限数的锚点不成立(红线:不推算坐标)', () => {
    const map = buildAnchorMap([msg('a', { sessionId: 's1', turn: Number.NaN })]);
    expect(map.size).toBe(0);
  });
});

describe('resolveSourceAnchors', () => {
  const anchors = buildAnchorMap([
    msg('m1', { sessionId: 's1', turn: 2 }),
    msg('m2', { sessionId: 's1', turn: 2, step: 1 }),
    msg('m3', { sessionId: 's1', turn: 1, step: 5 }),
    msg('m4', { sessionId: 's1', turn: 2, step: 1 }), // 与 m2 同坐标
  ]);

  it('去重后按 (turn, step) 升序:step 缺失排在同 turn 最前', () => {
    const out = resolveSourceAnchors(['m2', 'm1', 'm4', 'm3'], anchors);
    expect(out).toEqual([
      { sessionId: 's1', turn: 1, step: 5 },
      { sessionId: 's1', turn: 2 },
      { sessionId: 's1', turn: 2, step: 1 },
    ]);
  });

  it('映射不到的消息 id 直接丢弃,不猜测坐标', () => {
    expect(resolveSourceAnchors(['m1', 'ghost'], anchors)).toEqual([{ sessionId: 's1', turn: 2 }]);
  });

  it('全部映射不到 / 空输入 / undefined → undefined(不是空数组)', () => {
    expect(resolveSourceAnchors(['ghost'], anchors)).toBeUndefined();
    expect(resolveSourceAnchors([], anchors)).toBeUndefined();
    expect(resolveSourceAnchors(undefined, anchors)).toBeUndefined();
  });
});

describe('withSourceAnchors', () => {
  it('无锚点时不写键,metadata 逐字不变(零漂移)', () => {
    const base = { hall: 'work' };
    expect(withSourceAnchors(base, undefined)).toBe(base);
    expect(withSourceAnchors(base, [])).toBe(base);
    expect(withSourceAnchors(undefined, undefined)).toEqual({});
  });

  it('有锚点时返回新对象,不改入参(不可变更新)', () => {
    const base = { hall: 'work' };
    const out = withSourceAnchors(base, [{ sessionId: 's1', turn: 1 }]);
    expect(out).toEqual({ hall: 'work', [ANCHOR_METADATA_KEY]: [{ sessionId: 's1', turn: 1 }] });
    expect(base).toEqual({ hall: 'work' });
    expect(ANCHOR_METADATA_KEY in base).toBe(false);
  });
});

describe('readSourceAnchors', () => {
  it('roundtrip:写入后读回一致', () => {
    const anchors: ConversationAnchor[] = [
      { sessionId: 's1', turn: 3 },
      { sessionId: 's1', turn: 3, step: 2 },
    ];
    expect(readSourceAnchors(withSourceAnchors({}, anchors))).toEqual(anchors);
  });

  it('形状校验从严:缺 turn / 类型不对的项被丢弃', () => {
    const meta = {
      [ANCHOR_METADATA_KEY]: [
        { sessionId: 's1', turn: 1 },
        { sessionId: 's1' }, // 缺 turn
        { sessionId: 42, turn: 1 }, // sessionId 类型错
        { sessionId: 's1', turn: Number.NaN },
        'not-an-object',
        null,
      ],
    };
    expect(readSourceAnchors(meta)).toEqual([{ sessionId: 's1', turn: 1 }]);
  });

  it('全丢 → undefined;非对象入参 → undefined', () => {
    expect(readSourceAnchors({ [ANCHOR_METADATA_KEY]: [{ turn: 1 }] })).toBeUndefined();
    expect(readSourceAnchors({})).toBeUndefined();
    expect(readSourceAnchors(undefined)).toBeUndefined();
    expect(readSourceAnchors('str')).toBeUndefined();
    expect(readSourceAnchors({ [ANCHOR_METADATA_KEY]: 'not-array' })).toBeUndefined();
  });

  it('step 非有限数不写入(不把 NaN 当坐标)', () => {
    const meta = { [ANCHOR_METADATA_KEY]: [{ sessionId: 's1', turn: 1, step: Number.NaN }] };
    expect(readSourceAnchors(meta)).toEqual([{ sessionId: 's1', turn: 1 }]);
  });
});
