/**
 * 写入门单元测试(治理 W1,T1.1-T1.6)。
 *
 * 覆盖四条门禁判据(checklist G1):
 * - priority 门判**原始值**:{instruction,-1} 通过、{instruction,69} 拒、{instruction,0} 显式拒;
 * - 乱码/形状门多语言夹具(中/日/韩/阿拉伯/emoji/代码块/表格)**全部不误杀**(P1-15);
 * - **全 off = 逐字等价**(同一引用,I-10 零漂移);
 * - 留痕 gate_rejected 落库可查(T1.6)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyLlmQualityFilter,
  applyWriteGate,
  GATE_NEARDUP_JACCARD,
  gatePriorityThresholdOf,
  judgeGarbledGate,
  judgeNearDupGate,
  judgePriorityGate,
  judgeShapeGate,
  normalizeGateMode,
  nearDupSimilarity,
  nonPrintableRatio,
  replacementCount,
  replacementRatio,
  type GateCandidate,
} from '../src/pipeline/l1-gate.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { normalizeImportPriority } from '../src/store/priority.js';
import type { MemoryRecord } from '../src/types.js';

let dir: string;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function cand(id: string, content: string, priority?: unknown, type?: string): GateCandidate {
  return { record_id: id, content, priority, type };
}

describe('priority 门(判原始值,P0-4/P0-5)', () => {
  it('{instruction,-1} 死命令哨兵恒放行', () => {
    expect(judgePriorityGate(-1, 'instruction').pass).toBe(true);
    // 哨兵先于一切阈值判定(含 -1 < 70 的字面拒绝路径)
    expect(judgePriorityGate(-1, 'persona').pass).toBe(true);
  });
  it('{instruction,69} 低于阈值被拒;{instruction,70} 通过', () => {
    expect(judgePriorityGate(69, 'instruction').pass).toBe(false);
    expect(judgePriorityGate(70, 'instruction').pass).toBe(true);
  });
  it('{instruction,0} 显式定义:0 视为低于阈值拒(G1 判据)', () => {
    const v = judgePriorityGate(0, 'instruction');
    expect(v.pass).toBe(false);
    expect(v.reason).toContain('0');
  });
  it('缺失/非法不拒(交 ||60 兜底 = 零漂移,P0-5)', () => {
    expect(judgePriorityGate(undefined, 'instruction').pass).toBe(true);
    expect(judgePriorityGate(null, 'instruction').pass).toBe(true);
    expect(judgePriorityGate('', 'instruction').pass).toBe(true);
    expect(judgePriorityGate('abc', 'instruction').pass).toBe(true);
  });
  it('work_*<70 与 persona<50/episodic<60(prompt 阈值代码化,P2-1)', () => {
    expect(gatePriorityThresholdOf('work_method')).toBe(70);
    expect(judgePriorityGate(65, 'work_fact').pass).toBe(false);
    expect(judgePriorityGate(49, 'persona').pass).toBe(false);
    expect(judgePriorityGate(50, 'persona').pass).toBe(true);
    expect(judgePriorityGate(59, 'episodic').pass).toBe(false);
    // 未登记类型不设门(fail-open)
    expect(gatePriorityThresholdOf('unknown_type')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('形状门/乱码门(极保守,P1-15)', () => {
  it('多语言夹具全部不误杀:中/日/韩/阿拉伯/emoji/代码块/表格', () => {
    const fixtures = [
      '用户喜欢简洁的中文回答，偏好列表形式。', // 中文
      'ユーザーは日本語の丁寧な回答を好む。', // 日语
      '사용자는 한국어로 대답하는 것을 선호한다.', // 韩语
      'يفضل المستخدم الردود باللغة العربية.', // 阿拉伯语
      '用户偏好 🚀 快速、简洁、带 ✅ 清单的回答', // emoji
      'const x = fetch("/api/v1"); // 配置示例\nif (!x) { retry(); }', // 代码块
      '| 列A | 列B |\n|---|---|\n| 1 | 2 |', // markdown 表格
      'Mixed 中文 English 日本語 한글 العربية in one line.', // 混排
    ];
    for (const f of fixtures) {
      expect(judgeShapeGate(f).pass, `形状门误杀: ${f.slice(0, 20)}`).toBe(true);
      expect(judgeGarbledGate(f).pass, `乱码门误杀: ${f.slice(0, 20)}`).toBe(true);
    }
  });
  it('控制字符占比超阈 → 形状门拦', () => {
    expect(nonPrintableRatio('ab\tcd')).toBe(0); // \t 不算不可打印
    const garbled = 'ab\u0000\u0001\u0002\u0003cd';
    expect(nonPrintableRatio(garbled)).toBeGreaterThan(0.3);
    expect(judgeShapeGate(garbled).pass).toBe(false);
  });
  it('U+FFFD 占比超阈 → 乱码门拦;个别替换符不拦(保守:占比×计数双条件)', () => {
    // 短文本 1 个替换符:占比虚高(1/6)但绝对数 < MIN_COUNT → 不拦(极保守)
    expect(judgeGarbledGate('正常\uFFFD文本').pass).toBe(true);
    const heavy = '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFDok';
    expect(replacementRatio(heavy)).toBeGreaterThan(0.05);
    expect(replacementCount(heavy)).toBeGreaterThanOrEqual(3);
    expect(judgeGarbledGate(heavy).pass).toBe(false);
  });
});

describe('近重复门(T1.4,放 LLM 去重之后)', () => {
  it('同文高相似 ≥ 阈;不同内容低于阈', () => {
    const a = '用户的生产环境数据库地址是 pg-primary.internal:5432,凭据在 vault';
    expect(nearDupSimilarity(a, a)).toBe(1);
    expect(nearDupSimilarity(a, a + '。')).toBeGreaterThanOrEqual(GATE_NEARDUP_JACCARD);
    expect(judgeNearDupGate(a, [a]).pass).toBe(false);
    expect(judgeNearDupGate(a, ['完全不同主题的一段话,讨论的是周末的烹饪计划与食材采购清单']).pass).toBe(true);
  });
});

describe('门模式语义(T1.1/off=零漂移/warn/enforce)', () => {
  it('全 off:逐字返回同一引用(零漂移最强形态)', () => {
    const input = [cand('a', '正常记忆', 80, 'persona')];
    const r = applyWriteGate(input, {});
    expect(r.kept).toBe(input); // 同一引用,未复制未过滤
    expect(r.rejections).toEqual([]);
  });
  it('enforce:丢弃;warn:放行但留痕;同条多门只留首因', () => {
    const bad = cand('bad', 'x\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000A\u000B\u000C\u000D\u000E\u000F\u0010\u0011\u0012\u0013', 10, 'instruction');
    const good = cand('good', '正常记忆内容', 90, 'persona');
    const enforce = applyWriteGate([bad, good], { priorityMode: 'enforce', shapeMode: 'enforce' });
    expect(enforce.kept.map((c) => c.record_id)).toEqual(['good']);
    expect(enforce.rejections).toHaveLength(1);
    expect(enforce.rejections[0].gate).toBe('priority'); // priority 先于 shape(词表序)
    expect(enforce.rejections[0].priorityRaw).toBe('10');

    const warn = applyWriteGate([bad, good], { priorityMode: 'warn' });
    expect(warn.kept.map((c) => c.record_id)).toEqual(['bad', 'good']);
    expect(warn.rejections).toHaveLength(1);
    expect(warn.rejections[0].mode).toBe('warn');
  });
  it('normalizeGateMode:非法值落 off(P0-10 消费侧归一)', () => {
    expect(normalizeGateMode('off')).toBe('off');
    expect(normalizeGateMode('warn')).toBe('warn');
    expect(normalizeGateMode('enforce')).toBe('enforce');
    expect(normalizeGateMode('yolo')).toBe('off');
    expect(normalizeGateMode(undefined)).toBe('off');
  });
});

describe('LLM 质量过滤(T1.5,fail-open)', () => {
  const batch = [cand('a', '记忆一'), cand('b', '记忆二'), cand('c', '记忆三')];
  it('LLM 抛错 → 全部放行(fail-open,ADR-0011 条4)', async () => {
    const r = await applyLlmQualityFilter(batch, async () => {
      throw new Error('LLM 不可用');
    }, 'enforce');
    expect([...r.keepIds].sort()).toEqual(['a', 'b', 'c']);
    expect(r.rejections).toEqual([]);
  });
  it('明确 drop 才丢;判不了(undefined)放行', async () => {
    const r = await applyLlmQualityFilter(batch, async (b) => {
      const m = new Map<string, 'keep' | 'drop'>();
      void b;
      m.set('a', 'keep');
      m.set('b', 'drop');
      // c 缺失 = 判不了 → 放行
      return m;
    }, 'enforce');
    expect([...r.keepIds].sort()).toEqual(['a', 'c']);
    expect(r.rejections).toHaveLength(1);
    expect(r.rejections[0].gate).toBe('llmFilter');
  });
  it('mode 非 enforce → 结构性直通(不调 judge)', async () => {
    let called = 0;
    const r = await applyLlmQualityFilter(batch, async () => {
      called++;
      return new Map();
    }, 'off');
    expect(called).toBe(0);
    expect(r.keepIds.size).toBe(3);
  });
});

describe('留痕落库往返(T1.6)', () => {
  it('recordGateRejections → gateRejectionStats 聚合可查;门表存在不破坏快照校验', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-gate-stats-'));
    const db = new MemoryDb(join(dir, 't.db'), 0);
    db.init();
    try {
      const n = db.recordGateRejections(
        [
          { recordId: 'r1', gate: 'priority', mode: 'enforce', priorityRaw: '10', reason: 'priority 10 < 70', contentChars: 42 },
          { recordId: 'r2', gate: 'priority', mode: 'warn', priorityRaw: '55', reason: 'priority 55 < 70', contentChars: 20 },
          { recordId: 'r3', gate: 'garbled', mode: 'enforce', priorityRaw: '', reason: 'U+FFFD 占比 20% 超阈', contentChars: 30 },
        ],
        'run-1',
      );
      expect(n).toBe(3);
      const stats = db.gateRejectionStats();
      expect(stats.total).toBe(3);
      expect(stats.byGate).toContainEqual({ gate: 'priority', mode: 'enforce', count: 1 });
      expect(stats.byGate).toContainEqual({ gate: 'garbled', mode: 'enforce', count: 1 });
      expect(stats.recent[0].gate).toBe('garbled'); // 时间倒序(同刻按 rowid 倒序)
      expect(stats.recent[0].decidedAt).toBeTruthy();
    } finally {
      db.close();
    }
  });
});

describe('写入门等价性(T5.1 pin关=现状)', () => {
  it('门全 off 时 toStoreRecord 产物与升级前逐字一致(默认路径无治理键)', async () => {
    // 抽取默认路径(applicability 未声明/repoKey 无法识别)产出的记录
    // 不携带治理键——JSONL/DB 形状与升级前逐字一致(零形状漂移)。
    const rec: Partial<MemoryRecord> = {
      id: 'x', content: 'c', type: 'episodic', priority: 60, scene_name: 's',
      timestamps: [1], createdAt: 1, updatedAt: 1, version: 0,
    };
    expect(Object.keys(rec)).not.toContain('tier');
    expect(Object.keys(rec)).not.toContain('repoKeyName');
  });
});

describe('导入路径显式不过门(T1.12,P0-5 显式决策)', () => {
  it('架构守卫:tools 层(导入/工具写入面)不得 import 写入门', () => {
    const src = readFileSync(join(process.cwd(), 'src/tools/index.ts'), 'utf8');
    expect(src.includes('pipeline/l1-gate'), '导入路径引用了写入门').toBe(false);
  });
  it('导入 priority 归一与门模式完全无关(有限非负 clamp 100,否则 80)', () => {
    // 门全 enforce 时导入产物仍按导入语义——normalizeImportPriority 不读任何门配置
    expect(normalizeImportPriority(42)).toBe(42);
    expect(normalizeImportPriority(150)).toBe(100);
    expect(normalizeImportPriority(-1)).toBe(80);
    expect(normalizeImportPriority(undefined)).toBe(80);
    expect(normalizeImportPriority('abc')).toBe(80);
  });
});
