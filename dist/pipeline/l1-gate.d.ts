/** 门模式(Schema.string 落库 + 本函数归一,禁 union/nullable——P0-10)。 */
export type GateMode = 'off' | 'warn' | 'enforce';
export declare function normalizeGateMode(raw: unknown): GateMode;
/** 子门名(词表单一来源;留痕 gate 列只用这里的值,I-17)。 */
export declare const GATE_NAMES: readonly ["priority", "shape", "garbled", "nearDup", "llmFilter"];
export type GateName = (typeof GATE_NAMES)[number];
/**
 * priority 阈值表(l1-extraction prompt 的打分纪律,代码层首次落地)。
 * 未登记类型 → Infinity(不设门,fail-open——未知类型宁漏不误)。
 */
export declare const GATE_PRIORITY_THRESHOLD: Readonly<Record<string, number>>;
export declare function gatePriorityThresholdOf(type: unknown): number;
/** 不可打印字符(控制字符,排除 \t \n \r)占比超此阈 → 形状门拦。 */
export declare const GATE_SHAPE_MAX_NON_PRINTABLE_RATIO = 0.3;
/** U+FFFD 替换符占比超此阈 → 乱码门拦(解码失败的典型形态)。 */
export declare const GATE_GARBLED_MAX_REPLACEMENT_RATIO = 0.05;
/** 乱码门最小计数:短文本里个别替换符不拦(极保守——占比对短串过敏)。 */
export declare const GATE_GARBLED_MIN_COUNT = 3;
/** 近重复门(T1.4):与候选的字符二元组 Jaccard ≥ 此阈才拦——阈值刻意贴上限,只在 LLM 判 store 的明显误判上二次拦截。 */
export declare const GATE_NEARDUP_JACCARD = 0.92;
/** 门判定入参(结构化最小面——PendingMemory 的超集形状,避免反向依赖管线内部类型)。 */
export interface GateCandidate {
    record_id: string;
    content: string;
    type?: unknown;
    family?: unknown;
    /** 抽取入口的**原始** priority(未强转;`-1` 哨兵在此识别,P0-4)。 */
    priority?: unknown;
}
/** 单条留痕(gate_rejected;冷溯源,不进检索/快照)。 */
export interface GateRejection {
    recordId: string;
    gate: GateName;
    mode: Exclude<GateMode, 'off'>;
    /** 原始 priority 的字符串化(未强转的真值;缺失记 ''。 */
    priorityRaw: string;
    reason: string;
    contentChars: number;
}
export interface WriteGateResult<T extends GateCandidate> {
    /** 通过门(含 warn 放行)的记忆,顺序与输入一致。 */
    kept: T[];
    /** 全部丢弃/告警留痕(含 warn;调用方落库)。 */
    rejections: GateRejection[];
}
/** priority 门:原始值判定。`-1` 死命令恒放行;缺失/非有限放行(交 ||60 兜底=零漂移)。 */
export declare function judgePriorityGate(raw: unknown, type: unknown): {
    pass: boolean;
    reason: string;
};
/** 形状门:不可打印字符(控制字符,排除 \t\n\r)占比。 */
export declare function nonPrintableRatio(content: string): number;
export declare function judgeShapeGate(content: string): {
    pass: boolean;
    reason: string;
};
export declare function replacementRatio(content: string): number;
export declare function replacementCount(content: string): number;
export declare function judgeGarbledGate(content: string): {
    pass: boolean;
    reason: string;
};
/** Jaccard 相似度(二元组;任一侧空 → 0)。近重复门 T1.4 专用。 */
export declare function nearDupSimilarity(a: string, b: string): number;
/**
 * 近重复判定(T1.4):与**既有候选**的最大相似度 ≥ 阈 → 拦。
 * 调用契约:**放 LLM 去重之后**、只在 LLM 判 `store` 的条目上二次拦截——
 * 本函数不判断"该不该跑",只回答"像不像"。
 */
export declare function judgeNearDupGate(content: string, candidateContents: readonly string[]): {
    pass: boolean;
    reason: string;
};
export interface WriteGateConfig {
    priorityMode?: unknown;
    shapeMode?: unknown;
    garbledMode?: unknown;
    nearDupMode?: unknown;
    llmFilterMode?: unknown;
}
/**
 * 写入门主体(T1.1/T1.2/T1.3)。纯同步、无 I/O;留痕由调用方落库。
 * nearDup 与 llmFilter 不在此跑(分别在判 store 处与可选 LLM pass),这里只做
 * priority/shape/garbled 三道机械门。
 *
 * 全 off 时逐字返回输入(含对象引用不复制——零漂移的最强形态)。
 */
export declare function applyWriteGate<T extends GateCandidate>(candidates: T[], cfg: WriteGateConfig): WriteGateResult<T>;
/** 单批上限(学 relabel 的 LLM_CAP 纪律:单次过滤成本硬上界)。 */
export declare const GATE_LLM_FILTER_BATCH_CAP = 60;
export interface LlmFilterVerdict {
    /** 放行条目的 record_id 集(判不了/失败 = 全部放行)。 */
    keepIds: Set<string>;
    /** 判定留痕(仅明确 drop 的条目)。 */
    rejections: GateRejection[];
}
/**
 * LLM 质量过滤 pass。**fail-open 契约(ADR-0011 条4)**:
 * LLM 不可用/超时/输出不可解析 → **全部放行**,绝不 fail-closed 全拦。
 * `judge` 由调用方注入(管线里接 callLLM),本函数只管批处理与降级语义。
 */
export declare function applyLlmQualityFilter<T extends GateCandidate>(candidates: T[], judge: (batch: T[]) => Promise<Map<string, 'keep' | 'drop'>>, mode: unknown): Promise<LlmFilterVerdict>;
