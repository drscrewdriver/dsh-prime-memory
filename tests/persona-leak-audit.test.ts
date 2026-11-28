/**
 * 人格词表 + 泄露审计（persona-leak-guardrails 模块 B 的验收面）。
 *
 * 全部是纯函数 / 临时库夹具：不驱动 LLM、不碰真机数据目录。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPersonaTerms, parsePersonaMd, PERSONA_LINE_TAGS, spiritDir } from '../src/audit/persona-terms.js';
import {
  ALIAS_EXCLUDES,
  hasState,
  listMdFiles,
  matchLevel,
  readState,
  scanMdFiles,
  runPersonaLeakAudit,
  scanL1,
  scanL0,
  summarize,
  writeState,
} from '../src/audit/persona-leak.js';
import type { MdFileLike, ScanWindow } from '../src/audit/persona-leak.js';

const TERMS = {
  selfNames: ['本鱼'],
  aliases: ['大肥鱼', '鱼鱼', '鱼', '宝'],
  cardName: '俏皮同伴',
  boundaryLines: [...PERSONA_LINE_TAGS],
  source: 'builtin' as const,
};

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-persona-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('词表三级回退', () => {
  it('① persona.md 在 ⇒ 从 md 解析（名字/昵称/自称）', () => {
    mkdirSync(join(dir, 'spirit'), { recursive: true });
    writeFileSync(
      join(dir, 'spirit', 'persona.md'),
      ['# 人设卡', '', '- revision: 6', '', '## 名字', '俏皮同伴', '', '## 昵称', '- 大肥鱼', '- 宝', '', '## 自称', '- 本鱼', ''].join('\n'),
      'utf8',
    );
    const terms = loadPersonaTerms(dir);
    expect(terms.source).toBe('persona.md');
    expect(terms.cardName).toBe('俏皮同伴');
    expect(terms.aliases).toEqual(['大肥鱼', '宝']);
    expect(terms.selfNames).toEqual(['本鱼']);
  });

  it('② md 坏/空 ⇒ 回退 spirit.db 的 card_json', () => {
    const spirit = join(dir, 'spirit');
    mkdirSync(spirit, { recursive: true });
    writeFileSync(join(spirit, 'persona.md'), '# 人设卡\n\n（被手改坏了，没有段）\n', 'utf8');
    const db = new DatabaseSync(join(spirit, 'spirit.db'));
    db.exec('CREATE TABLE persona_current (singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL, card_json TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO persona_current VALUES (1, 3, ?, 0)').run(
      JSON.stringify({ name: '阿昭', aliases: ['阿鱼'], selfNames: ['我'] }),
    );
    db.close();
    const terms = loadPersonaTerms(dir);
    expect(terms.source).toBe('spirit.db');
    expect(terms.cardName).toBe('阿昭');
    expect(terms.aliases).toEqual(['阿鱼']);
  });

  it('③ 两者都没有 ⇒ 内置兜底（审计永不静默失效）', () => {
    const terms = loadPersonaTerms(dir);
    expect(terms.source).toBe('builtin');
    expect(terms.selfNames).toEqual(['本鱼']);
    expect(terms.aliases).toEqual([]);
  });

  it('persona.md 只认列表项：段落里的散文不会被当成昵称', () => {
    const parsed = parsePersonaMd('## 昵称\n主人日常怎么喊这条鱼\n- 宝\n');
    expect(parsed.aliases).toEqual(['宝']);
  });

  it('spiritDir 缺省走 $DSH_HOME/spirit', () => {
    expect(spiritDir().replace(/\\\\/gu, '/')).toMatch(/spirit$/u);
  });
});

describe('匹配分级（纯关键词）', () => {
  it('high：自称词任意出现即命中', () => {
    const m = matchLevel('计划执行完了，本鱼给你交个底', TERMS);
    expect(m?.level).toBe('high');
    expect(m?.matched).toContain('本鱼');
  });

  it('high：角色名任意出现即命中', () => {
    expect(matchLevel('当前的人格是俏皮同伴', TERMS)?.level).toBe('high');
  });

  it('high：人设行标签必须在行首（句中提及不算）', () => {
    expect(matchLevel('[角色] 俏皮同伴', TERMS)?.level).toBe('high');
    // 句中提及标签名不算（spec B3：行首出现即命中——标签只可能来自人格区渲染）
    expect(matchLevel('人格区第一行是 [角色] 标签', TERMS)).toBeUndefined();
    expect(matchLevel('他说这行叫 [语气] 行', TERMS)).toBeUndefined();
    // 换行后的行首也算
    expect(matchLevel('前言\n[自称] 本鱼', TERMS)?.level).toBe('high');
  });

  it('medium：昵称词需要词边界（「查完了，宝。」命中）', () => {
    expect(matchLevel('查完了，宝。', TERMS)?.level).toBe('medium');
    expect(matchLevel('宝，你看看这个', TERMS)?.level).toBe('medium');
  });

  it('medium：边界只看紧邻字符（「漏网之鱼。」「鲸鱼 Logo」「八宝山」都不误报）', () => {
    // 真机实测：早先"前文含任意标点即边界"的口径把这三类全部打成命中
    for (const s of ['覆盖范围 + 漏网之鱼。', '蓝发鱼耳女仆装角色', '前往八宝山革命公墓送别', '腾讯元宝', '吉祥物娘化形象，围裙上有鲸鱼 Logo']) {
      expect(matchLevel(s, TERMS), s).toBeUndefined();
    }
  });

  it('medium：排除词内的单字不误报（淘宝/支付宝/宝藏/宝马）', () => {
    for (const word of ALIAS_EXCLUDES) {
      expect(matchLevel(`我在${word}上看到了`, TERMS), word).toBeUndefined();
    }
  });

  it('正常记忆零命中（真实 L1 样本负例）', () => {
    const samples = [
      '截至 2026-11-27，dsh-prime-memory 的 l1_records 表共有 2436 条记录。',
      '用户偏好：使用 NeatDownloader 作为下载工具。',
      'workspace-write 沙箱下 npm run typecheck 需要三个 tsconfig 全绿。',
    ];
    for (const s of samples) expect(matchLevel(s, TERMS), s).toBeUndefined();
  });
});

describe('扫描器', () => {
  function seedDb(): DatabaseSync {
    const db = new DatabaseSync(join(dir, 'memory.db'));
    db.exec('CREATE TABLE l1_records (record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT, priority INTEGER, scene_name TEXT, session_id TEXT, version INTEGER, timestamp_str TEXT, timestamp_start TEXT, timestamp_end TEXT, created_time TEXT, updated_time TEXT, metadata_json TEXT, family TEXT, scope TEXT, workspace_id TEXT)');
    db.exec('CREATE TABLE l0_conversations (record_id TEXT PRIMARY KEY, session_id TEXT, role TEXT, message_text TEXT, recorded_at TEXT, timestamp INTEGER)');
    return db;
  }

  it('首跑：全库扫，不看窗口', () => {
    const db = seedDb();
    const old = new Date('2020-01-01T00:00:00.000Z').toISOString();
    db.prepare('INSERT INTO l1_records (record_id, content, type, scene_name, updated_time) VALUES (?,?,?,?,?)').run('mem_1', '本鱼已核实这条', 'work_fact', 'dsh-spirit', old);
    db.prepare('INSERT INTO l1_records (record_id, content, type, scene_name, updated_time) VALUES (?,?,?,?,?)').run('mem_2', '用户偏好使用 NeatDownloader', 'user_info', '偏好', old);
    const l1 = scanL1(db, TERMS, { firstRun: true, sinceMs: 0 });
    expect(l1.scanned).toBe(2);
    expect(l1.hits).toHaveLength(1);
    expect(l1.hits[0]?.recordId).toBe('mem_1');
    db.close();
  });

  it('常态：只扫 updated_time > lastRanAt 的 L1', () => {
    const db = seedDb();
    db.prepare('INSERT INTO l1_records (record_id, content, updated_time) VALUES (?,?,?)').run('mem_old', '本鱼旧条目', '2020-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO l1_records (record_id, content, updated_time) VALUES (?,?,?)').run('mem_new', '本鱼新条目', '2026-11-28T00:00:00.000Z');
    const since = Date.parse('2026-11-01T00:00:00.000Z');
    const l1 = scanL1(db, TERMS, { firstRun: false, sinceMs: since });
    expect(l1.scanned).toBe(1);
    expect(l1.hits.map((h) => h.recordId)).toEqual(['mem_new']);
    db.close();
  });

  it('L0 同样两臂：首跑全量 / 增量按 timestamp', () => {
    const db = seedDb();
    db.prepare('INSERT INTO l0_conversations (record_id, session_id, role, message_text, timestamp) VALUES (?,?,?,?,?)').run('l0_a', 's1', 'assistant', '本鱼来啦', 1000);
    db.prepare('INSERT INTO l0_conversations (record_id, session_id, role, message_text, timestamp) VALUES (?,?,?,?,?)').run('l0_b', 's1', 'user', '普通提问', 2000);
    expect(scanL0(db, TERMS, { firstRun: true, sinceMs: 0 }).scanned).toBe(2);
    const inc = scanL0(db, TERMS, { firstRun: false, sinceMs: 1500 });
    expect(inc.scanned).toBe(1);
    expect(inc.hits).toHaveLength(0);
    db.close();
  });

  it('md 臂：首跑全量，增量按 mtime 过滤', () => {
    const root = join(dir, 'memories');
    mkdirSync(join(root, 'work_fact'), { recursive: true });
    writeFileSync(join(root, 'work_fact', 'a.memory.md'), '# a\n本鱼写的\n', 'utf8');
    writeFileSync(join(root, 'work_fact', 'b.memory.md'), '# b\n普通事实\n', 'utf8');
    const files = listMdFiles(root);
    expect(files).toHaveLength(2);
    const mtime = (abs: string): number => (abs.endsWith('a.memory.md') ? 1000 : 5000);
    const first = scanMdFilesForTest(files, { firstRun: true, sinceMs: 0 }, mtime);
    expect(first.scanned).toBe(2);
    expect(first.hits).toHaveLength(1);
    const inc = scanMdFilesForTest(files, { firstRun: false, sinceMs: 3000 }, mtime);
    expect(inc.scanned).toBe(1);
    expect(inc.hits).toHaveLength(0);
  });
});

// scanMdFiles 的 mtime 注入走第三/第四参数，包一层让用例读得顺
function scanMdFilesForTest(files: readonly MdFileLike[], window: ScanWindow, mtimeOf: (abs: string) => number) {
  return scanMdFiles(files, TERMS, window, (abs) => readFileSync(abs, 'utf8'), mtimeOf);
}

describe('报告与状态机', () => {
  it('首跑写报告 + 状态文件；第二跑变增量', () => {
    const db = new DatabaseSync(join(dir, 'memory.db'));
    db.exec('CREATE TABLE l1_records (record_id TEXT PRIMARY KEY, content TEXT, type TEXT, scene_name TEXT, updated_time TEXT)');
    db.exec('CREATE TABLE l0_conversations (record_id TEXT PRIMARY KEY, session_id TEXT, role TEXT, message_text TEXT, timestamp INTEGER)');
    db.prepare('INSERT INTO l1_records (record_id, content, updated_time) VALUES (?,?,?)').run('mem_1', '本鱼在这', '2020-01-01T00:00:00.000Z');
    expect(hasState(dir)).toBe(false);
    const first = runPersonaLeakAudit({ dataDir: dir, terms: TERMS, windowDays: 7, db, mdFiles: [] });
    expect(first.firstRun).toBe(true);
    expect(first.summary.l1).toBe(1);
    expect(first.summary.high).toBe(1);
    expect(first.terms.source).toBe('builtin');
    expect(hasState(dir)).toBe(true);
    const state = readState(dir);
    expect(state?.firstRunDone).toBe(true);
    // 第二跑：老条目不在窗口内 ⇒ 不再命中（首跑已看过它）
    const second = runPersonaLeakAudit({ dataDir: dir, terms: TERMS, windowDays: 7, db, mdFiles: [], now: (state?.lastRanAt ?? 0) + 1000 });
    expect(second.firstRun).toBe(false);
    expect(second.summary.l1).toBe(0);
    db.close();
  });

  it('状态文件损坏 ⇒ 按首跑处理（宁可多扫一遍，不可漏扫）', () => {
    mkdirSync(join(dir, 'audit'), { recursive: true });
    writeFileSync(join(dir, 'audit', '.persona-leak-state.json'), '{oops', 'utf8');
    expect(readState(dir)).toBeUndefined();
    writeState(dir, { lastRanAt: 123, firstRunDone: true });
    expect(readState(dir)).toEqual({ lastRanAt: 123, firstRunDone: true });
  });

  it('summary 分层计数正确', () => {
    const s = summarize([
      { layer: 'l1', recordId: 'a', name: '', level: 'high', matched: [], excerpt: '' },
      { layer: 'l0', recordId: 'b', name: '', level: 'medium', matched: [], excerpt: '' },
      { layer: 'md', recordId: 'c', name: '', level: 'high', matched: [], excerpt: '' },
    ]);
    expect(s).toEqual({ l1: 1, l0: 1, md: 1, high: 2, medium: 1 });
  });
});
