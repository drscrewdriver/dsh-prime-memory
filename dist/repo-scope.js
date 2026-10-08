/**
 * repo 归属派生(治理升级 Wave 1,T1.7 / O-3)。
 *
 * repoKey = **basename(归一 cwd)**。ADR-0009 三铁律的 repo 轴复刻:
 * - **纯字符串**:输入是归一后的路径字符串,输出是它的末段——不碰 fs、无 I/O;
 * - **同步、不抛**:任何异常/缺失形态一律回落 `''`(=不围栏,与 `global` 同义的
 *   fail-open),绝不因 repo 识别失败阻断写入(I-23 同向);
 * - **单一入口**:归一复用 `normalizeWorkspacePath`(与 workspaceId 同一规范形态),
 *   basename 是其上的**纯派生**——同一 cwd 恒得同一 repoKey。
 *
 * 刻意的边界(P0-6):**不用 git**。git remote 识别是子进程+async+抛+fs,
 * 正面违反 ADR-0009 且属 P2 未解锁项;同名不同仓的两个 clone 会共享 repoKey,
 * 这是 cwd 派生的已知代价,由 `repo_key_owner`(人工标注,仅消歧)弥补。
 */
import { normalizeWorkspacePath } from './workspace.js';
/**
 * 从原始 cwd 派生 repoKey。`raw` 为空/非法/归一后为空 → `{ repoKey: '' }`。
 *
 * @example
 * resolveRepoScope('E:\\test\\rewrite-agently') // → { repoKey: 'rewrite-agently', source: 'cwd' }
 * resolveRepoScope(undefined)                    // → { repoKey: '', source: 'cwd' }
 */
export function resolveRepoScope(raw) {
    // 归一形态与 workspaceId 完全一致(Windows 转小写、resolve 掉 .. 等),
    // 保证"同一工作区"在两个轴上不会因拼写差异劈叉。
    const normalized = normalizeWorkspacePath(raw);
    if (!normalized)
        return { repoKey: '', source: 'cwd' };
    // 归一化路径分隔符取末段;归一形态已把 `\` 规范为 `/`(normalizeWorkspacePath 契约),
    // 这里两种分隔符都容忍,纯字符串操作零异常面。
    const segments = normalized.split(/[\\/]/).filter((s) => s.length > 0);
    return { repoKey: segments[segments.length - 1] ?? '', source: 'cwd' };
}
/** applicability 合法词表(T1.10):'' = 未声明 = 不围栏。 */
export const APPLICABILITY_VALUES = ['', 'this-repo', 'cross-project'];
/**
 * applicability 归一(P0-10 纪律:Schema.string 落库 + 消费侧归一,非法落默认不抛)。
 * 未声明/非法 → ''(不围栏)——宁可漏围栏,不可误围栏(P0-7:围栏错伤跨项目 SOP
 * 与"减污染非取消复用"的目标相反)。
 */
export function normApplicability(raw) {
    return raw === 'this-repo' || raw === 'cross-project' ? raw : '';
}
