/**
 * 蒸馏侧去人格化（persona-leak-guardrails 模块 C 的验收面）。
 *
 * 核心口径是裁决①：**摘特征后保留**，不是整条丢。所以这里既钉「人格特征真的没了」，
 * 也钉「事实部分真的还在」——只钉前者的用例会让「整条丢弃」也变绿，那就把事故写进契约了。
 */

import { describe, expect, it } from 'vitest';

import { isEffectivelyEmpty, scrubPersonaArtifacts, PERSONA_NEUTRAL_MAP } from '../src/audit/persona-scrub.js';
import { PERSONA_LINE_TAGS } from '../src/audit/persona-terms.js';
import { sanitizeText } from '../src/util/sanitize.js';
import { stripPersonaBlocks } from '../src/audit/sanitize-persona.js';

const TERMS = {
  selfNames: ['本鱼'],
  aliases: ['大肥鱼', '鱼鱼', '鱼', '宝'],
  cardName: '俏皮同伴',
  boundaryLines: [...PERSONA_LINE_TAGS],
  source: 'builtin' as const,
};
const EMPTY = { selfNames: [], aliases: [], cardName: '', boundaryLines: [...PERSONA_LINE_TAGS], source: 'builtin' as const };

describe('L0 清洗：人格区块剥离', () => {
  it('整块人设区被剥掉（从 [角色] 起连续方括号行）', () => {
    const text = ['[角色] 俏皮同伴', '[昵称] 主人这样叫我：大肥鱼、宝', '[自称] 本鱼', '[语气] 俏皮', '真正要说的话在这里。'].join('\n');
    expect(sanitizeText(text)).toBe('真正要说的话在这里。');
  });

  it('正文里的普通方括号内容不被误伤（markdown 链接文本 / 普通标签）', () => {
    const text = '参考 [官方文档](https://example.com) 与 [TODO] 项，都不该被删。';
    expect(sanitizeText(text)).toBe(text);
  });

  it('stripPersonaBlocks 与 sanitizeText 同口径（纯函数可单测）', () => {
    expect(stripPersonaBlocks('[角色] 甲\n[自称] 乙\n正文').trim()).toBe('正文');
    expect(stripPersonaBlocks('无块正文')).toBe('无块正文');
  });
});

describe('L1 输出侧：去特征保留内容', () => {
  it('句中出现自称词 ⇒ 删词，句子其余保留（不是整条丢）', () => {
    const out = scrubPersonaArtifacts('本鱼已核实这条记忆的写入路径。', TERMS);
    expect(out).not.toContain('本鱼');
    expect(out).toContain('已核实这条记忆的写入路径');
  });

  it('角色名 ⇒ 删词，其余保留', () => {
    const out = scrubPersonaArtifacts('当前的人格是俏皮同伴，配置在 persona.json。', TERMS);
    expect(out).not.toContain('俏皮同伴');
    expect(out).toContain('persona.json');
  });

  it('行首人设行 ⇒ 整行删除', () => {
    expect(scrubPersonaArtifacts('[角色] 俏皮同伴\n[自称] 本鱼\n本机已安装 dsh-spirit。', TERMS)).toBe('本机已安装 dsh-spirit。');
  });

  it('纯人设条目 ⇒ 返回空串（调用方据此丢弃整条）', () => {
    expect(scrubPersonaArtifacts('[角色] 俏皮同伴\n[自称] 本鱼\n[语气] 俏皮', TERMS)).toBe('');
    expect(scrubPersonaArtifacts('本鱼', TERMS)).toBe('');
  });

  it('称呼位昵称词被摘掉，句子其余保留', () => {
    const out = scrubPersonaArtifacts('宝，这条已经记下了。', TERMS);
    expect(out).not.toContain('宝');
    expect(out).toContain('这条已经记下了');
  });

  it('净化后文本通顺：无连排标点、无多余空格', () => {
    const out = scrubPersonaArtifacts('本鱼 已核实 ，， 结果 。', TERMS);
    expect(out).not.toMatch(/，[，。]/u);
    expect(out).not.toMatch(/ {2,}/u);
  });

  it('正常事实记忆零改动（真实 L1 样本负例，防误杀）', () => {
    const samples = [
      '截至 2026-11-27，dsh-spirit 的 SPIRIT_VERSION 常量在 src/contract.ts 中声明。',
      '用户偏好：使用 NeatDownloader 作为下载工具，坚持裸 Python 环境。',
      'workspace-write 沙箱下 npm run typecheck 需要三个 tsconfig 全部通过。',
      '该会话把 spirit 的 session-modes.json 中 off 标记设为 true。',
    ];
    for (const s of samples) expect(scrubPersonaArtifacts(s, TERMS), s).toBe(s);
  });

  it('空词表 ⇒ 仍剥人设行（退化为至少不让人设块落库）', () => {
    expect(scrubPersonaArtifacts('[角色] 任意角色\n有效内容', EMPTY)).toBe('有效内容');
  });

  it('中性替换表只登记空串（不留改词的隐藏语义）', () => {
    for (const [k, v] of Object.entries(PERSONA_NEUTRAL_MAP)) expect(v, k).toBe('');
  });

  it('isEffectivelyEmpty：只剩标点/空白算空', () => {
    expect(isEffectivelyEmpty('  ，。、  ')).toBe(true);
    expect(isEffectivelyEmpty('有内容')).toBe(false);
  });
});
