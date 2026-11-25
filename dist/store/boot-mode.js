/**
 * 启动挡位的插件侧权威存储（两轴：注入 injectBootMode / 提取 extractBootMode）。
 *
 * 为什么要插件自己存（而不是只依赖 live volatile 节落盘）：
 * 真机取证（.agents/plans/prime-switch-tui-rc/findings.md F5）——`dsh-memory` 的
 * `live` 节里 memoryMutate / capture 等**旧键**能稳定落盘，而 v0.27.0 才新增的
 * `bootMode` 键在 11-12→11-26 整段 profile 备份里 **0 次出现**。宿主 `forms.update`
 * 按它缓存的 entry schema 剪枝，把不在快照里的新键丢弃——于是启动挡位永不生效。
 *
 * 对策：把两轴挡位写进插件数据目录的 `boot-mode.json`，读侧以本文件为准，彻底绕开
 * 宿主对新 volatile 键的不持久化。`recall` / `capture` / `distill` 本身是旧键、宿主能
 * 落盘，所以"本会话即时开关"仍走 volatile；本文件只承载"下次启动初值"这一个语义。
 * 存储不可写时降级为内存态（本进程有效、重启回落），与插件既有存储降级不变量一致。
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
    modes = {};
    /** 串行化写，避免并发原子写撞临时文件名（同 SessionModeStore 惯例）。 */
    writeChain = Promise.resolve();
    constructor(dataDir, logger) {
        this.logger = logger;
        this.file = path.join(dataDir, 'boot-mode.json');
        try {
            if (fs.existsSync(this.file)) {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (isBootMode(raw?.inject))
                    this.modes.inject = raw.inject;
                if (isBootMode(raw?.extract))
                    this.modes.extract = raw.extract;
            }
        }
        catch (err) {
            // 读失败不阻断启动：两轴保持 undefined，读侧回落 volatile 值。
            this.logger?.warn(`[memory] boot-mode.json 载入失败(忽略，按 volatile 挡位): ${errDetail(err)}`);
        }
    }
    /** 权威挡位；未落盘过返回 undefined（调用方回落 volatile / 出厂默认）。 */
    get(axis) {
        return this.modes[axis];
    }
    async set(axis, mode) {
        if (!isBootMode(mode))
            return;
        if (this.modes[axis] === mode)
            return; // 同值免写
        this.modes[axis] = mode;
        const snapshot = { inject: this.modes.inject, extract: this.modes.extract };
        this.writeChain = this.writeChain.then(() => atomicWriteJson(this.file, { ...snapshot, setAt: Date.now() }).catch((err) => {
            this.logger?.warn(`[memory] boot-mode.json 写入失败(内存态仍生效): ${errDetail(err)}`);
        }));
        await this.writeChain;
    }
}
