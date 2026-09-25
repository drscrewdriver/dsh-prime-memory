/**
 * 维度提交的不变量：**无论成败，「正在编辑」标记都必须复位**。
 *
 * ## 这个测试防的是什么
 *
 * 原实现在校验失败时直接 `return`，跳过了复位。而轮询回填受该标记门控
 * （`EmbeddingSection` 的 useEffect）：
 *
 * ```
 * if (!remoteDirty.current.dims) setRDims(...)
 * ```
 *
 * ⇒ 用户输入一个非法值后，输入框**永久停在那个非法值上**、红字不消、
 * 也不再跟随生效值刷新，只能手动清空才能恢复。端点与模型两个字段没有这个问题，
 * 因为它们都在防抖回调里**无条件**复位。
 *
 * ## 为什么断言调用而不是断言顺序
 *
 * `commitDimensions` 是纯函数、副作用全靠注入，所以「复位被调用了几次、
 * 在什么条件下被调用」可以直接观察。**顺序**（复位早于任何提前返回）无法从外部
 * 区分，故改为断言「失败路径下 clearDirty 仍然被调用」——这正是原实现违反的那条。
 */
import { describe, expect, it } from 'vitest';
import { DIMS_MAX, DIMS_MIN, commitDimensions, dimsRangeMessage } from '../client/src/dimensions.js';

interface Recorded {
  cleared: number;
  submitted: number[];
  rejected: string[];
}

function run(raw: string): Recorded {
  const rec: Recorded = { cleared: 0, submitted: [], rejected: [] };
  commitDimensions(raw, {
    clearDirty: () => {
      rec.cleared++;
    },
    submit: (n) => {
      rec.submitted.push(n);
    },
    reject: (m) => {
      rec.rejected.push(m);
    },
  });
  return rec;
}

describe('commitDimensions：区间与取值语义', () => {
  it('留空 → 提交 0（跟随部署配置）', () => {
    const r = run('');
    expect(r.submitted).toEqual([0]);
    expect(r.rejected).toEqual([]);
  });

  it('纯空白等同留空（不能把空格当成"用户输了个东西"）', () => {
    expect(run('   ').submitted).toEqual([0]);
  });

  it('合法正整数原样提交', () => {
    expect(run('768').submitted).toEqual([768]);
    expect(run(` ${DIMS_MIN} `).submitted).toEqual([DIMS_MIN]);
    expect(run(String(DIMS_MAX)).submitted).toEqual([DIMS_MAX]);
  });

  it('边界外与非法形态一律拒绝，且不提交', () => {
    for (const bad of ['0', '-1', '1.5', '100001', 'abc', 'Infinity', 'NaN']) {
      const r = run(bad);
      expect(r.submitted, `"${bad}" 不该被提交`).toEqual([]);
      expect(r.rejected, `"${bad}" 应当被拒绝`).toEqual([dimsRangeMessage()]);
    }
  });

  it('指数/十六进制写法被 Number() 接受并归一（**既有行为，刻意保留**）', () => {
    // HTML <input type="number"> 允许指数写法；`Number()` 也认十六进制。
    // 本次修复针对的是"失败路径不复位"，不夹带取值规则的收紧，故在此把
    // 实际语义钉住 —— 免得下次被当成 bug 又被"修"一遍。
    expect(run('7e3').submitted).toEqual([7000]);
    expect(run('0x10').submitted).toEqual([16]);
  });

  it('拒绝文案与宿主侧区间一致（1~100000）', () => {
    expect(dimsRangeMessage()).toContain('1~100000');
  });
});

describe('commitDimensions：复位不变量（本测试存在的理由）', () => {
  it('成功路径复位一次', () => {
    expect(run('768').cleared).toBe(1);
    expect(run('').cleared).toBe(1);
  });

  it('**失败路径也必须复位** —— 漏掉即输入框卡死在非法值上', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '100001']) {
      const r = run(bad);
      expect(r.cleared, `"${bad}" 被拒后必须复位编辑标记，否则轮询回填被永久门控`).toBe(1);
    }
  });

  it('每次调用恰复位一次（不多不少 —— 多调会打断用户正在进行的编辑）', () => {
    for (const raw of ['', '768', 'abc']) {
      expect(run(raw).cleared, `"${raw}"`).toBe(1);
    }
  });
});
