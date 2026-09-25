export type PathViolation = 'parent-not-dir' | 'parent-symlink' | 'target-symlink' | 'target-not-file';
export declare class UnsafePathError extends Error {
    readonly file: string;
    readonly violation: PathViolation;
    constructor(file: string, violation: PathViolation, detail?: string);
}
/**
 * 校验目标路径。父目录不存在时**不报错**(首次写是合法的)。
 * @throws {UnsafePathError} 三类违例
 */
export declare function assertSafePath(file: string): Promise<void>;
/** win32 语义提示:junction / reparse point 在 lstat 下的表现(结论见 findings)。 */
export declare const WIN32_REPARSE_NOTE: string;
