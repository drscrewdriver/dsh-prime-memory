/**
 * 管线 checkpoint 状态。持久化在 <dataDir>/state.json。
 *
 * v2 起按族分桶(L2/L3 分族隔离后阈值计数、情境链各自独立);
 * 旧平铺格式(v1)在 load 时整体迁入 chat 桶(历史数据由 chat 档蒸馏产出)。
 *
 * **读侧 fail-closed**(文件层加固 T2/T3):
 * - `version` 既不是 1(含缺失)也不是 2 → **拒绝加载**:不迁移、不覆盖、显式报错。
 *   旧实现把 `version !== 2` 一律当 v1 平铺往 chat 桶里塞(findings §3.1),
 *   未来版本或字段损坏会产出"看起来正常、实际结构错位"的结果;
 * - 文件损坏/不可读 → 同样拒绝加载(而不是"当空态"后回写把原文件洗掉);
 * - 上述两种情形都进入**只读降级**:记忆从默认空态起步,但 `save()` 一律拒绝写。
 *   **不抛出**——插件是增强能力,不该因为一个 checkpoint 文件就让宿主起不来。
 */
import * as path from 'node:path';
import { readJsonStrict, rmwJson } from '../util/io.js';
import { STATE_FILE_VERSION, STATE_FILE_VERSION_LEGACY } from './file-versions.js';
export function defaultState() {
    return {
        lastExtractAt: 0,
        lastSceneName: '',
        totalExtracted: 0,
        newMemoriesSinceL2: 0,
        lastL2At: 0,
        memoriesSinceL3: 0,
        lastL3At: 0,
        hasPersona: false,
    };
}
export class StateStore {
    file;
    logger;
    // 声明即初始化:forFamily 在 load 完成前也安全(stats 面板可能早于 runner.init 拉取)
    buckets = { chat: defaultState(), work: defaultState() };
    migrated = false;
    /** 只读降级原因(非空 = 拒绝加载且禁止回写)。 */
    degradedReason;
    saveBlockedLogged = false;
    /** 本进程上次成功写入的磁盘内容(紧凑 JSON);并发冲突判据。 */
    lastPersisted;
    constructor(file, logger) {
        this.file = file;
        this.logger = logger;
    }
    /**
     * 只读降级原因(undefined = 正常)。
     *
     * 降级时 `forFamily` 仍返回默认空态——记忆功能继续可用(只是丢 checkpoint),
     * 但**绝不回写**,以免把用户磁盘上那份读不懂/已损坏的文件洗掉。
     */
    get degraded() {
        return this.degradedReason;
    }
    async load() {
        // 版本判定**不走** `expectedVersion`:历史 v1 平铺文件根本没有 version 字段,
        // 而按契约"版本缺失"在 expectedVersion 下会被判成 unknown_version——那会把
        // 老用户的文件拒掉。这里要的语义是:**只有 version === 1 或缺失才走 v1 迁移**,
        // 其余(2 走 v2、其它一律拒绝)由下面的分支显式表达。
        const r = await readJsonStrict(this.file);
        if (!r.ok) {
            if (r.reason === 'missing')
                return; // 首次运行,合法
            this.degradedReason = r.reason;
            this.logger?.error(`[memory] state.json ${r.reason === 'corrupt' ? '损坏' : '不可读'} —— 拒绝加载(不迁移、不覆盖),` +
                `记忆从默认空态起步;原文件已保留在 ${this.file},修复或移除后重启即可恢复`);
            return;
        }
        const raw = r.value;
        const v = r.version;
        if (v !== undefined && v !== STATE_FILE_VERSION && v !== STATE_FILE_VERSION_LEGACY) {
            this.degradedReason = `未知版本(${v})`;
            this.logger?.error(`[memory] state.json 版本未知(${v},支持 ${STATE_FILE_VERSION_LEGACY}/${STATE_FILE_VERSION}) —— ` +
                `拒绝加载(不迁移、不覆盖),记忆从默认空态起步;原文件已保留在 ${this.file}`);
            return;
        }
        if (v === STATE_FILE_VERSION && raw.families && typeof raw.families === 'object') {
            // v2:逐族宽容合并(新字段自动带默认值)
            this.buckets = {
                chat: { ...defaultState(), ...(raw.families.chat ?? {}) },
                work: { ...defaultState(), ...(raw.families.work ?? {}) },
            };
        }
        else {
            // v1 平铺(或 version 缺失的历史文件)→ 整体迁入 chat 桶(历史数据是 chat 档蒸馏产出)
            this.buckets = { chat: { ...defaultState(), ...raw }, work: defaultState() };
            this.migrated = true;
        }
    }
    /** v1 → v2 迁移发生时为 true(调用方记日志/落盘)。 */
    get didMigrate() {
        return this.migrated;
    }
    /** 取某族的 checkpoint(活引用——改字段后 save 生效)。 */
    forFamily(family) {
        return this.buckets[family];
    }
    /**
     * 重建用:两族 checkpoint 重置为默认值。
     * 必须原地突变(Object.assign)——runner.states 等处持有桶对象的活引用,
     * 换新对象会让引用指向已废弃的桶,后续计数写到内存孤儿上。
     */
    reset() {
        for (const family of ['chat', 'work']) {
            Object.assign(this.buckets[family], defaultState());
            this.buckets[family].personaRequestedReason = undefined;
        }
    }
    async save() {
        if (this.degradedReason !== undefined) {
            // 降级期禁写:此时内存里是默认空态,写下去就等于把读不懂/已损坏的原文件洗掉。
            // 只告警一次——save() 在管线里是热路径,不能每次都刷一行。
            if (!this.saveBlockedLogged) {
                this.saveBlockedLogged = true;
                this.logger?.warn(`[memory] state.json 处于只读降级(${this.degradedReason}),已跳过回写(原文件保持不变)`);
            }
            return;
        }
        // 锁内 RMW(T4.9):读磁盘 → 判并发 → 写。state 没有 rev 字段,冲突判据是
        // "磁盘内容与本进程上次写入的不同"——双进程(将来的宿主+后端)交替写时,
        // 后写者会看到差异并显式失败,而不是把别人的 checkpoint 静默盖掉。
        await rmwJson(this.file, async (cur) => {
            const diskRaw = cur.ok ? JSON.stringify(cur.value) : undefined;
            if (this.lastPersisted !== undefined && diskRaw !== undefined && diskRaw !== this.lastPersisted) {
                throw new Error(`state.json 已被其它进程更新,本次写入已取消以避免覆盖`);
            }
            const next = { version: STATE_FILE_VERSION, families: this.buckets };
            this.lastPersisted = JSON.stringify(next);
            return { next, result: undefined };
        }, { logger: this.logger, purpose: 'state-rmw' });
    }
    static pathFor(dataDir) {
        return path.join(dataDir, 'state.json');
    }
}
