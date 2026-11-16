/**
 * 实体身份纯函数(零 I/O、零状态):名字"像什么"的判定单源。
 *
 * 背景(实测 1591 节点):place 的 48% 是文件路径、person 的 17% 是泛称角色
 * ("用户"一个人挂 158 fact)、别名里混着动作句("用户确认口径后执行")。
 * 本体论要区分干净,判定就得有可测试的纯函数——prompt 侧靠它同源内插词表,
 * apply 侧靠它做硬校验,两侧共用一份判据(防"提示词说一套、校验做另一套")。
 */
import { GRAPH_CONCEPT_CATEGORY_SET, GRAPH_ROLE_SET, GRAPH_ROLE_WORDS } from './constraints.js';
/**
 * 路径形态判定:盘符、波浪号家目录、环境变量插值、多级斜杠、常见文件后缀。
 * 注意排除 npm scoped 包名(@scope/pkg 有一级斜杠但是真工具,不是路径)。
 */
export function isPathLike(name) {
    const n = name.trim();
    if (!n)
        return false;
    // @scope/pkg 形态:at 段合法,不算路径
    if (/^@[\w.-]+\/[\w.-]+$/.test(n))
        return false;
    // URL 交给组织/站点判定,不在路径里处理
    if (/^https?:\/\//i.test(n))
        return false;
    if (/^[A-Za-z]:[\\/]/.test(n))
        return true; // C:\... C:/...
    if (/^~[\\/]/.test(n))
        return true; // ~/.dsh/...
    if (/^\$\{?[A-Za-z_]/.test(n))
        return true; // $env:TEMP / ${VAR}
    if (/^[\\/](?!\/)[^\\/]+[\\/]/.test(n))
        return true; // /c/x/y 两段起
    if (/^\.{1,2}\/.+/.test(n))
        return true; // ./x ../x(显式相对)
    if (/^\.[\w-]+\/[^/]+/.test(n))
        return true; // .agents/skills(点开头目录+分隔)
    if (/\.(md|json|ya?ml|ts|tsx|js|jsx|py|sh|ps1|db|tgz|zip|png|svg|lock|log|txt|toml|ini|env|sql|exe|dll|node)$/i.test(n))
        return true;
    // 多级正斜杠/反斜杠且各段像文件名
    if (/^[\w.@-]+([\\/][\w.@-]+){2,}$/.test(n))
        return true;
    if (/\/$/.test(n) && n.length > 2)
        return true; // gui/ 目录形态
    return false;
}
/**
 * 泛称/角色判定(大小写不敏感;限定名 用户@DSH 不在此列——调用方先 splitQualified 取 base)。
 *
 * 三条腿(实测泛称不止裸词,组合写法同样指"某类角色"而非某个实体):
 * 1. 精确命中词表;
 * 2. 前缀式:以词表词开头、剩余 ≤8 字(用户/AI协作、用户沟通偏好与背景、AI执行代理);
 * 3. 后缀式:以词表词结尾、前缀 ≤8 字(全栈开发者、项目主导者、自动化Agent、开发团队)。
 * 词长 ≥2 才允许走 2/3(单字词太泛,防误伤"A项目");判定只作用于 person/organization
 * 的建节点准入,tool/project/place 不受影响,误伤面天然收窄。
 */
export function isRoleName(name) {
    const n = name.trim().toLowerCase();
    if (!n)
        return false;
    if (n.includes('@'))
        return false; // 带限定符 = 已语境化,不是裸泛称
    if (GRAPH_ROLE_SET.has(n))
        return true;
    // 残段是否仍是"角色语言":含另一词表词(用户/AI协作)→ 泛称组合;
    // 纯标点剥离后带拉丁/数字指称(团队A、项目B3)→ 具体名,放行。
    const residualIsRole = (r) => {
        const rr = r.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        if (!rr)
            return true;
        if (GRAPH_ROLE_WORDS.some((w) => rr.includes(w.toLowerCase())))
            return true;
        return !/[a-z0-9]/.test(rr);
    };
    for (const w of GRAPH_ROLE_WORDS) {
        const lw = w.toLowerCase();
        if (lw.length < 2)
            continue;
        if (n.startsWith(lw) && n.length - lw.length <= 8 && residualIsRole(n.slice(lw.length)))
            return true;
        if (n.endsWith(lw) && n.length - lw.length <= 8 && residualIsRole(n.slice(0, n.length - lw.length)))
            return true;
    }
    return false;
}
/** 描述性短语判定:像一句话而不是名字(含谓语/数量变化/从句,或超长)。 */
export function isDescriptiveName(name) {
    const n = name.trim();
    if (n.length > 40)
        return true;
    // 动作/谓词句:确认/执行/发起/审批/排/降至/下降/导致/修复 等
    if (/(确认|执行|发起|审批|核准|驳回|降至|升高|下降|导致|修复了|完成了|将由|需要|应该|禁止)/.test(n))
        return true;
    if (/^\d|\d+(%|倍|个|条|次|行|ms|s|天)/.test(n) && /[排降至升]|#\d/.test(n))
        return true;
    // 榜单/快照读数:"PerryLink 排 #12"、"下载量 3,456"——是时刻读数不是名字
    if (/#[\d,]+|排\s*#?\d|下降|上升|增长|减少/.test(n))
        return true;
    return false;
}
/**
 * 名字形态归类(判定顺序:路径 → 泛称 → 描述 → 专名)。
 *
 * 泛称在描述之前:词表命中是精确证据,"含动词字面"只是弱启发——
 * "当前执行会话""执行分析的助手"这类组合泛称若先过描述闸会被误判成句子,
 * 而它们在 apply 通道(isRoleName 准入)本就按泛称丢弃,两处判定必须同向。
 */
export function classifyNameKind(name) {
    if (isPathLike(name))
        return 'path';
    if (isRoleName(name))
        return 'role';
    if (isDescriptiveName(name))
        return 'descriptive';
    return 'proper';
}
/**
 * 限定名拆分:`用户@DSH` → { base: 用户, qualifier: DSH }。
 * 取最后一个 @(@ 不在 normalizeEntityName 的剥离集里,归一后限定符保持可辨);
 * 首位 @(@drscrewdriver 是专名拼写)不算限定符。
 */
export function splitQualified(name) {
    const n = name.trim();
    const i = n.lastIndexOf('@');
    if (i <= 0)
        return { base: n }; // 无 @ 或首位 @(专名拼写)
    if (i === n.length - 1)
        return { base: n.slice(0, i).trim() }; // 尾部悬 @(写法残缺)剥掉
    return { base: n.slice(0, i).trim(), qualifier: n.slice(i + 1).trim() || undefined };
}
/** 拼限定名(限定符为空原样返回)。 */
export function qualifyName(base, qualifier) {
    const b = base.trim();
    if (!qualifier || !qualifier.trim())
        return b;
    return b + '@' + qualifier.trim();
}
/**
 * 别名准入:别名只收"同一实体的写法变体"。
 * 拒:路径(那是另一个实体)、描述性短语(那是 fact)、超 40 字的从句。
 */
export function isAliasShaped(alias) {
    if (!alias.trim())
        return false;
    if (isPathLike(alias))
        return false;
    if (isDescriptiveName(alias))
        return false;
    return true;
}
/** 概念分类猜测(名称词根 → 六档;命中不了 other,不拒——分类弱、名字强)。 */
export function classifyConceptCategory(name) {
    const n = name.normalize('NFKC').toLowerCase();
    if (/第一性|定律|定理|悖论|假说|原则/.test(n))
        return 'principle'; // 强词先行,防"原理"泛词截胡
    if (/算法|compression|压缩|编码|分词|tokenizer|索引|融合|加密|哈希|排名|检索/.test(n))
        return 'algorithm';
    if (/机制|原理|管线|pipeline|流程|回路|链路|通道/.test(n))
        return 'mechanism';
    if (/规范|标准|约定|门禁|口径|守则|纪律|checklist|清单/.test(n))
        return 'spec';
    if (/模式|范式|pattern|架构|风格|模板|范式/.test(n))
        return 'pattern';
    return 'other';
}
/** 概念分类归一:非法/缺失 → 词根猜测 → other(三级兜底,永不整条拒)。 */
export function clampConceptCategory(value, name) {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (GRAPH_CONCEPT_CATEGORY_SET.has(v))
        return v;
    return classifyConceptCategory(name);
}
