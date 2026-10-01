export type RepoScopeSource = 'cwd';
export interface RepoScope {
    /** '' = 识别失败/无 cwd = 不围栏(fail-open,绝不抛)。 */
    repoKey: string;
    source: RepoScopeSource;
}
/**
 * 从原始 cwd 派生 repoKey。`raw` 为空/非法/归一后为空 → `{ repoKey: '' }`。
 *
 * @example
 * resolveRepoScope('E:\\test\\rewrite-agently') // → { repoKey: 'rewrite-agently', source: 'cwd' }
 * resolveRepoScope(undefined)                    // → { repoKey: '', source: 'cwd' }
 */
export declare function resolveRepoScope(raw: unknown): RepoScope;
/** applicability 合法词表(T1.10):'' = 未声明 = 不围栏。 */
export declare const APPLICABILITY_VALUES: readonly ["", "this-repo", "cross-project"];
export type RecordApplicability = (typeof APPLICABILITY_VALUES)[number];
/**
 * applicability 归一(P0-10 纪律:Schema.string 落库 + 消费侧归一,非法落默认不抛)。
 * 未声明/非法 → ''(不围栏)——宁可漏围栏,不可误围栏(P0-7:围栏错伤跨项目 SOP
 * 与"减污染非取消复用"的目标相反)。
 */
export declare function normApplicability(raw: unknown): RecordApplicability;
