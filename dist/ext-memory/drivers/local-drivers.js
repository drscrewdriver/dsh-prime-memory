/**
 * 三家本地/CLI 驱动(计划 T1.7-T1.9):holographic(本地 JSON)/ byterover(`brv`
 * CLI)/ mnemon-native(`mnemon` CLI)。同为 Phase 1 只读构建:search/status 真实,
 * 写侧与拉读侧桩(语义见 http-drivers.ts 文件头,同一条纪律)。
 *
 * holographic 的检索语义逐条移植自参考实现:词面 Jaccard + 引号短语 ×0.9 +
 * 实体命中 ×0.8,再乘 trustScore、minTrust 地板——它没有外部服务,分数就是全部
 * 真相,不能含糊。CJK 按字 + 二元组切(与本地 bigram 同思路),词面按 \w+。
 *
 * CLI 两家共用可注入 `ProcessRunner`(契约测试的 mock 位;真身 proc.ts)。
 * mnemon-native 的 `--json` 全局旗与 store 参数形态做成 extra 可配:
 * 本机 mnemon CLI 的确切 CLI 形状无法在此环境实测,配置面留给部署校订,
 * **缺省形态按参考实现 runner 的调用序列**(`recall <q> --limit N` 等)。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { EXT_DRIVER_SPECS } from '../types.js';
import { READ_ONLY_RECEIPT, ExtCapabilityMissingError, clampInt, obj, str, num, arr } from '../util.js';
import { runProcess } from '../proc.js';
const WORD = /[\p{L}\p{N}_-]+/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
function holoTerms(value) {
    const normalized = value.toLocaleLowerCase();
    const out = new Set((normalized.match(WORD) ?? []).filter((t) => t.length > 1));
    for (const run of normalized.match(CJK) ?? []) {
        for (const ch of run)
            out.add(ch);
        for (let i = 0; i < run.length - 1; i++)
            out.add(run.slice(i, i + 2));
    }
    return out;
}
function holoOverlap(left, right) {
    if (left.size === 0 || right.size === 0)
        return 0;
    let shared = 0;
    for (const v of left)
        if (right.has(v))
            shared += 1;
    return shared / new Set([...left, ...right]).size;
}
class HolographicDriver {
    id;
    typeId = 'holographic';
    capabilities = EXT_DRIVER_SPECS.holographic.capabilities;
    scoreSemantics = EXT_DRIVER_SPECS.holographic.scoreSemantics;
    conn;
    constructor(input) {
        this.id = input.id;
        this.conn = input.connection;
    }
    /** store 路径:connection.endpoint 直接当文件路径用(本地档无 URL 语义);缺省落数据目录旁。 */
    storePath(space) {
        const configured = String(this.conn.endpoint ?? '').trim() || String(this.conn.dataPath ?? '').trim();
        if (configured !== '')
            return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
        return path.isAbsolute(space.externalId) ? space.externalId : path.resolve(process.cwd(), space.externalId);
    }
    load(space) {
        const file = this.storePath(space);
        if (!existsSync(file))
            throw new Error(`holographic:${this.id} store not found: ${file}`);
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const root = obj(parsed);
        const facts = Array.isArray(root?.facts) ? root.facts : [];
        return facts.flatMap((v) => {
            const f = obj(v);
            const id = str(f?.id);
            const content = str(f?.content);
            if (id === undefined || content === undefined)
                return [];
            return [{
                    id,
                    content,
                    category: str(f?.category) ?? 'general',
                    tags: arr(f?.tags).filter((x) => typeof x === 'string'),
                    entities: arr(f?.entities).filter((x) => typeof x === 'string'),
                    trustScore: typeof f?.trustScore === 'number' ? Math.min(1, Math.max(0, f.trustScore)) : 0.5,
                    createdAt: str(f?.createdAt) ?? '',
                    updatedAt: str(f?.updatedAt) ?? '',
                }];
        });
    }
    async status(_signal) {
        try {
            this.load(this.defaultSpace());
            return { healthy: true };
        }
        catch (err) {
            return { healthy: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    async search(space, q, _signal) {
        const facts = this.load(space);
        const minTrust = Math.min(1, Math.max(0, Number(this.conn.minTrust ?? 0.3)));
        const queryTerms = holoTerms(q.query);
        const lower = q.query.toLocaleLowerCase();
        const limit = clampInt(q.limit, 1, 50, 10);
        const scored = facts.flatMap((fact) => {
            if (fact.trustScore < minTrust)
                return [];
            const lexical = holoOverlap(queryTerms, holoTerms(`${fact.content} ${fact.tags.join(' ')} ${fact.entities.join(' ')}`));
            const phrase = fact.content.toLocaleLowerCase().includes(lower) ? 1 : 0;
            const entity = fact.entities.some((e) => lower.includes(e.toLocaleLowerCase())) ? 1 : 0;
            const relevance = Math.max(lexical, phrase * 0.9, entity * 0.8);
            if (relevance <= 0)
                return [];
            return [{
                    fact,
                    score: relevance * fact.trustScore,
                }];
        });
        scored.sort((a, b) => b.score - a.score || (a.fact.id < b.fact.id ? -1 : 1));
        return {
            results: scored.slice(0, limit).map(({ fact, score }) => ({
                driverId: this.id,
                spaceId: space.spaceId,
                externalId: fact.id,
                content: fact.content,
                score,
                category: fact.category,
                tags: fact.tags.length > 0 ? fact.tags : undefined,
                entities: fact.entities.length > 0 ? fact.entities : undefined,
                updatedAt: fact.updatedAt || undefined,
            })),
            hasMore: false,
        };
    }
    defaultSpace() {
        const externalId = String(this.conn.space ?? '').trim() || 'store.json';
        return { spaceId: `${this.id}:${externalId}`, driverId: this.id, externalId, name: externalId, description: '' };
    }
    async remember(space, item, _signal) {
        const file = this.storePath(space);
        const root = this.loadRoot(file);
        const facts = root.facts;
        const trimmed = item.content.trim();
        const existing = facts.find((f) => f.content === trimmed);
        if (existing !== undefined) {
            return { completion: 'skipped', externalId: existing.id };
        }
        const now = new Date().toISOString();
        const fact = {
            id: `holo-${randomUUID()}`,
            content: trimmed,
            category: item.category ?? 'general',
            tags: [...new Set(item.tags ?? [])],
            entities: [...new Set(item.entities ?? [])],
            trustScore: Math.min(1, Math.max(0, Number(item.importance ?? this.conn.defaultTrust ?? 0.5))),
            createdAt: now,
            updatedAt: now,
        };
        facts.push(fact);
        this.saveRoot(file, root);
        return { completion: 'committed', externalId: fact.id };
    }
    /** hard 删:从 facts 里摘除(找不到即幂等完成——目标态已达,不报错)。 */
    async forget(space, externalId, _signal) {
        const file = this.storePath(space);
        const root = this.loadRoot(file);
        const before = root.facts.length;
        root.facts = root.facts.filter((f) => f.id !== externalId);
        if (root.facts.length !== before)
            this.saveRoot(file, root);
        return { completion: 'committed' };
    }
    /**
     * 全量枚举（拉取面与 settle 回捞）：facts 原样映射。
     * `hasMore` 由本地总数判（文件就是全部，能算出确切答案，不需要猜）。
     */
    async list(space, req, _signal) {
        const offset = Math.max(0, req.offset ?? 0);
        const limit = clampInt(req.limit, 1, 1000, 100);
        const facts = this.load(space);
        const hits = facts.slice(offset, offset + limit).map((f) => ({
            driverId: this.id,
            spaceId: space.spaceId,
            externalId: f.id,
            content: f.content,
            score: f.trustScore,
            category: f.category,
            tags: f.tags.length === 0 ? undefined : f.tags,
            entities: f.entities.length === 0 ? undefined : f.entities,
            updatedAt: f.updatedAt || undefined,
        }));
        return { hits, hasMore: offset + hits.length < facts.length };
    }
    /** load 的可写版:文件不存在时以空 facts 起底(remember 首写要能自建)。 */
    loadRoot(file) {
        if (!existsSync(file))
            return { facts: [], extra: {} };
        const root = obj(JSON.parse(readFileSync(file, 'utf8'))) ?? {};
        const { facts: rawFacts, ...extra } = root;
        const facts = Array.isArray(rawFacts)
            ? rawFacts.flatMap((v) => {
                const f = obj(v);
                const id = str(f?.id);
                const content = str(f?.content);
                if (id === undefined || content === undefined)
                    return [];
                return [{
                        id,
                        content,
                        category: str(f?.category) ?? 'general',
                        tags: arr(f?.tags).filter((x) => typeof x === 'string'),
                        entities: arr(f?.entities).filter((x) => typeof x === 'string'),
                        trustScore: typeof f?.trustScore === 'number' ? Math.min(1, Math.max(0, f.trustScore)) : 0.5,
                        createdAt: str(f?.createdAt) ?? '',
                        updatedAt: str(f?.updatedAt) ?? '',
                    }];
            })
            : [];
        return { facts, extra };
    }
    /** 原子写:临时文件 + rename(写的半途崩溃不能把事实库截成半截)。 */
    saveRoot(file, root) {
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...root.extra, facts: root.facts }, null, 2), 'utf8');
        renameSync(tmp, file);
    }
    async graph() {
        throw new ExtCapabilityMissingError('graph', '图谱(graph)');
    }
}
// ── byterover:`brv` CLI(合成块只读件,恒不影子化) ─────────────────────────
class ByteRoverDriver {
    id;
    typeId = 'byterover';
    capabilities = EXT_DRIVER_SPECS.byterover.capabilities;
    scoreSemantics = EXT_DRIVER_SPECS.byterover.scoreSemantics;
    conn;
    run;
    queryTimeoutMs;
    constructor(input) {
        this.id = input.id;
        this.conn = input.connection;
        this.run = input.process ?? runProcess;
        this.queryTimeoutMs = input.queryTimeoutMs ?? 10_000;
    }
    cli() {
        return String(this.conn.endpoint ?? this.conn.cliPath ?? '') || 'brv';
    }
    cwd() {
        const dir = String(this.conn.space ?? '').trim() || process.cwd();
        return dir;
    }
    async runCli(args, timeoutMs, signal) {
        const apiKey = String(this.conn.apiKey ?? '').trim();
        const res = await this.run(this.cli(), args, {
            timeoutMs,
            maxOutputBytes: 256 * 1024,
            cwd: this.cwd(),
            label: `byterover:${this.id}`,
            ...(signal === undefined ? {} : { signal }),
            env: { ...process.env, ...(apiKey === '' ? {} : { BRV_API_KEY: apiKey }) },
        });
        if (res.exitCode !== 0) {
            throw new Error(res.stderr.trim() || res.stdout.trim() || `byterover exited with code ${res.exitCode}`);
        }
        return res.stdout.trim();
    }
    async status(signal) {
        try {
            await this.runCli(['status'], 15_000, signal);
            return { healthy: true };
        }
        catch (err) {
            return { healthy: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    async search(space, q, signal) {
        const output = await this.runCli(['query', '--', q.query.slice(0, 5000)], this.queryTimeoutMs, signal);
        if (output.length < 20)
            return { results: [], hasMore: false };
        const content = output.length > 8000 ? `${output.slice(0, 8000)}\n\n[... truncated]` : output;
        return {
            results: [{
                    driverId: this.id,
                    spaceId: space.spaceId,
                    externalId: `byterover:${createHash('sha256').update(content).digest('hex').slice(0, 24)}`,
                    content,
                    category: 'context',
                    score: 1,
                }],
            hasMore: false,
        };
    }
    async remember() {
        return { ...READ_ONLY_RECEIPT };
    }
}
// ── mnemon-native:`mnemon` CLI(官方本地后端) ──────────────────────────────
class MnemonNativeDriver {
    id;
    typeId = 'mnemon-native';
    capabilities = EXT_DRIVER_SPECS['mnemon-native'].capabilities;
    scoreSemantics = EXT_DRIVER_SPECS['mnemon-native'].scoreSemantics;
    conn;
    run;
    searchTimeoutMs;
    constructor(input) {
        this.id = input.id;
        this.conn = input.connection;
        this.run = input.process ?? runProcess;
        this.searchTimeoutMs = input.queryTimeoutMs ?? 15_000;
    }
    cli() {
        return String(this.conn.endpoint ?? this.conn.cliPath ?? '') || 'mnemon';
    }
    /**
     * 一次 CLI 调用 → JSON。store 参数形态可配(extra.storeFlag,缺省 `--store`;
     * 空串 = 该 CLI 无 store 概念)。JSON 输出旗同理(jsonFlag,缺省 `--json`)。
     */
    async runJson(args, store, signal) {
        const jsonFlag = String(this.conn.jsonFlag ?? '--json');
        const storeFlag = String(this.conn.storeFlag ?? '--store');
        const full = [...args, ...(jsonFlag === '' ? [] : [jsonFlag]), ...(store === '' || storeFlag === '' ? [] : [storeFlag, store])];
        const res = await this.run(this.cli(), full, {
            timeoutMs: this.searchTimeoutMs,
            maxOutputBytes: 1024 * 1024,
            label: `mnemon:${this.id}`,
            ...(signal === undefined ? {} : { signal }),
        });
        if (res.exitCode !== 0) {
            throw new Error(res.stderr.trim() || `mnemon exited with code ${res.exitCode}`);
        }
        try {
            return JSON.parse(res.stdout);
        }
        catch {
            throw new Error(`mnemon:${this.id} returned non-JSON payload`);
        }
    }
    storeOf(space) {
        return space.externalId === 'main' ? '' : space.externalId;
    }
    async status(signal) {
        try {
            const raw = obj(await this.runJson(['status'], '', signal));
            if (raw === undefined)
                throw new Error('mnemon status returned an unexpected payload');
            return { healthy: true, stats: { count: num(raw.total_insights) } };
        }
        catch (err) {
            return { healthy: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    /** mode 三档照参考实现:smart=recall(图增强), keyword=search, basic=recall --basic。 */
    async search(space, q, signal) {
        const limit = clampInt(q.limit, 1, 50, 10);
        const mode = String(this.conn.searchMode ?? 'smart');
        const args = mode === 'keyword'
            ? ['search', q.query, '--limit', String(limit)]
            : ['recall', q.query, '--limit', String(limit), ...(mode === 'basic' ? ['--basic'] : [])];
        const payload = await this.runJson(args, this.storeOf(space), signal);
        const wrapper = obj(payload);
        const values = Array.isArray(payload) ? payload : Array.isArray(wrapper?.results) ? wrapper.results : [];
        return { results: values.map((v) => this.nativeHit(v, space)).filter((h) => h !== undefined), hasMore: false };
    }
    /** 行形态双兼容:`{insight:{...},score}` 嵌套(≤0.1.2)与扁平compact(新)。 */
    nativeHit(value, space) {
        const row = obj(value);
        if (row === undefined)
            return undefined;
        const core = obj(row.insight) ?? row;
        const externalId = str(core.id);
        const content = str(core.content);
        if (externalId === undefined || content === undefined)
            return undefined;
        return {
            driverId: this.id,
            spaceId: space.spaceId,
            externalId,
            content,
            score: num(row.score),
            category: str(core.category) ?? 'general',
            tags: arr(core.tags).filter((x) => typeof x === 'string'),
            entities: arr(core.entities).filter((x) => typeof x === 'string'),
            updatedAt: str(core.created_at),
        };
    }
    /**
     * Phase 2 实装(soft 三家之一,writeMode=exact):同步 remember 即落定——
     * 返回体带 id 就链上,不带也认 committed(exact 写无中间态,参考实现同语义)。
     */
    async remember(space, item, signal) {
        const args = ['remember', item.content, '--cat', item.category ?? 'general', '--imp', String(item.importance ?? 3), '--source', 'agent'];
        if (item.tags !== undefined && item.tags.length > 0)
            args.push('--tags', item.tags.join(','));
        if (item.entities !== undefined && item.entities.length > 0)
            args.push('--entities', item.entities.join(','));
        const payload = obj(await this.runJson(args, this.storeOf(space), signal));
        const id = str(payload?.id);
        return { completion: 'committed', ...(id === undefined ? {} : { externalId: id }) };
    }
    /** soft 删:mnemon forget 是软标记(可 import 回灌),与本地退场语义对齐。 */
    async forget(space, externalId, signal) {
        await this.runJson(['forget', externalId], this.storeOf(space), signal);
        return { completion: 'committed' };
    }
    /**
     * settle/拉取底座：`--readonly recall ''` 全量枚举（不涨访问计数，参考实现同款旗标）。
     *
     * CLI 只有 `--limit`、无 offset 语义 → 单页到底（caps.paged=false），面板必须如实说明
     * “该家单次导入上限 = 单页”，不能让人以为点了就拿到了全库。
     */
    async list(space, req, signal) {
        const limit = clampInt(req.limit, 1, 1000, 100);
        const payload = await this.runJson(['--readonly', 'recall', '', '--basic', '--limit', String(limit)], this.storeOf(space), signal);
        const wrapper = obj(payload);
        const values = Array.isArray(payload) ? payload : Array.isArray(wrapper?.results) ? wrapper.results : [];
        const hits = values.map((v) => this.nativeHit(v, space)).filter((h) => h !== undefined);
        // 服务端总数可得时用它；否则满页即保守报 hasMore（宁可末尾多一次空请求，不可提前停手漏条目）。
        const total = num(wrapper?.total) ?? num(wrapper?.count);
        return { hits, hasMore: total === undefined ? hits.length >= limit : hits.length < total };
    }
    async graph() {
        throw new ExtCapabilityMissingError('graph', '图谱(graph)');
    }
    /** link 在场桩(capabilities.link=true 的必需方法;类型化建边在 Phase 3 图融合接)。 */
    async link() {
        return { ...READ_ONLY_RECEIPT };
    }
}
export const LOCAL_DRIVER_FACTORIES = {
    holographic: (i) => new HolographicDriver(i),
    byterover: (i) => new ByteRoverDriver(i),
    'mnemon-native': (i) => new MnemonNativeDriver(i),
};
