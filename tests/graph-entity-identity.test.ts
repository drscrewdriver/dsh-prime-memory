/**
 * 实体身份纯函数测试(计划 v0.26.57 本体扩容 · checklist 钉)。
 *
 * 覆盖:checklist 25 条判定样例 + 25 个真实泛称样本(实测 graph_nodes 抽
 * 样,全部必须命中 role)+ 8 个真实概念样本(category 六档词根)+ 限定名
 * 边界(@drscrewdriver 首位 @ / 多重 @ / 空限定符)。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyConceptCategory,
  classifyNameKind,
  clampConceptCategory,
  isAliasShaped,
  isDescriptiveName,
  isPathLike,
  isRoleName,
  qualifyName,
  splitQualified,
} from '../src/graph/entity-identity.js';

describe('checklist 25 条:实体身份判定', () => {
  it('classifyNameKind 基本盘', () => {
    expect(classifyNameKind('用户')).toBe('role');
    expect(classifyNameKind('drscrewdriver')).toBe('proper');
    expect(classifyNameKind('于开丞')).toBe('proper');
    expect(classifyNameKind('用户/AI协作')).toBe('role');
    expect(classifyNameKind('用户沟通偏好与背景')).toBe('role');
    expect(classifyNameKind('E:\\test\\machine-learning\\.venv')).toBe('path');
    expect(classifyNameKind('.agents/skills')).toBe('path');
    expect(classifyNameKind('PerryLink 排 #12')).toBe('descriptive');
  });

  it('isPathLike:scoped 包名不是路径,URL 不是路径', () => {
    expect(isPathLike('@changfenhuang/dsh-genui')).toBe(false);
    expect(isPathLike('C:\\Users\\joshua\\.dsh')).toBe(true);
    expect(isPathLike('dist/')).toBe(true);
    expect(isPathLike('https://github.com/drscrewdriver')).toBe(false);
    expect(isPathLike('$env:TEMP')).toBe(true);
    expect(isPathLike('~/memory.db')).toBe(true);
    expect(isPathLike('src/graph/apply.ts')).toBe(true);
    expect(isPathLike('VSCode')).toBe(false);
  });

  it('isAliasShaped:写法变体准入,动作句/读数/从句拒绝', () => {
    expect(isAliasShaped('老张')).toBe(true);
    expect(isAliasShaped('Kaicheng Yu')).toBe(true);
    expect(isAliasShaped('PerryLink 排 #12')).toBe(false);
    expect(isAliasShaped('用户确认口径后执行')).toBe(false);
    expect(isAliasShaped('MichengAI下降49,397')).toBe(false);
    expect(isAliasShaped('C:\\x\\y')).toBe(false);
    expect(isAliasShaped('')).toBe(false);
  });

  it('splitQualified/qualifyName:取最后一个 @,首位 @ 不算限定符', () => {
    expect(splitQualified('用户@DSH')).toEqual({ base: '用户', qualifier: 'DSH' });
    expect(splitQualified('于开丞')).toEqual({ base: '于开丞', qualifier: undefined });
    expect(splitQualified('@drscrewdriver')).toEqual({ base: '@drscrewdriver' });
    expect(splitQualified('a@b@c')).toEqual({ base: 'a@b', qualifier: 'c' });
    expect(splitQualified('名字@')).toEqual({ base: '名字' });
    expect(qualifyName('用户', 'DSH')).toBe('用户@DSH');
    expect(qualifyName('用户')).toBe('用户');
  });

  it('isRoleName:裸词与前缀/后缀组合词都算泛称', () => {
    expect(isRoleName('用户')).toBe(true);
    expect(isRoleName('用户@DSH')).toBe(false); // 带限定符不在此列(调用方先拆)
    expect(isRoleName('张三')).toBe(false);
    expect(isRoleName('GraphX')).toBe(false);
  });

  it('isDescriptiveName:谓语句/超长是描述,专名不是', () => {
    expect(isDescriptiveName('确认了方案')).toBe(true);
    expect(isDescriptiveName('x'.repeat(41))).toBe(true);
    expect(isDescriptiveName('DSH')).toBe(false);
  });
});

describe('真实样本回归(实测 25 个泛称节点全部命中 role)', () => {
  const roles = [
    '用户', '助手', 'AI', 'AI/Agent', 'AI代理', 'AI执行代理', '全栈开发者',
    '插件维护者', '插件开发者', '开发团队', '项目主导者', '项目维护者',
    'dev maintainer', '数据维护方', '执行分析的助手', 'Assistant',
    'chief steward', '当前执行会话', '用户/AI协作', '用户沟通偏好与背景',
    '自动化Agent', 'AI/维护者', '团队', '插件开发团队', '维护者',
  ];
  for (const r of roles) {
    it(`泛称命中: ${r}`, () => {
      expect(isRoleName(r)).toBe(true);
      expect(classifyNameKind(r)).toBe('role');
    });
  }
});

describe('概念分类(category 六档词根)', () => {
  it('checklist 六样本', () => {
    expect(classifyConceptCategory('压缩算法')).toBe('algorithm');
    expect(classifyConceptCategory('S1搜索重排机制')).toBe('mechanism');
    expect(classifyConceptCategory('NPM 发布操作规范')).toBe('spec');
    expect(classifyConceptCategory('第一性原理')).toBe('principle');
    expect(classifyConceptCategory('单写多读架构')).toBe('pattern');
    expect(classifyConceptCategory('DSH 框架')).toBe('other');
  });

  it('真实概念样本', () => {
    const cases: Array<[string, string]> = [
      ['B+树索引', 'algorithm'],
      ['RRF 倒数排名融合', 'algorithm'],
      ['蒸馏管线', 'mechanism'],
      ['投影回链机制', 'mechanism'],
      ['插件发布门禁', 'spec'],
      ['语义化版本约定', 'spec'],
      ['缓存一致性原则', 'principle'],
      ['观察者模式', 'pattern'],
    ];
    for (const [name, want] of cases) expect(classifyConceptCategory(name)).toBe(want);
  });

  it('clampConceptCategory:非法值回落词根猜测,合法值原样保留', () => {
    expect(clampConceptCategory('algorithm', '随便')).toBe('algorithm');
    expect(clampConceptCategory('乱写', '压缩算法')).toBe('algorithm');
    expect(clampConceptCategory(undefined, '无关名词')).toBe('other');
  });
});
