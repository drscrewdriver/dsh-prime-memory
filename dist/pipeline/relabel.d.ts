/**
 * 反刍的标注校验/重标定阶段:对 L1 存量做一次有界巡检——
 *
 * 1. **机械校验**(零 LLM,全量扫描,有界写回):
 *    - Wing 合法性:metadata.hall 非空但不在词表(8 角 + general)→ 剥离非法值,转入 LLM 重标队列;
 *    - 认知 hall:按 type 静态映射(cognitive-hall.ts)可派生而 metadata.cogHall 缺失/不一致 → 补写修正;
 * 2. **LLM 重标定**(有界批,受 wing.enabled 门控):
 *    - 未打标 wing 的记录复用一键回填的标注器(labelWingChunk)补打;
 *    - 涌现标签(tags,Room 的前身):同一批记录由标注器顺带产出 1-3 个 slug 标签写 metadata.tags。
 *
 * 安全边界与一键回填一致:LLM 失败只跳过当前块、原记录零改动;机械与 LLM 写回都有上限,防止单次跑飞。
 * 本阶段在反刍收尾(L2/L3 之后)执行,**任何失败不拖垮反刍整体**(只 warn + 计数)。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type MemoryLogger, type MemoryRecord } from '../types.js';
import type { L1Store } from '../store/l1.js';
import type { MemoryConfig } from '../config.js';
export interface RelabelStats {
    /** 巡检记录总数。 */
    checked: number;
    /** 机械补写认知 hall(metadata.cogHall)条数。 */
    cogHallFixed: number;
    /** 剥离非法 wing 值条数(已转入 LLM 重标队列)。 */
    wingInvalidFixed: number;
    /** LLM 补打 wing 成功条数。 */
    wingLabeled: number;
    /** 写入涌现标签(tags)的记录条数。 */
    tagged: number;
    /** LLM 失败/跳过的记录条数(原记录零改动)。 */
    llmSkipped: number;
}
export interface RelabelDeps {
    ctx: Context;
    cfg: MemoryConfig;
    l1: L1Store;
    logger: MemoryLogger;
}
/** 测试注入口:分别替换 wing 标注器与 tags 标注器(默认走真实 LLM 路径)。 */
export interface RelabelOverrides {
    wingLabeler?: (chunk: MemoryRecord[]) => Promise<Array<{
        record: MemoryRecord;
        wing: string;
    }>>;
    tagger?: (chunk: MemoryRecord[]) => Promise<Array<{
        record: MemoryRecord;
        tags: string[];
    }>>;
}
export declare function relabelPass(deps: RelabelDeps, overrides?: RelabelOverrides): Promise<RelabelStats>;
