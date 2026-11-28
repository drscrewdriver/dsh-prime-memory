/**
 * 人格词表（prime-memory 侧只读消费 dsh-spirit 的产物）。
 *
 * 为什么从 spirit 数据读而不是硬编码：人格卡是**用户的**，不是本插件的常量。
 * 写死「本鱼」只能治作者这一台机器，换个人设就静默失效。
 *
 * 读链三级回退（任一成功即停）：
 *  1. `<DSH_HOME>/spirit/persona.md` —— 纯文本投影，不需要 spirit 进程在跑；
 *  2. `<DSH_HOME>/spirit/spirit.db` → `persona_current.card_json` —— md 被手改坏时的兜底；
 *  3. 内置最小集 `['本鱼']` —— 保证审计永不静默失效。
 *
 * 边界：**单向只读**。本模块只读文件/只读库，不引用 dsh-spirit 包、不写它的数据。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
/**
 * 人设行标签。与 dsh-spirit `persona/render.ts` 的行首标签同源
 * （`[角色]/[昵称]/[自称]/[语气]/[看重]/[不会做]/[主人的背景(同步)]`）。
 * 写死在这里是**契约**而非数据：标签是插件的渲染格式，不是用户内容。
 */
export const PERSONA_LINE_TAGS = [
    '[角色]',
    '[自称]',
    '[昵称]',
    '[语气]',
    '[看重]',
    '[不会做]',
    '[主人的背景(同步)]',
];
/** 兜底词表：只放"最确定"的自称词。宁可漏报，不可误报。 */
const BUILTIN_SELF_NAMES = ['本鱼'];
/** 空词表（读不到任何来源时的形状，供调用方判空）。 */
export function emptyTerms() {
    return { selfNames: [], aliases: [], cardName: '', boundaryLines: [...PERSONA_LINE_TAGS], source: 'builtin' };
}
/** spirit 数据目录（与 dsh-spirit 的 dataDir 推导一致：`$DSH_HOME/spirit`）。 */
export function spiritDir(dshHome) {
    return dshHome === undefined || dshHome === '' ? dshHomePath('spirit') : join(dshHome, 'spirit');
}
/** 解析 `persona.md` 的 `## 名字` / `## 昵称` / `## 自称` 三段。 */
export function parsePersonaMd(md) {
    const out = { cardName: '', aliases: [], selfNames: [] };
    let section = '';
    for (const rawLine of md.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (line.startsWith('## ')) {
            section = line.slice(3).trim();
            continue;
        }
        if (section === '')
            continue;
        if (section === '名字') {
            if (out.cardName === '' && line !== '')
                out.cardName = line;
            continue;
        }
        if (section !== '昵称' && section !== '自称')
            continue;
        // 只认列表项：段落里的解释文字不算词条（否则会把整句散文当昵称）
        const m = /^[-*]\s*(.+)$/u.exec(line);
        if (!m)
            continue;
        const word = (m[1] ?? '').trim();
        if (word === '')
            continue;
        if (section === '昵称')
            out.aliases.push(word);
        else
            out.selfNames.push(word);
    }
    return out;
}
/** 读 `spirit.db` 的 `persona_current.card_json`（只读、表不在就退 undefined）。 */
export function readCardFromDb(dbPath) {
    if (!existsSync(dbPath))
        return undefined;
    try {
        // 与 src/index.ts 同款：静态 import node:sqlite（engines.node 已要求 >=22.16）
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const row = db.prepare('SELECT card_json FROM persona_current LIMIT 1').get();
            const raw = row?.card_json;
            if (typeof raw !== 'string' || raw === '')
                return undefined;
            const parsed = JSON.parse(raw);
            return {
                ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
                ...(Array.isArray(parsed.aliases) ? { aliases: parsed.aliases.filter((x) => typeof x === 'string') } : {}),
                ...(Array.isArray(parsed.selfNames) ? { selfNames: parsed.selfNames.filter((x) => typeof x === 'string') } : {}),
            };
        }
        finally {
            db.close();
        }
    }
    catch {
        // 库损坏 / 表不存在 / node:sqlite 不可用 —— 一律当"这一级读不到"，交给下一级
        return undefined;
    }
}
/**
 * 载入人格词表（三级回退）。
 *
 * @param dshHome Harness 主目录；省略 ⇒ `$DSH_HOME` 或 `~/.dsh`
 */
export function loadPersonaTerms(dshHome) {
    const dir = spiritDir(dshHome);
    // ① persona.md
    try {
        const mdPath = join(dir, 'persona.md');
        if (existsSync(mdPath)) {
            const parsed = parsePersonaMd(readFileSync(mdPath, 'utf8'));
            if (parsed.selfNames.length > 0 || parsed.aliases.length > 0 || parsed.cardName !== '') {
                return { ...parsed, boundaryLines: [...PERSONA_LINE_TAGS], source: 'persona.md' };
            }
        }
    }
    catch {
        /* 读不到就走下一级 */
    }
    // ② spirit.db
    const card = readCardFromDb(join(dir, 'spirit.db'));
    if (card !== undefined) {
        const selfNames = card.selfNames ?? [];
        const aliases = card.aliases ?? [];
        const cardName = card.name ?? '';
        if (selfNames.length > 0 || aliases.length > 0 || cardName !== '') {
            return { selfNames, aliases, cardName, boundaryLines: [...PERSONA_LINE_TAGS], source: 'spirit.db' };
        }
    }
    // ③ 内置兜底
    return { selfNames: [...BUILTIN_SELF_NAMES], aliases: [], cardName: '', boundaryLines: [...PERSONA_LINE_TAGS], source: 'builtin' };
}
/** 词表是否可用（全空 = 审计无处可比，应当 warn 而不是静默通过）。 */
export function termsUsable(terms) {
    return terms.selfNames.length > 0 || terms.aliases.length > 0 || terms.cardName !== '';
}
