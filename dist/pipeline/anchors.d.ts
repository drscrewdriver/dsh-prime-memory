/**
 * 会话位置锚点(R7)——纯函数层。
 *
 * **为什么单独一层**:锚点的两个动作(批量带入 L1 记录、从库里读回)都是
 * "输入 → 输出"的纯变换,且是 R7 的**正确性核心**。放在 pipeline 里就要靠
 * 真跑 LLM 才能验;抽出来可以直接单测,包括 fold 正确性与越界降级。
 *
 * **红线(不得违反)**:
 * 1. 锚点只能来自内核事件负载或捕获侧 fold 出的值,**永不推算**。
 * 2. `step` 缺失就留空,**不得**用相邻事件的 step 补齐。
 * 3. `source_message_ids` 里映射不到的消息 id **直接丢弃**,不得猜测坐标。
 */
import type { ConversationAnchor, ConversationMessage } from '../types.js';
/**
 * `l1_records.metadata_json` 里承载锚点集合的**保留键**。
 *
 * 加前缀 `dsh_` 是为了与 LLM 产出的 metadata 键(`hall` / `activity_start_time` 等)
 * 在命名空间上隔开——写库时两者会被合并进同一个 JSON 对象(见 `withSourceAnchors`)。
 */
export declare const ANCHOR_METADATA_KEY = "dsh_source_anchors";
/**
 * 建立 `L0 消息 id → 锚点` 映射。
 *
 * 只收录**带锚点**的消息:没有内核坐标的消息(老数据、无 turn 的事件)不进映射,
 * 于是它在 `resolveSourceAnchors` 里自然落进"未命中"分支,而不是被伪造一个坐标。
 */
export declare function buildAnchorMap(messages: ConversationMessage[]): Map<string, ConversationAnchor>;
/**
 * 把一条记忆的 `source_message_ids` 解析成去重、有序的锚点集合。
 *
 * - 命中映射 → 收下该锚点
 * - 未命中(LLM 引用了背景消息、或该消息本就没有坐标) → **丢弃**
 * - 结果为空 → 返回 `undefined`,由调用方按"无锚点"处理(不是空数组)
 */
export declare function resolveSourceAnchors(sourceMessageIds: readonly string[] | undefined, anchors: ReadonlyMap<string, ConversationAnchor>): ConversationAnchor[] | undefined;
/**
 * 把锚点集合写进 metadata(返回**新对象**,不改入参——不可变更新)。
 *
 * 无锚点时不写键:老记录与"解析不到坐标"的记录保持与改动前**逐字一致的**
 * metadata,这样既有导出/比对/测试不会被一个空数组搅动。
 */
export declare function withSourceAnchors(metadata: Record<string, unknown> | undefined, anchors: ConversationAnchor[] | undefined): Record<string, unknown>;
/**
 * 从 metadata 读回锚点集合(读侧唯一入口)。
 *
 * 形状校验从严:任何一项缺 `turn` 或类型不对 → 该项丢弃;全丢 → `undefined`。
 * 宁可报告"无锚点",也不把半截坐标喂给下游的证据读取器。
 */
export declare function readSourceAnchors(metadata: unknown): ConversationAnchor[] | undefined;
