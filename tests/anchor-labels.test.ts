/**
 * R7 锚点 → UI 契约标签的映射单测。
 *
 * 背景:`UiRecord.sourceAnchors` 的契约是**字符串数组**(`t12 s3`),但读侧从未
 * 完成这次迁移——`stats.ts` 一直在填已废弃的 `sourceMessageIds`(`l1_records`
 * 从不存该列,恒为 `[]`),于是 `sourceAnchors` 永远缺失,UI 的来源行从未亮过。
 * 本文件钉住"metadata → 标签数组"这一跳的形状与零漂移。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANCHOR_METADATA_KEY, anchorLabel, sourceAnchorLabels } from '../src/pipeline/anchors.js';

describe('anchorLabel:UI 契约的坐标写法', () => {
  it('带 step → `t<turn> s<step>`', () => {
    expect(anchorLabel({ sessionId: 's1', turn: 12, step: 3 })).toBe('t12 s3');
  });

  it('step 缺失 → 只写 `t<turn>`(红线:坐标永不推算)', () => {
    expect(anchorLabel({ sessionId: 's1', turn: 12 })).toBe('t12');
    // step=0 是**真坐标**,必须写出来;不能与"缺失"混为一谈
    expect(anchorLabel({ sessionId: 's1', turn: 12, step: 0 })).toBe('t12 s0');
  });
});

describe('sourceAnchorLabels:metadata → UiRecord.sourceAnchors', () => {
  it('按写入顺序给出标签', () => {
    const meta = {
      [ANCHOR_METADATA_KEY]: [
        { sessionId: 's1', turn: 1, step: 5 },
        { sessionId: 's1', turn: 2 },
      ],
    };
    expect(sourceAnchorLabels(meta)).toEqual(['t1 s5', 't2']);
  });

  it('无锚点 / 形状不对 → 空数组(契约:空数组 = 无锚点,不是"没有来源")', () => {
    expect(sourceAnchorLabels(undefined)).toEqual([]);
    expect(sourceAnchorLabels({})).toEqual([]);
    expect(sourceAnchorLabels({ [ANCHOR_METADATA_KEY]: [{ turn: 1 }] })).toEqual([]);
    expect(sourceAnchorLabels('not-an-object')).toEqual([]);
  });

  it('半截坐标被丢,只保留合法项(与 readSourceAnchors 同口径)', () => {
    const meta = {
      [ANCHOR_METADATA_KEY]: [{ sessionId: 's1', turn: 3 }, { sessionId: 42, turn: 1 }, null],
    };
    expect(sourceAnchorLabels(meta)).toEqual(['t3']);
  });
});

describe('stats.ts 读侧接线守卫', () => {
  // 这一跳没有便宜的运行时入口(hitToUiRecord 未导出,且需真库/真 store),
  // 而它的失效方式恰恰是**静默的**:填错字段名照样编译、照样返回、UI 只是不显示。
  // 因此用源码守卫钉住"填的是契约现在认的字段,且走锚点映射"。
  it('hitToUiRecord 填 sourceAnchors 且不再引用已废弃的 sourceMessageIds', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'stats.ts'), 'utf8');
    expect(src).toMatch(/sourceAnchors:\s*sourceAnchorLabels\(/);
    // 只看**赋值**形态(`字段:`),避开解释性注释里提到旧字段名
    expect(src).not.toMatch(/\bsourceMessageIds\s*:/);
  });
});
