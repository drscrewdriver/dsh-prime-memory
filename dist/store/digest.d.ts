/** 内容归一:折叠空白 + trim + 小写(retire-journal / 影子表 / md 账本同一口径)。 */
export declare function normContentKey(content: string): string;
/** sha256 hex(单一入口,digest/tombstone 同构风格)。 */
export declare function sha256Hex(value: string): string;
/** 三侧可比的**纯内容**指纹(db / file / remote 都用它;不含 type)。 */
export declare function contentOnlyDigest(content: string): string;
/**
 * 库侧记录指纹:内容指纹 + type(不传 type = 纯内容指纹)。
 * 同一实现,两处语义靠参数区分——这是"单源"的关键:算法只有一份,口径差异显式化。
 */
export declare function contentDigest(rec: {
    content: string;
    type?: string | undefined;
}): string;
