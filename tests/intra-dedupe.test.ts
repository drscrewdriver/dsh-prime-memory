/**
 * L1 批内自去重（intra-dedupe）单测。
 *
 * 覆盖：归一化（全半角/空白/零宽）、精确合并的字段并集与代表项规则、空内容不合并、
 * 向量层的 tau 生效与**跨族/跨类不合并**、缺向量直通、余弦退化情形。
 * 全部为纯函数用例，零模型、零 IO。
 */
import { describe, expect, it } from 'vitest';
import {
  clusterByVector,
  clusterExact,
  cosineMaybe,
  normalizeForDedupe,
  preDedupeBatch,
  type DedupeShaped,
} from '../src/pipeline/intra-dedupe.js';

function item(over: Partial<DedupeShaped> & { record_id: string; content: string }): DedupeShaped & { metadata?: unknown } {
  return { priority: 50, family: 'chat', type: 'preference', ...over };
}

/** 二维单位向量：与 (1,0) 夹角 θ 的余弦 = c。 */
function atCosine(c: number): Float32Array {
  return new Float32Array([c, Math.sqrt(1 - c * c)]);
}
const X = new Float32Array([1, 0]);

describe('normalizeForDedupe', () => {
  it('全半角、空白、零宽差异被折叠为同一串', () => {
    const a = '用户喜欢  手冲咖啡'; // 双空格
    const b = '用户\u200b喜欢\u3000手冲咖啡'; // 零宽 + 全角空格
    const c = '　用户喜欢　手冲咖啡　'; // 首尾与中间全角空格
    expect(normalizeForDedupe(a)).toBe(normalizeForDedupe(b));
    expect(normalizeForDedupe(a)).toBe(normalizeForDedupe(c));
    // NFKC：全角字母/数字折半角
    expect(normalizeForDedupe('ＡＢＣ１２３')).toBe('ABC123');
  });
});

describe('clusterExact', () => {
  it('归一化后同内容合并，代表项取最长正文并并集化可变字段', () => {
    // 两条归一后相同；a 的原文字面更长（多空格）→ 代表项应为 a
    const contentA = '用户在杭州工作   每周末骑行';
    const contentB = '用户在杭州工作 每周末骑行';
    const items = [
      item({ record_id: 'a', content: contentA, priority: 60, timestamps: [3, 1], source_message_ids: ['m1'] }),
      item({ record_id: 'b', content: contentB, priority: 80, timestamps: [2], source_message_ids: ['m2', 'm1'] }),
      item({ record_id: 'c', content: '另一条完全不同的记忆内容', priority: 70 }),
    ];
    const out = clusterExact(items);
    expect(out.effective.map((e) => e.record_id)).toEqual(['a', 'c']);
    const rep = out.effective[0];
    expect(rep.content).toBe(contentA); // 代表项正文原样（字面更长的那条）
    expect(rep.priority).toBe(80); // 取最大
    expect(rep.timestamps).toEqual([1, 2, 3]); // 并集 + 排序
    expect(rep.source_message_ids).toEqual(['m1', 'm2']); // 并集去重
    expect(out.absorbed).toEqual([{ representative: 'a', absorbed: ['b'] }]);
    expect(out.absorbedBy).toEqual({ b: 'a' });
  });

  it('空内容不参与合并（各自成簇），避免静默吞掉上游缺陷', () => {
    const items = [item({ record_id: 'e1', content: '' }), item({ record_id: 'e2', content: '   ' })];
    const out = clusterExact(items);
    expect(out.effective.map((e) => e.record_id)).toEqual(['e1', 'e2']);
    expect(out.absorbed).toEqual([]);
  });

  it('等长正文时按 priority 择优，再等则保留先出现者', () => {
    const items = [
      item({ record_id: 'p1', content: 'AAAA', priority: 10 }),
      item({ record_id: 'p2', content: 'AAAA', priority: 90 }),
      item({ record_id: 'p3', content: 'AAAA', priority: 90 }),
    ];
    const out = clusterExact(items);
    expect(out.effective.map((e) => e.record_id)).toEqual(['p2']);
    expect(out.absorbedBy).toEqual({ p1: 'p2', p3: 'p2' });
  });
});

describe('clusterByVector', () => {
  it('余弦 ≥ tau 合并且代表项保留原正文；< tau 不合并', () => {
    const items = [
      item({ record_id: 'v1', content: '同一事实的第一种说法' }),
      item({ record_id: 'v2', content: '同一事实的第二种说法' }),
      item({ record_id: 'v3', content: '完全不相干的另一件事' }),
    ];
    const vecs = [X, atCosine(0.92), new Float32Array([0, 1])];
    const merged = clusterByVector(items, vecs, 0.9);
    expect(merged.effective.map((e) => e.record_id)).toEqual(['v1', 'v3']);
    expect(merged.absorbedBy).toEqual({ v2: 'v1' });

    const strict = clusterByVector(items, vecs, 0.95);
    expect(strict.effective.map((e) => e.record_id)).toEqual(['v1', 'v2', 'v3']);
    expect(strict.absorbed).toEqual([]);
  });

  it('跨 family 不合并（同向量也不行）', () => {
    const items = [
      item({ record_id: 'f1', content: 'a', family: 'chat' }),
      item({ record_id: 'f2', content: 'b', family: 'work' }),
    ];
    const out = clusterByVector(items, [X, X], 0.9);
    expect(out.effective.map((e) => e.record_id)).toEqual(['f1', 'f2']);
  });

  it('跨 type 不合并（同族同向量也不行）', () => {
    const items = [
      item({ record_id: 't1', content: 'a', type: 'preference' }),
      item({ record_id: 't2', content: 'b', type: 'work_fact' }),
    ];
    const out = clusterByVector(items, [X, X], 0.9);
    expect(out.effective.map((e) => e.record_id)).toEqual(['t1', 't2']);
  });

  it('缺向量/长度不等/零向量 → 不可比，直通不合并', () => {
    const items = [
      item({ record_id: 'n1', content: 'a' }),
      item({ record_id: 'n2', content: 'b' }),
      item({ record_id: 'n3', content: 'c' }),
      item({ record_id: 'n4', content: 'd' }),
    ];
    const out = clusterByVector(items, [undefined, X, new Float32Array([0, 0]), new Float32Array([1, 0, 0])], 0.5);
    expect(out.effective.map((e) => e.record_id)).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('tau 越界被夹到安全区间（不因配置手误变成“全合并”或“永不合并”）', () => {
    const items = [item({ record_id: 'g1', content: 'a' }), item({ record_id: 'g2', content: 'b' })];
    // tau=1.5 → 夹到 0.9999：cos=0.999 不达阈 → 不合并
    const near = [X, atCosine(0.999)];
    expect(clusterByVector(items, near, 1.5).effective.length).toBe(2);
    // tau=0 → 夹到 0.5：cos=0.6 → 合并
    const mid = [X, atCosine(0.6)];
    expect(clusterByVector(items, mid, 0).effective.length).toBe(1);
  });
});

describe('cosineMaybe', () => {
  it('同向量为 1，正交为 0，退化输入返回 undefined', () => {
    expect(cosineMaybe(X, X)).toBeCloseTo(1, 6);
    expect(cosineMaybe(X, new Float32Array([0, 1]))).toBeCloseTo(0, 6);
    expect(cosineMaybe(undefined, X)).toBeUndefined();
    expect(cosineMaybe(X, new Float32Array([1, 0, 0]))).toBeUndefined();
    expect(cosineMaybe(X, new Float32Array([0, 0]))).toBeUndefined();
  });
});

describe('preDedupeBatch（接线层：可注入 embedMany）', () => {
  /** 假嵌入：按关键词给向量，同主题 → 余弦 1。 */
  const embedByTopic = async (texts: string[]) =>
    texts.map((t) => (t.includes('咖啡') ? X : t.includes('猫') ? new Float32Array([0, 1]) : atCosine(0.2)));

  it('关闭时原样透传（行为与改动前一致，且不调 embedMany）', async () => {
    let called = 0;
    const items = [item({ record_id: 'a', content: '同一句' }), item({ record_id: 'b', content: '同一句' })];
    const out = await preDedupeBatch(items, async (t) => {
      called++;
      return t.map(() => X);
    }, { enabled: false });
    expect(called).toBe(0);
    expect(out.effective.map((e) => e.record_id)).toEqual(['a', 'b']);
    expect(out.raw).toBe(2);
    expect(out.exact).toBe(2);
    expect(out.vector).toBe(2);
    expect(out.absorbedBy).toEqual({});
    expect(out.vectors.size).toBe(0);
  });

  it('开启时精确层 + 向量层两级收拢，向量表只含代表项', async () => {
    const items = [
      item({ record_id: 'r1', content: '用户喜欢  手冲咖啡' }),
      item({ record_id: 'r2', content: '用户喜欢 手冲咖啡' }), // 单空格，空白折叠后同
      item({ record_id: 'r3', content: '用户喜欢手冲咖啡呀' }), // 不同串但同主题 → 向量层合并
      item({ record_id: 'r4', content: '用户养了一只猫' }),
    ];
    const out = await preDedupeBatch(items, embedByTopic, { tau: 0.9 });
    expect(out.raw).toBe(4);
    expect(out.exact).toBe(3); // r2 被 r1 吸收
    expect(out.vector).toBe(2); // r3 被 r1 吸收
    expect(out.effective.map((e) => e.record_id)).toEqual(['r1', 'r4']);
    expect(out.absorbedBy).toEqual({ r2: 'r1', r3: 'r1' });
    expect([...out.vectors.keys()].sort()).toEqual(['r1', 'r4']);
  });

  it('嵌入失败 → 降级只做精确层，并留 warn（不抛）', async () => {
    const warns: string[] = [];
    const items = [
      item({ record_id: 'x1', content: '同一句' }),
      item({ record_id: 'x2', content: '同一句' }),
      item({ record_id: 'x3', content: '完全不同的另一句记忆' }),
    ];
    const out = await preDedupeBatch(items, async () => {
      throw new Error('embedding down');
    }, { onWarn: (m) => warns.push(m) });
    expect(out.effective.length).toBe(2); // 仅精确层生效
    expect(out.absorbedBy).toEqual({ x2: 'x1' });
    expect(out.vectors.size).toBe(0);
    expect(warns.join(' ')).toContain('仅做精确层');
  });

  it('tau 越界 clamp + warn（配置手误不变成“全合并/永不合并”）', async () => {
    const warns: string[] = [];
    const items = [item({ record_id: 'z1', content: 'a' }), item({ record_id: 'z2', content: 'b' })];
    await preDedupeBatch(items, embedByTopic, { tau: 5, onWarn: (m) => warns.push(m) });
    expect(warns.join(' ')).toContain('0.85–0.99');
  });
});
