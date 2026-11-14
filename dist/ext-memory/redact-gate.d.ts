/**
 * 推送前置二次脱敏闸门(计划 ext-mem-drivers-sync T0.11,M11 从 Phase 3 提前)。
 *
 * ## 为什么捕获侧脱敏不够
 *
 * `capture.redactSecrets` 默认开,但有三条够不着的泄出面:
 * ① **兜底放行原文**:捕获侧脱敏自身异常时按红线放行原文(capture.ts:"失败不
 *    阻断捕获")——本地可接受(数据不出机器),有了推送出口后同一兜底变成
 *    "偶发未脱敏正文离开本机且无审计";
 * ② `redactSecrets:false` 的部署:那是"本地留明文"的显式选择,不等于授权
 *    **出境**——两件事的知情同意不通用;
 * ③ 非捕获来源的内容:`memory_add` / 导入 / (Phase 1+)外部回灌的正文,
 *    可能带着从未过词表的内容出境。
 *
 * 所以出境口必须有**独立、不可关闭、幂等**的第二道闸:复用 `util/redact.ts`
 * 同一纯函数词表(一处词表演进两处生效),已脱敏内容再过一遍是恒等(幂等保证
 * 重放安全)。
 *
 * ## 接线位
 *
 * Phase 0 只交付本函数 + 单测;**真正接进推送链路在 T2.2 的 ext-pusher**
 * (任何 remember/forget 出网前必经本闸,硬闸,绕过即测试红)。在此之前
 * 全仓没有推送出口,闸门无调用点——这是刻意的顺序:闸门先于第一根外网线存在。
 */
import { type RedactionKind } from '../util/redact.js';
export interface PushGateResult {
    /** 过闸后的文本(未命中 = 原样)。 */
    text: string;
    /** 命中的密钥类别计数(空 = 原文干净)。 */
    counts: Partial<Record<RedactionKind, number>>;
    redacted: boolean;
}
/**
 * 推送闸门:文本出境前必过。与捕获侧不同,**这里没有"失败放行"分支**——
 * `redactSecrets` 本身不抛(词表级 fail-safe),若仍异常则**拒绝推送**
 * (返回 redactError 标记由调用方落 outbox 挂账),绝不带原文出境。
 *
 * 返回体刻意不含原文:调用方记日志/挂账时能带 `text`(已脱)与计数,
 * 拿不到未脱敏正文——把"闸门输出即唯一可出境形态"做进 API 形状里。
 */
export declare function pushRedactGate(text: string): PushGateResult | {
    redactError: string;
};
/**
 * 日志 sink 统一脱敏(计划 T3.5):任何外发/落盘日志的文本先过同一词表。
 *
 * 与推送闸门同词表、同“失败不泄原文”纪律:脱敏自身异常时返回占位符而非原文
 * (日志丢内容可接受,日志泄密钥不可接受)。
 */
export declare function scrubSecretsForLog(text: string): string;
/**
 * 记录级闸门:content + metadata 里可能的自由文本(字符串值)逐而过。
 * 返回**新对象**(不改入参——捕获红线同样适用于推送侧:原文不可被旁路改写)。
 * metadata 只扫字符串叶子(深两层足够:dsh_keywords/usage_scenario 均为字符串数组形态)。
 */
export declare function pushRedactRecord(rec: {
    content: string;
    metadata?: Record<string, unknown>;
}): {
    content: string;
    metadata?: Record<string, unknown>;
    redacted: boolean;
} | {
    redactError: string;
};
