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
/** 人格词表。空数组 = 该词类不存在（不是"未知"）。 */
export interface PersonaLeakTerms {
    /** 自称：本鱼。 */
    selfNames: string[];
    /** 昵称：大肥鱼/鱼鱼/鱼/宝（主人怎么喊这条鱼）。 */
    aliases: string[];
    /** 角色名：俏皮同伴。 */
    cardName: string;
    /** 人设行标签：`[角色]` / `[自称]` … 出现即说明整块人格区被抄进了记忆。 */
    boundaryLines: string[];
    /** 词表来自哪一级（诊断用；报告里写出来，避免"审计词表其实兜底了"无从发现）。 */
    source: 'persona.md' | 'spirit.db' | 'builtin';
}
/**
 * 人设行标签。与 dsh-spirit `persona/render.ts` 的行首标签同源
 * （`[角色]/[昵称]/[自称]/[语气]/[看重]/[不会做]/[主人的背景(同步)]`）。
 * 写死在这里是**契约**而非数据：标签是插件的渲染格式，不是用户内容。
 */
export declare const PERSONA_LINE_TAGS: readonly ["[角色]", "[自称]", "[昵称]", "[语气]", "[看重]", "[不会做]", "[主人的背景(同步)]"];
/** 空词表（读不到任何来源时的形状，供调用方判空）。 */
export declare function emptyTerms(): PersonaLeakTerms;
/** spirit 数据目录（与 dsh-spirit 的 dataDir 推导一致：`$DSH_HOME/spirit`）。 */
export declare function spiritDir(dshHome?: string): string;
/** 解析 `persona.md` 的 `## 名字` / `## 昵称` / `## 自称` 三段。 */
export declare function parsePersonaMd(md: string): {
    cardName: string;
    aliases: string[];
    selfNames: string[];
};
/** 读 `spirit.db` 的 `persona_current.card_json`（只读、表不在就退 undefined）。 */
export declare function readCardFromDb(dbPath: string): {
    name?: string;
    aliases?: string[];
    selfNames?: string[];
} | undefined;
/**
 * 载入人格词表（三级回退）。
 *
 * @param dshHome Harness 主目录；省略 ⇒ `$DSH_HOME` 或 `~/.dsh`
 */
export declare function loadPersonaTerms(dshHome?: string): PersonaLeakTerms;
/** 词表是否可用（全空 = 审计无处可比，应当 warn 而不是静默通过）。 */
export declare function termsUsable(terms: PersonaLeakTerms): boolean;
