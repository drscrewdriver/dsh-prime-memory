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
import { createHash } from 'node:crypto';
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
