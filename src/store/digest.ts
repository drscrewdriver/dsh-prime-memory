/**
 * 内容指纹**单源**(计划 T4.1)。
 *
 * ## 为什么必须单源
 * Phase 1-3 里同一件事有两份实现:
 * - `ext-memory/util.ts#recordDigest` = sha256(空白折叠+小写内容 \0 type);
 * - `store/memory-md.ts#recordDigest` = sha1(NFKC 归一内容)[:16]。
 * 同一段正文在影子表与 md 账本里算出**不同的串**——"双 digest 一致性"就无从谈起,
 * 三侧(db/file/remote)裁决会在第一步比指纹时失真。
 *
 * ## 三个口径的分工(别合并错)
 * - `sha256Hex` / `normContentKey` / `contentOnlyDigest`:三侧可比的**内容指纹**
 *   (不含 type,因为远端条目没有本地 type 语义);
 * - `contentDigest(rec)`:库侧记录指纹 = 内容指纹 + type——库内"记录变了没有"的判据
 *   (同内容不同类型就是不同的记忆,这是库的语义而非外部的语义)。
 *
 * ## 为什么不动 md 的 `digest()`
 * `store/memory-md.ts#digest` 是**文件面**哈希(frontmatter 的 `hash` 键、渲染/校验
 * 两端锁死),并且锚定 memport TS↔Python 金标准(`tests/memport-ts-consistency`)。
 * 它是"正文文件有没有被手改"的回答,不是三侧裁决的输入——留在原处,只在 md 账本的
 * **库侧指纹**上改用本文件。存量账本的 dbDigest 因此一次性失配 → 首轮全部判
 * "只库变"重写一遍文件(渲染幂等,内容不变),这是可接受的一次自愈成本。
 */
import { createHash } from 'node:crypto';

/** 内容归一:折叠空白 + trim + 小写(retire-journal / 影子表 / md 账本同一口径)。 */
export function normContentKey(content: string): string {
  return content.replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

/** sha256 hex(单一入口,digest/tombstone 同构风格)。 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 三侧可比的**纯内容**指纹(db / file / remote 都用它;不含 type)。 */
export function contentOnlyDigest(content: string): string {
  return sha256Hex(normContentKey(content));
}

/**
 * 库侧记录指纹:内容指纹 + type(不传 type = 纯内容指纹)。
 * 同一实现,两处语义靠参数区分——这是"单源"的关键:算法只有一份,口径差异显式化。
 */
export function contentDigest(rec: { content: string; type?: string | undefined }): string {
  return sha256Hex(`${normContentKey(rec.content)}\u0000${(rec.type ?? '').toLowerCase()}`);
}
