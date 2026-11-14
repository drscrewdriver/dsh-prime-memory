/**
 * 类型词表单一真源（pm-name-distill Phase 1）的守卫用例。
 *
 * 钉住的都是"分头演化"的历史断裂：
 *   - 投射目录集合必须恰等于真源派生（漏一个 = 新类静默落兜底桶，只少目录树不报错）；
 *   - family 判据必须查表（`project_*`/`*_experience` 不带 work 前缀，前缀猜会静默改共享面）；
 *   - memory_add 不得再**静默**抹平外部分类（降级可观测）；
 *   - 面板标签/枚举串不得再手抄（prompt 含全部真源类名）；
 *   - 每个词表类都要有 CSS 类（缺一个 = 标签有字无色，F11）；
 *   - memport TS/Python 两侧 TYPE_CODES 必须同表（否则同一 .mem 包两套判定）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { registerMemoryTools } from '../src/tools/index.js';
import { MEMORY_TYPE_DIRS, UNSORTED_DIR } from '../src/store/memory-md.js';
import {
  HOST_MEMORY_TYPES, LEGACY_MEMORY_TYPES, MEMORY_TYPE_LABELS, MEMORY_TYPE_VOCABULARY,
  NON_EXTRACT_TYPES, UNCLASSIFIED_DIR, familyOf, isKnownType, memoryTypeDirs, slugOf, typeCatalogEntries,
  resetFamilyWarned, setFamilyWarnSink,
} from '../src/memory-types.js';
import { familyForType } from '../src/types.js';
import {
  ALL_CONFLICT_DETECTION_SYSTEM_PROMPT, CONFLICT_DETECTION_SYSTEM_PROMPT, WORK_CONFLICT_DETECTION_SYSTEM_PROMPT,
} from '../src/prompts/l1-dedup.js';
import {
  EXTRACT_ALL_MEMORIES_SYSTEM_PROMPT, EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT,
} from '../src/prompts/l1-extraction.js';
import { TYPE_CODES } from '../src/memport/format.js';
import { COMPONENT_CSS } from '../client/src/theme.js';
import type { MemoryConfig } from '../src/config.js';
import type { MemoryLogger, MemoryRecord } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  // warn 是模块级"只提醒一次"，用例之间必须清账，否则后一条断言吃前一条的状态
  resetFamilyWarned();
  setFamilyWarnSink(undefined);
});

describe('词表规模与派生', () => {
  it('宿主 29 + 旧 7 + 外源 1 = 37 可赋值类；目录集 = 37 + 兜底桶 = 38', () => {
    expect(HOST_MEMORY_TYPES).toHaveLength(29);
    expect(LEGACY_MEMORY_TYPES).toHaveLength(7);
    // external_fact 进词表（计划 ext-to-l1-import）：否则面板筛不到、md 目录落 unclassified。
    // 但它不在 prompt 枚举里（见下方“prompt 枚举由真源渲染”与 NON_EXTRACT_TYPES）。
    expect(MEMORY_TYPE_VOCABULARY.size).toBe(37);
    // 两套命名空间字面交集为空（findings 第一节实测；若将来重合说明改名了，须重新裁决）
    expect(HOST_MEMORY_TYPES.filter((t) => LEGACY_MEMORY_TYPES.includes(t))).toEqual([]);
    expect(memoryTypeDirs().size).toBe(38);
  });

  it('投射白名单 MEMORY_TYPE_DIRS 恰等于真源派生（含 unclassified）', () => {
    expect([...MEMORY_TYPE_DIRS].sort()).toEqual([...memoryTypeDirs()].sort());
    expect(UNSORTED_DIR).toBe(UNCLASSIFIED_DIR);
    for (const t of [...LEGACY_MEMORY_TYPES, ...HOST_MEMORY_TYPES]) {
      expect(MEMORY_TYPE_DIRS.has(t)).toBe(true);
    }
  });

  it('每个可赋值类（含兜底桶）都有非空标签——缺一个即红', () => {
    for (const t of [...MEMORY_TYPE_VOCABULARY, UNCLASSIFIED_DIR]) {
      expect((MEMORY_TYPE_LABELS[t] ?? '').length, t).toBeGreaterThan(0);
    }
    expect(typeCatalogEntries()).toHaveLength(38);
  });
});

describe('familyForType 查表化', () => {
  it('新词表的族判定不再靠前缀（project_*/…_experience=work，user_*=chat）', () => {
    expect(familyForType('project_tech_stack')).toBe('work');
    expect(familyForType('development_code_specification')).toBe('work');
    expect(familyForType('task_summary_experience')).toBe('work');
    expect(familyForType('user_info')).toBe('chat');
    expect(familyForType('work_fact')).toBe('work');
    expect(familyForType('persona')).toBe('chat');
    expect(familyOf(UNCLASSIFIED_DIR)).toBe('chat');
  });

  it('未知值回落旧前缀规则，且同一个值只 warn 一次', () => {
    const seen: string[] = [];
    setFamilyWarnSink((m) => seen.push(m));
    expect(familyForType('networking')).toBe('chat');
    expect(familyForType('workthing')).toBe('work');
    expect(familyForType('networking')).toBe('chat');
    expect(seen).toHaveLength(2); // networking + workthing 各一次
    expect(seen[0]).toContain('networking');
  });
});

describe('memory_add 白名单派生 + 降级可观测', () => {
  function toolHarness() {
    const handlers = new Map<string, unknown>();
    const ctx = { on: () => {}, tools: { register: (t: unknown) => handlers.set((t as { name: string }).name, t) } } as unknown as Context;
    const written: MemoryRecord[] = [];
    const warns: string[] = [];
    const logger = { info: () => {}, warn: (m: string) => warns.push(m), error: () => {}, debug: () => {} } as unknown as MemoryLogger;
    const live = { get: () => ({ memoryMutate: true }) };
    const cfg = { tools: true, capture: { enabled: true, maxMessageChars: 4000, stripCodeBlocks: false } } as unknown as MemoryConfig;
    const stores = {
      l0: {} as never,
      l1: { appendNew: async (records: MemoryRecord[]) => written.push(...records) },
      scenes: {} as never,
      persona: {} as never,
    };
    registerMemoryTools(ctx, cfg, stores as never, logger, {} as never, live as never);
    return { handlers, written, warns };
  }

  const add = (h: ReturnType<typeof toolHarness>, args: Record<string, unknown>) =>
    (h.handlers.get('memory_add') as { execute: (a: Record<string, unknown>) => Promise<unknown> }).execute(args);

  it('导入 project_architecture 不被抹平成 episodic，且归 work 族', async () => {
    const h = toolHarness();
    await add(h, { content: '投射目录树以词表真源派生', type: 'project_architecture' });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].type).toBe('project_architecture');
    expect(h.written[0].family).toBe('work');
    expect(h.warns).toEqual([]);
  });

  it('非词表值仍降级为 episodic，但必须 warn 留痕（同值只提一次）', async () => {
    const h = toolHarness();
    await add(h, { content: '一条没有归属的记录', type: 'totally_unknown_cat' });
    await add(h, { content: '又一条', type: 'totally_unknown_cat' });
    expect(h.written[0]!.type).toBe('episodic');
    expect(h.warns.filter((m) => m.includes('totally_unknown_cat'))).toHaveLength(1);
  });
});

describe('prompt 枚举串由真源渲染', () => {
  it('auto 抽取 prompt 含全部可赋值类类名（排除 NON_EXTRACT_TYPES）', () => {
    for (const t of MEMORY_TYPE_VOCABULARY) {
      if (NON_EXTRACT_TYPES.has(t)) continue;
      expect(EXTRACT_ALL_MEMORIES_SYSTEM_PROMPT.includes(t), t).toBe(true);
    }
    // 反向硬断言（审计 P4）：外源类型一旦进 prompt，LLM 会给本地记忆打外源标，
    // 面板上“这是外部记忆”的语义就被污染——所以它必须对 prompt 不可见、对面板可见。
    for (const t of NON_EXTRACT_TYPES) {
      expect(EXTRACT_ALL_MEMORIES_SYSTEM_PROMPT.includes(t), t).toBe(false);
      expect(MEMORY_TYPE_VOCABULARY.has(t), t).toBe(true);
      expect(typeCatalogEntries().some((e) => e.id === t), t).toBe(true);
    }
  });

  it('work 抽取 prompt 含全部 work 族类名，且不含 chat 族类名（不许交叉）', () => {
    expect(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT.includes('project_tech_stack')).toBe(true);
    expect(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT.includes('persona')).toBe(false);
    expect(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT.includes('user_info')).toBe(false);
  });

  it('chat/all 两份 dedup prompt 含全部可赋值类名（排除 NON_EXTRACT）；work 份含全 work 族不含 chat 族', () => {
    for (const [name, p] of [['all', ALL_CONFLICT_DETECTION_SYSTEM_PROMPT], ['chat', CONFLICT_DETECTION_SYSTEM_PROMPT]] as const) {
      for (const t of MEMORY_TYPE_VOCABULARY) {
        if (NON_EXTRACT_TYPES.has(t)) {
          expect(p.includes(t), `${name}:不应含${t}`).toBe(false);
          continue;
        }
        expect(p.includes(t), `${name}:${t}`).toBe(true);
      }
    }
    expect(WORK_CONFLICT_DETECTION_SYSTEM_PROMPT.includes('project_environment_configuration')).toBe(true);
    expect(WORK_CONFLICT_DETECTION_SYSTEM_PROMPT.includes('episodic')).toBe(false);
    expect(WORK_CONFLICT_DETECTION_SYSTEM_PROMPT.includes('user_hobby')).toBe(false);
  });

  it('兜底桶 unclassified 不作为可赋值类出现在任何枚举里（它是目录，不是类型）', () => {
    expect(isKnownType(UNCLASSIFIED_DIR)).toBe(false);
    // 'unclassified' 字面不许进抽取/去重 prompt 的 type 枚举
    expect(EXTRACT_ALL_MEMORIES_SYSTEM_PROMPT).not.toContain(UNCLASSIFIED_DIR);
    expect(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT).not.toContain(UNCLASSIFIED_DIR);
  });
});

describe('词表 → CSS 类覆盖（F11）', () => {
  const css = COMPONENT_CSS.join('\n');
  it('每个词表类（含兜底桶）都有 .dsh-mem-tag-<slug> 亮/暗两条类', () => {
    for (const t of [...MEMORY_TYPE_VOCABULARY, UNCLASSIFIED_DIR]) {
      const cls = `.dsh-mem-tag-${slugOf(t)}`;
      expect(css.includes(cls), t).toBe(true);
      expect(css.includes(`body[data-ds-dark-theme] ${cls}`), t).toBe(true);
    }
  });

  it('类名一律连字符 slug，词表里不存在带下划线的类', () => {
    for (const t of [...MEMORY_TYPE_VOCABULARY]) {
      if (t.includes('_')) expect(css.includes(`.dsh-mem-tag-${t}`), t).toBe(false);
    }
  });
});

describe('memport 双实现 TYPE_CODES 同表', () => {
  it('宿主 29 类全部有码；TS 侧每个 (码,type) 对逐字出现在 memport.py', () => {
    expect(Object.keys(TYPE_CODES)).toHaveLength(36);
    for (const t of MEMORY_TYPE_VOCABULARY) {
      // 外源类型不经 memport 写入（memport 是 .mem 文件包导入），所以它不在码表里：
      // 给个假码反而会让两侧码表出现“能写不能导”的错配。
      if (NON_EXTRACT_TYPES.has(t)) continue;
      expect(Object.values(TYPE_CODES)).toContain(t);
    }
    const py = readFileSync(join(HERE, '..', 'skills', 'memport', 'scripts', 'memport.py'), 'utf8');
    for (const [code, type] of Object.entries(TYPE_CODES)) {
      expect(py.includes(`"${code}": "${type}"`), `${code}→${type}`).toBe(true);
    }
  });

  it('码表无重复值/重复码（Object 键天然去重，值必须 36 个不重）', () => {
    const values = Object.values(TYPE_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});
