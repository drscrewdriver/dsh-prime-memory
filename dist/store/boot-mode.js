/**
 * 启动挡位（bootMode: on/off/last）的插件侧权威存储。
 *
 * 为什么要插件自己存一份（而不是只依赖 live volatile 节落盘）：
 * 真机取证（.agents/plans/prime-switch-tui-rc/findings.md F5）——`dsh-memory` 的
 * `live` 节里 memoryMutate / conflictFreeze 等**旧键**能稳定落盘，而 v0.27.0 才新增的
 * `bootMode` 键在 11-12→11-26 整段 profile 备份里 **0 次出现**。唯一自洽解释是宿主
 * `forms.update` 按它缓存的 entry schema 剪枝，把不在该快照里的新键丢弃——于是
 * applyBootMode 每次启动都读回默认 'off'（或 last 语义丢失），用户「选了下次关闭却不生效」。
 *
 * 对策：把挡位写进插件数据目录的 `boot-mode.json`，读侧以本文件为准，彻底绕开宿主
 * 对新 volatile 键的不持久化。`enabled` 本身是旧键、宿主能落盘，所以「本会话手动开关」
 * 仍走 volatile；本文件只承载「下次启动初值」这一个语义。存储不可写时降级为内存态
 * （本进程有效、重启回落），与插件既有存储降级不变量一致。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { errDetail } from '../util/filelog.js';
import { atomicWriteJson } from '../util/io.js';
const VALID = ['on', 'off', 'last'];
export function isBootMode(v) {
    return typeof v === 'string' && VALID.includes(v);
}
export class BootModeStore {
    logger;
    file;
    mode;
    /** 串行化写，避免并发原子写撞临时文件名（同 SessionModeStore 惯例）。 */
    writeChain = Promise.resolve();
    constructor(dataDir, logger) {
        this.logger = logger;
        this.file = path.join(dataDir, 'boot-mode.json');
        try {
            if (fs.existsSync(this.file)) {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (isBootMode(raw?.bootMode))
                    this.mode = raw.bootMode;
            }
        }
        catch (err) {
            // 读失败不阻断启动：mode 保持 undefined，读侧回落 volatile 值。
            this.logger?.warn(`[memory] boot-mode.json 载入失败(忽略，按 volatile 挡位): ${errDetail(err)}`);
        }
    }
    /** 权威挡位；未落盘过返回 undefined（调用方回落 volatile / 出厂默认）。 */
    get() {
        return this.mode;
    }
    async set(mode) {
        if (!isBootMode(mode))
            return;
        if (this.mode === mode)
            return; // 同值免写，避免每次启动/每次面板保存都落一次盘
        this.mode = mode;
        this.writeChain = this.writeChain.then(() => atomicWriteJson(this.file, { bootMode: mode, setAt: Date.now() }).catch((err) => {
            this.logger?.warn(`[memory] boot-mode.json 写入失败(内存态仍生效): ${errDetail(err)}`);
        }));
        await this.writeChain;
    }
}
