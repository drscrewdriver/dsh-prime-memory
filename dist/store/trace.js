/**
 * §F 结构化追踪(memorax-absorb Wave 4 / task_28)——recall/distill 事件流。
 *
 * 模块级单例(token-cost.ts 同款):trace() 埋点拿不到 store 实例(store 在
 * index.ts 运行时才有 dataDir),initTraceStore 启动时注入;未初始化或
 * trace.enabled=false 时 trace() 为零副作用 no-op。
 *
 * 存储:按天 JSONL(`dataDir/trace/trace-YYYY-MM-DD.jsonl`,appendJsonl 原语),
 * 文件名即日期 → 保留期清理在切日时触发(删除超 retentionDays 的旧文件);
 * 单文件 >5MB 停写 + 写入一行 trace_truncated marker(防无限增长);
 * 写失败静默(filelog 同款纪律——追踪绝不影响主链路)。
 *
 * 隐私默认 metadata-only:recall 事件只带 queryChars+querySha,
 * captureContent=true 才存 queryText(截断 200)——由埋点方决定字段,本模块不感知。
 */
import fs from 'node:fs';
import path from 'node:path';
import { appendJsonl, dayKey, readJsonl } from '../util/io.js';
const TRACE_DIR = 'trace';
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export class TraceStore {
    dataDir;
    opts;
    /** 已停写的日期(5MB 上限触发;当日内后续事件丢弃,次日自动恢复)。 */
    truncatedDays = new Set();
    lastPruneDay = '';
    chain = Promise.resolve();
    constructor(dataDir, opts) {
        this.dataDir = dataDir;
        this.opts = opts;
    }
    /** 追加事件(异步串行链,失败静默)。 */
    append(event) {
        const day = dayKey(event.ts);
        if (this.truncatedDays.has(day))
            return;
        this.chain = this.chain
            .then(() => this.writeOne(day, event))
            .catch(() => {
            /* 静默:追踪失败不影响主链路 */
        });
    }
    /** 等待挂起的写入排空(dispose 序用)。 */
    flush() {
        return this.chain;
    }
    /**
     * 尾部读取:从最近的日期文件倒序收集,按 kind 过滤,返回至多 `lines` 条
     * (按写入顺序 = 时间升序)。坏行跳过(readJsonl 同款)。
     */
    async tail(lines, kind) {
        const limit = Math.max(1, Math.min(500, Math.round(lines) || 100));
        const files = this.recentFiles();
        const collected = [];
        for (let i = files.length - 1; i >= 0 && collected.length < limit; i--) {
            const rows = await readJsonl(files[i]);
            for (let j = rows.length - 1; j >= 0 && collected.length < limit; j--) {
                const row = rows[j];
                if (!row || typeof row !== 'object' || !row.kind)
                    continue;
                if (kind && row.kind !== kind)
                    continue;
                collected.push(row);
            }
        }
        return collected.reverse();
    }
    dir() {
        return path.join(this.dataDir, TRACE_DIR);
    }
    fileFor(day) {
        return path.join(this.dir(), `trace-${day}.jsonl`);
    }
    recentFiles() {
        try {
            return fs
                .readdirSync(this.dir())
                .filter((f) => f.startsWith('trace-') && f.endsWith('.jsonl'))
                .sort()
                .map((f) => path.join(this.dir(), f));
        }
        catch {
            return [];
        }
    }
    async writeOne(day, event) {
        if (day !== this.lastPruneDay) {
            this.lastPruneDay = day;
            this.pruneOldDays(day);
        }
        const file = this.fileFor(day);
        try {
            const stat = await fs.promises.stat(file);
            if (stat.size > (this.opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)) {
                this.truncatedDays.add(day);
                await appendJsonl(file, [
                    { kind: 'trace_truncated', ts: event.ts, note: '单日文件超上限,当日停写(次日自动恢复)' },
                ]);
                return;
            }
        }
        catch {
            /* 文件不存在 = 首写,继续 */
        }
        await appendJsonl(file, [event]);
    }
    /** 删除超过保留期的旧日文件(retentionDays 0 = 永久)。 */
    pruneOldDays(today) {
        if (this.opts.retentionDays <= 0)
            return;
        let files;
        try {
            files = fs.readdirSync(this.dir());
        }
        catch {
            return;
        }
        const todayMs = Date.parse(`${today}T00:00:00`);
        for (const f of files) {
            const m = /^trace-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
            if (!m)
                continue;
            const dayMs = Date.parse(`${m[1]}T00:00:00`);
            if (!Number.isFinite(dayMs) || !Number.isFinite(todayMs))
                continue;
            if (todayMs - dayMs > this.opts.retentionDays * 86_400_000) {
                fs.promises.rm(path.join(this.dir(), f), { force: true }).catch(() => { });
            }
        }
    }
}
// ── 模块级单例(token-cost.ts 同款) ──
let store = null;
/** 插件启动时注入(index.ts 调用);enabled=false 或 0 天保留不影响初始化本身。 */
export function initTraceStore(dataDir, opts) {
    store = new TraceStore(dataDir, opts);
}
/** 测试/卸载:清空单例。 */
export function resetTraceStore() {
    store = null;
}
/** 埋点入口:未初始化 = no-op。fire-and-forget,永不抛。 */
export function trace(event) {
    store?.append(event);
}
/** RPC tail 数据源;未初始化返回 undefined(端点回空集)。 */
export function getTraceStore() {
    return store;
}
