/**
 * 认知 hall(cogHall)静态映射单元测试:type 轴 → facts/events/discoveries/preferences/advice。
 */
import { describe, expect, it } from 'vitest';
import { COGNITIVE_HALLS, COG_HALL_METADATA_KEY, cognitiveHallOf, isCognitiveHall } from '../src/cognitive-hall.js';

describe('cognitiveHallOf 静态映射', () => {
  it('全量 type 覆盖:每条蒸馏 type 都能派生认知 hall', () => {
    expect(cognitiveHallOf('work_fact')).toBe('facts');
    expect(cognitiveHallOf('work_artifact')).toBe('facts');
    expect(cognitiveHallOf('persona')).toBe('facts');
    expect(cognitiveHallOf('episodic')).toBe('events');
    expect(cognitiveHallOf('work_task')).toBe('events');
    expect(cognitiveHallOf('work_method')).toBe('discoveries');
    expect(cognitiveHallOf('instruction')).toBe('preferences');
  });

  it('未收录的 type 返回 undefined(不猜),非法输入同样', () => {
    expect(cognitiveHallOf('exotic_type')).toBeUndefined();
    expect(cognitiveHallOf('')).toBeUndefined();
    expect(cognitiveHallOf(42)).toBeUndefined();
    expect(cognitiveHallOf(undefined)).toBeUndefined();
  });

  it('枚举与校验器自洽;metadata 键名不与磁盘兼容键 hall 冲突', () => {
    expect(COGNITIVE_HALLS).toEqual(['facts', 'events', 'discoveries', 'preferences', 'advice']);
    for (const h of COGNITIVE_HALLS) expect(isCognitiveHall(h)).toBe(true);
    expect(isCognitiveHall('facts ')).toBe(false);
    expect(isCognitiveHall('wing')).toBe(false);
    expect(COG_HALL_METADATA_KEY).toBe('cogHall');
    expect(COG_HALL_METADATA_KEY).not.toBe('hall');
  });
});
