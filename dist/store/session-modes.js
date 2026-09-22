/**
 * 会话记忆档位存储:sessionId → MemoryMode 的持久化映射。
 * 热路径(捕获 turn/end、召回 pre-step、工具 execute)需要同步读取,
 * 因此 init() 一次性载入内存 Map,set() 写穿。
 * 存储失败只降级为内存态(warn 不崩),与插件的存储降级不变量一致。
 */
import * as path from 'node:path';
import { HALL_CATALOG } from '../types.js';
import { normalizeHallWeights } from '../domain-gate.js';
import { errDetail } from '../util/filelog.js';
import { atomicWriteJson, ensureDir, readJsonIfExists } from '../util/io.js';
const MODES = ['auto', 'chat', 'work', 'off'];
const PRUNE_MS = 90 * 24 * 3600_000;
const MAX_ENTRIES = 500;
export function isMemoryMode(v) {
    return typeof v === 'string' && MODES.includes(v);
}
/** 合法角 id 判定(锁域只认 8 角;general 是兜底值不是角,不可锁定)。 */
export function isHallCorner(v) {
    return typeof v === 'string' && HALL_CATALOG.some((h) => h.id === v);
}
export class SessionModeStore {
    defaultMode;
    logger;
    file;
    entries = new Map();
    loaded;
    persistFailed = false;
    /** 档位切换回调(index.ts 装配 runner 的同步动作:切片落袋/挂起,ADR-0003)。 */
    onModeChange;
    /** 串行化持久化写(避免并发原子写撞临时文件名)。 */
    writeChain = Promise.resolve();
    constructor(dataDir, defaultMode, logger) {
        this.defaultMode = defaultMode;
        this.logger = logger;
        this.file = path.join(dataDir, 'session-modes.json');
        this.loaded = defaultMode;
    }
    /** 载入持久化映射(index.ts 启动时 await;失败降级内存态)。 */
    async init() {
        const data = await readJsonIfExists(this.file);
        if (!data?.sessions || typeof data.sessions !== 'object')
            return;
        const now = Date.now();
        let count = 0;
        for (const [sid, entry] of Object.entries(data.sessions)) {
            if (!isMemoryMode(entry?.mode))
                continue;
            if (now - (entry.updatedAt ?? 0) > PRUNE_MS)
                continue;
            this.entries.set(sid, {
                mode: entry.mode,
                // 非布尔视为损坏丢弃(= 跟随全局);旧文件无此键同款兼容
                recall: typeof entry.recall === 'boolean' ? entry.recall : undefined,
                // 域锁定只认 8 角 id;非法/缺省 = 中心(智能档)。多选数组优先,单值键兜底
                hall: isHallCorner(entry.hall) ? entry.hall : undefined,
                halls: Array.isArray(entry.halls)
                    ? Array.from(new Set(entry.halls.filter((x) => isHallCorner(x))))
                    : isHallCorner(entry.hall)
                        ? [entry.hall]
                        : undefined,
                hallIncludeUnlabeled: typeof entry.hallIncludeUnlabeled === 'boolean' ? entry.hallIncludeUnlabeled : undefined,
                hallIncludeGeneral: typeof entry.hallIncludeGeneral === 'boolean' ? entry.hallIncludeGeneral : undefined,
                // 域权重只认 8 角 id 且 clamp 到 [0,1.5];全非法/空 → undefined(无用户偏置)
                hallWeights: normalizeHallWeights(entry.hallWeights),
                updatedAt: entry.updatedAt ?? now,
            });
            count++;
        }
        if (count > 0)
            this.logger?.info(`[memory] 会话档位载入 ${count} 条(默认档=${this.defaultMode})`);
    }
    get default() {
        return this.loaded;
    }
    /** 同步读取:未设置过的会话返回默认档。 */
    get(sessionId) {
        return this.entries.get(sessionId)?.mode ?? this.loaded;
    }
    /**
     * 该会话是否有**显式**档位条目(区别于 `get()` 的默认档回落)。
     *
     * 子代理档位继承(§A)靠它判断"这一层是否设过":未设过则继续沿父链上溯,
     * 而不是立刻吃默认档——后者正是"用户显式 off 被绕过"的成因。
     */
    hasEntry(sessionId) {
        return this.entries.has(sessionId);
    }
    /** 会话级注入覆盖原始值:undefined = 未覆盖,跟随全局。 */
    getRecall(sessionId) {
        return this.entries.get(sessionId)?.recall;
    }
    /** 解析后的注入开关:会话覆盖 ?? 全局运行时开关(部署级 cfg.recall.enabled
     *  与主闸 s.enabled 不经此处,仍按既有硬门生效——覆盖打不穿部署上限)。 */
    resolvedRecall(sessionId, globalRecall) {
        return this.entries.get(sessionId)?.recall ?? globalRecall;
    }
    /** 设置会话级注入覆盖(undefined = 清除覆盖跟随全局。写穿持久化)。 */
    setRecall(sessionId, recall) {
        const entry = this.entries.get(sessionId);
        this.entries.set(sessionId, {
            mode: entry?.mode ?? this.loaded,
            recall,
            // 域锁定与注入正交:设置注入不动锁域(照抄"切档不动覆盖"模板)
            hall: entry?.hall,
            halls: entry?.halls,
            hallIncludeUnlabeled: entry?.hallIncludeUnlabeled,
            hallIncludeGeneral: entry?.hallIncludeGeneral,
            // 域权重与注入/档位正交:设置注入或切档都不动权重(照抄"切档不动覆盖"模板)
            hallWeights: entry?.hallWeights,
            updatedAt: Date.now(),
        });
        this.writeChain = this.writeChain.then(() => this.persist());
    }
    /** 会话级域锁定(多选):空数组 = 中心(智能档,无锁域)。 */
    getHalls(sessionId) {
        const e = this.entries.get(sessionId);
        if (e?.halls && e.halls.length > 0)
            return e.halls;
        return e?.hall ? [e.hall] : [];
    }
    /** 兼容读取(单选口径,取第一个锁定域):undefined = 中心。 */
    getHall(sessionId) {
        return this.getHalls(sessionId)[0];
    }
    /** 锁定域边界开关:未打标是否包含(缺省 true)/ general 是否包含(缺省 false)。 */
    hallBoundaries(sessionId) {
        const e = this.entries.get(sessionId);
        return {
            includeUnlabeled: e?.hallIncludeUnlabeled ?? true,
            includeGeneral: e?.hallIncludeGeneral ?? false,
        };
    }
    /** 会话级域权重(拖动角点产物):角 id → 权重。未拖过任何角 = 空对象(无偏置)。 */
    getHallWeights(sessionId) {
        return { ...(this.entries.get(sessionId)?.hallWeights ?? {}) };
    }
    /** 设置会话级域权重(全量替换;null/空 = 清除偏置回中性。写穿持久化)。
     *  与锁域/注入/档位正交:此处不动 hall/halls/recall/mode。 */
    setHallWeights(sessionId, weights) {
        const entry = this.entries.get(sessionId);
        this.entries.set(sessionId, {
            mode: entry?.mode ?? this.loaded,
            recall: entry?.recall,
            hall: entry?.hall,
            halls: entry?.halls,
            hallIncludeUnlabeled: entry?.hallIncludeUnlabeled,
            hallIncludeGeneral: entry?.hallIncludeGeneral,
            // 全量替换:null/空/全非法 → undefined(回中性,不写盘)
            hallWeights: normalizeHallWeights(weights) ?? undefined,
            updatedAt: Date.now(),
        });
        this.writeChain = this.writeChain.then(() => this.persist());
    }
    /** 设置会话级域锁定(多选:角 id 数组;空数组/undefined = 回中心清除锁定。写穿持久化)。
     *  单角时镜像写 `hall` 兼容键,多角时置空(旧读者按无锁域读)。 */
    setHall(sessionId, halls, boundaries) {
        const entry = this.entries.get(sessionId);
        const locked = Array.from(new Set((halls ?? []).filter((x) => isHallCorner(x))));
        this.entries.set(sessionId, {
            mode: entry?.mode ?? this.loaded,
            recall: entry?.recall,
            hall: locked.length === 1 ? locked[0] : undefined,
            halls: locked.length > 0 ? locked : undefined,
            hallIncludeUnlabeled: boundaries?.includeUnlabeled ?? entry?.hallIncludeUnlabeled,
            hallIncludeGeneral: boundaries?.includeGeneral ?? entry?.hallIncludeGeneral,
            // 锁域与权重正交:锁角走硬过滤,权重留着(回中心后继续生效)
            hallWeights: entry?.hallWeights,
            updatedAt: Date.now(),
        });
        this.writeChain = this.writeChain.then(() => this.persist());
    }
    /** 注册档位切换回调(同步调用;回调异常只记日志不阻断写穿)。 */
    setModeChangeHandler(cb) {
        this.onModeChange = cb;
    }
    /** 设置会话档位(写穿持久化;持久化失败保持内存态生效)。 */
    set(sessionId, mode) {
        const old = this.get(sessionId);
        // 已有注入覆盖跨切档保留(档位与注入正交,切档不动覆盖);
        // 域锁定同语义:跨切档保留
        const entry = this.entries.get(sessionId);
        this.entries.set(sessionId, {
            mode,
            recall: entry?.recall,
            hall: entry?.hall,
            halls: entry?.halls,
            hallIncludeUnlabeled: entry?.hallIncludeUnlabeled,
            hallIncludeGeneral: entry?.hallIncludeGeneral,
            // 域权重与注入/档位正交:设置注入或切档都不动权重(照抄"切档不动覆盖"模板)
            hallWeights: entry?.hallWeights,
            updatedAt: Date.now(),
        });
        this.writeChain = this.writeChain.then(() => this.persist());
        if (old !== mode && this.onModeChange) {
            try {
                this.onModeChange(sessionId, old, mode);
            }
            catch (err) {
                this.logger?.warn(`[memory] 档位切换回调失败: ${errDetail(err)}`);
            }
        }
    }
    /** 等待在途持久化写完成(测试/停机用)。 */
    flush() {
        return this.writeChain;
    }
    async persist() {
        try {
            await ensureDir(path.dirname(this.file));
            await atomicWriteJson(this.file, this.serialize());
            this.persistFailed = false;
        }
        catch (err) {
            if (!this.persistFailed) {
                this.persistFailed = true;
                this.logger?.warn(`[memory] 会话档位持久化失败(降级内存态): ${errDetail(err)}`);
            }
        }
    }
    serialize() {
        const now = Date.now();
        // 超期清理 + 条数上限(按 updatedAt 淘汰最旧)
        for (const [sid, e] of this.entries) {
            if (now - e.updatedAt > PRUNE_MS)
                this.entries.delete(sid);
        }
        while (this.entries.size > MAX_ENTRIES) {
            let oldest;
            let oldestAt = Infinity;
            for (const [sid, e] of this.entries) {
                if (e.updatedAt < oldestAt) {
                    oldest = sid;
                    oldestAt = e.updatedAt;
                }
            }
            if (oldest === undefined)
                break;
            this.entries.delete(oldest);
        }
        const sessions = {};
        for (const [sid, e] of this.entries)
            sessions[sid] = e;
        return { version: 1, sessions };
    }
}
