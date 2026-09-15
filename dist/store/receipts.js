/**
 * §B L1 决策凭证链(可追溯性基础设施)。
 *
 * 为什么需要:`memory.db` 里每条 L1 记录都是**去重决策的结果**(store / update /
 * merge / skip),但决策本身不留痕——事后只能看到"结果长这样",看不到"当时基于什么
 * 做的判断"。而判「这次 merge 是否正确」需要**当时的输入快照**,快照无法事后补录。
 * 这就是 §B 必须**前置**存在、不能等症状触发的原因(findings.md §9)。
 *
 * 本文件承载契约中最纯的那一半:`input_digest`。
 */
import { createHash, randomBytes } from 'node:crypto';
/** 摘要格式版本。进入 canonical 串,使算法演进时**不会静默**让新旧凭证看起来可比。 */
export const DIGEST_FORMAT = 'l1-receipts/v1';
/**
 * 候选池**有序序列** → 稳定摘要(sha256 hex)。
 *
 * 语义:`searchCandidates` 返回的是**已排序**的候选池,「当时看到哪些候选、按什么序」
 * 就是去重决策的输入。故本函数**顺序敏感**——换个序即不同摘要,而不是把候选当集合。
 *
 * 三项刻意的设计:
 * - **顺序敏感**:见上。集合语义会丢掉"哪条候选排在最前"这一信息。
 * - **重复不折叠**:`['r1','r1']` 与 `['r1']` 摘要不同。候选池里的重复本身是事实
 *   (例如同一记录被两条通路召回),折叠掉等于篡改输入。
 * - **长度前缀编码**:逐项写 `${len}:${id}\n` 而非直接拼接。否则 `['a|b']` 与
 *   `['a','b']`(以及 `['a\nb']` 与 `['a','b']`)会碰撞——分隔符出现在 id 里时,
 *   序列化就不再是单射,摘要也就失去了作为输入指纹的意义。
 *
 * 纯函数:无 I/O、无时间、无随机。同输入**恒**同输出,这是凭证可复算的前提。
 */
export function inputDigest(candidateIds) {
    const hash = createHash('sha256');
    hash.update(DIGEST_FORMAT);
    hash.update('\n');
    for (const id of candidateIds) {
        hash.update(`${id.length}:`);
        hash.update(id);
        hash.update('\n');
    }
    return hash.digest('hex');
}
/**
 * 凭证保留上限:**最多保留多少个 run**。
 *
 * 为什么按 **run 数**而不是按天数(§B task_18):
 * 本策略要防的是「`memory.db` 无限增长」。时间窗口**给不出这个保证**——
 * 阈值(比如 90 天)与写入速率无关,一个高频用户 90 天能写进任意多行,
 * 无界增长只是被推迟,不是被消除。run 数上限则**直接给出行的上界**
 * (`maxRuns × 每 run 记录数`),这是"有界"与"看起来有界"的区别。
 * 代价是:一个几乎不用的用户,历史可能只剩最近 1000 次蒸馏——
 * 但凭证是**诊断设施**,诊断需要的是"最近发生了什么",不是考古。
 *
 * 1000 这个量级的依据:一轮 L1 蒸馏通常落 5~20 条凭证,故上限约 1~2 万行
 * (数 MB 量级,在同为单文件的 `memory.db` 里不构成压力);而 L1 蒸馏本身要
 * 调一次 LLM,现实中每小时至多几次——1000 轮 ≈ 活跃使用数月。
 *
 * **为什么是常量而不是配置项**:配置项要接 schema、契约与设置页,为一个
 * 诊断表的容量引入用户可见面,收益与面积不成比例(YAGNI)。真需要调,
 * 改这里即可,且 `recordReceipts(rows, { maxRuns })` 已留出显式注入口。
 */
export const RECEIPTS_MAX_RUNS = 1000;
const KNOWN_ACTIONS = ['store', 'update', 'merge', 'skip'];
/**
 * 一次蒸馏执行的 run 标识。
 *
 * **为什么不是"由输入切片推导出的确定性值"**——v1 曾这么设计，实测后被推翻：
 * `pipeline/l1.ts` 对每条抽取结果执行 `record_id: newId('mem')`，
 * **模型给的 record_id 被丢弃，记录 id 是运行时生成的**。因此"同一批消息重跑"
 * 必然产生**不同的 record_id**，也就必然产生不同的凭证。把 run_id 做成切片的函数
 * 换不来任何跨次幂等，只会让两次**互不相干的执行**挤在同一个 run_id 下，
 * 反而破坏「一个 run = 一次执行」的归因。
 *
 * 于是幂等的真正边界是：**同一次 run 内，同一条记录只留一条凭证**
 * （`receipt_id = f(run, record)` + `INSERT OR IGNORE`）。
 * 这才是"同一决策不重复落盘"在本代码库里能成立的那个含义。
 *
 * 命名沿用仓库既有惯例（`newId('mem')` / `newJobId()` → `前缀_时间戳_随机`）。
 */
export function newRunId() {
    return `run_${Date.now()}_${randomBytes(3).toString('hex')}`;
}
/** receipt_id = f(run, record) —— 幂等的落点(同 run 同记录只留一条)。 */
export function receiptIdFor(runId, recordId) {
    return inputDigest([runId, recordId]);
}
/** 动作归一:只认四个合法动作,其余一律记 `skip_missing`(不采信模型的非法输出)。 */
export function normalizeKind(action) {
    return KNOWN_ACTIONS.includes(action) ? action : 'skip_missing';
}
/** 纯映射:决策集 → 凭证行。无 I/O,便于单测与复算。 */
export function buildReceipts(runId, decidedAt, items) {
    return items.map((it) => ({
        receiptId: receiptIdFor(runId, it.recordId),
        runId,
        recordId: it.recordId,
        kind: normalizeKind(it.action),
        inputDigest: inputDigest(it.candidateIds),
        decidedAt,
    }));
}
/**
 * **失败隔离**:凭证是旁路观测设施,绝不是主链路的单点。
 *
 * L1 蒸馏已经把新记忆写进事实源了;此时若凭证写失败还向上抛,等于让一个
 * 「记录决策」的附属动作把「产生记忆」的主流程打死——代价与收益完全不成比例。
 * 故此处只记 warn,永不抛出。
 */
export function persistReceiptsSafely(write, rows, logger) {
    if (rows.length === 0)
        return;
    try {
        write(rows);
    }
    catch (err) {
        logger?.warn(`[memory] L1 决策凭证落盘失败(${rows.length} 条),本次判定不留痕但**不影响蒸馏结果**: ${err instanceof Error ? err.message : String(err)}`);
    }
}
