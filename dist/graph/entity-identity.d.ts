/** 名字形态四分类:专有实体名 / 泛称角色 / 文件路径 / 描述性短语。 */
export type NameKind = 'proper' | 'role' | 'path' | 'descriptive';
/**
 * 路径形态判定:盘符、波浪号家目录、环境变量插值、多级斜杠、常见文件后缀。
 * 注意排除 npm scoped 包名(@scope/pkg 有一级斜杠但是真工具,不是路径)。
 */
export declare function isPathLike(name: string): boolean;
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
export declare function isRoleName(name: string): boolean;
/** 描述性短语判定:像一句话而不是名字(含谓语/数量变化/从句,或超长)。 */
export declare function isDescriptiveName(name: string): boolean;
/**
 * 名字形态归类(判定顺序:路径 → 泛称 → 描述 → 专名)。
 *
 * 泛称在描述之前:词表命中是精确证据,"含动词字面"只是弱启发——
 * "当前执行会话""执行分析的助手"这类组合泛称若先过描述闸会被误判成句子,
 * 而它们在 apply 通道(isRoleName 准入)本就按泛称丢弃,两处判定必须同向。
 */
export declare function classifyNameKind(name: string): NameKind;
/**
 * 限定名拆分:`用户@DSH` → { base: 用户, qualifier: DSH }。
 * 取最后一个 @(@ 不在 normalizeEntityName 的剥离集里,归一后限定符保持可辨);
 * 首位 @(@drscrewdriver 是专名拼写)不算限定符。
 */
export declare function splitQualified(name: string): {
    base: string;
    qualifier?: string;
};
/** 拼限定名(限定符为空原样返回)。 */
export declare function qualifyName(base: string, qualifier?: string): string;
/**
 * 别名准入:别名只收"同一实体的写法变体"。
 * 拒:路径(那是另一个实体)、描述性短语(那是 fact)、超 40 字的从句。
 */
export declare function isAliasShaped(alias: string): boolean;
/** 概念分类猜测(名称词根 → 六档;命中不了 other,不拒——分类弱、名字强)。 */
export declare function classifyConceptCategory(name: string): string;
/** 概念分类归一:非法/缺失 → 词根猜测 → other(三级兜底,永不整条拒)。 */
export declare function clampConceptCategory(value: unknown, name: string): string;
