/**
 * 路径安全校验(文件层加固 T5 / G5)。
 *
 * 校验三件事,违例一律**拒绝**(不是笼统的 ENOENT):
 * 1. 父目录存在且是**真实目录**(不是 symlink、不是文件);
 * 2. 目标若存在,必须是**普通文件**(不是目录 / symlink / fifo);
 * 3. 目标自身也不是 symlink。
 *
 * 意义:状态文件都在数据目录里,若其中某一级被换成 symlink(或目标被换成指向
 * 别处的链接),写操作就会被引导到非预期位置——轻则写到别处、重则覆盖无关文件。
 * `atomicWriteText` 的 rename 也会**跟随** symlink 把 tmp 搬到链接目标上。
 *
 * 语义对齐 `refer-memorax-code` 的 `checkStoragePath`,实现独立(不复制其代码)。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
export class UnsafePathError extends Error {
    file;
    violation;
    constructor(file, violation, detail) {
        super(`拒绝访问不安全的路径[${violation}]: ${file}${detail ? ` — ${detail}` : ''}` +
            ` (父目录必须是真实目录,目标必须是普通文件)`);
        this.file = file;
        this.violation = violation;
        this.name = 'UnsafePathError';
    }
}
const isSymlink = (st) => st.isSymbolicLink();
/** 父目录:必须存在、是目录、且不是 symlink。 */
async function checkParent(dir) {
    let st;
    try {
        st = await fs.lstat(dir);
    }
    catch (err) {
        // 父目录不存在:首次写是合法的(写侧 ensureDir 会创建它),不算安全违例。
        // 交给写侧 ensureDir / 读侧 readFile 的 ENOENT 处理。
        if (err?.code === 'ENOENT')
            return;
        throw err;
    }
    if (isSymlink(st))
        throw new UnsafePathError(dir, 'parent-symlink');
    if (!st.isDirectory())
        throw new UnsafePathError(dir, 'parent-not-dir');
}
/**
 * 校验目标路径。父目录不存在时**不报错**(首次写是合法的)。
 * @throws {UnsafePathError} 三类违例
 */
export async function assertSafePath(file) {
    const dir = path.dirname(file);
    await checkParent(dir);
    let st;
    try {
        st = await fs.lstat(file);
    }
    catch (err) {
        const code = err?.code;
        if (code === 'ENOENT')
            return; // 目标不存在:合法(首次写)
        throw err;
    }
    if (isSymlink(st))
        throw new UnsafePathError(file, 'target-symlink');
    if (!st.isFile())
        throw new UnsafePathError(file, 'target-not-file');
}
/** win32 语义提示:junction / reparse point 在 lstat 下的表现(结论见 findings)。 */
export const WIN32_REPARSE_NOTE = 'win32:junction(目录联接)与 symlink 在 Node 的 lstat 里都报 isSymbolicLink()=true,' +
    '都会被本校验拒绝;普通 reparse point(如 OneDrive 占位符)不是链接,不受影响。';
