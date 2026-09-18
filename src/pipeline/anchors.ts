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
export const ANCHOR_METADATA_KEY = 'dsh_source_anchors';

/** 锚点的规范性比较键:`turn` 升序,`step` 缺失排在同 turn 的最前。 */
function anchorOrderKey(a: ConversationAnchor): string {
  const step = typeof a.step === 'number' ? String(a.step).padStart(6, '0') : '000000';
  return `${a.sessionId}\u0000${String(a.turn).padStart(10, '0')}\u0000${step}`;
}

/**
 * 建立 `L0 消息 id → 锚点` 映射。
 *
 * 只收录**带锚点**的消息:没有内核坐标的消息(老数据、无 turn 的事件)不进映射,
 * 于是它在 `resolveSourceAnchors` 里自然落进"未命中"分支,而不是被伪造一个坐标。
 */
export function buildAnchorMap(messages: ConversationMessage[]): Map<string, ConversationAnchor> {
  const map = new Map<string, ConversationAnchor>();
  for (const m of messages) {
    if (m.anchor !== undefined && Number.isFinite(m.anchor.turn)) {
      map.set(m.id, m.anchor);
    }
  }
  return map;
}

/**
 * 把一条记忆的 `source_message_ids` 解析成去重、有序的锚点集合。
 *
 * - 命中映射 → 收下该锚点
 * - 未命中(LLM 引用了背景消息、或该消息本就没有坐标) → **丢弃**
 * - 结果为空 → 返回 `undefined`,由调用方按"无锚点"处理(不是空数组)
 */
export function resolveSourceAnchors(
  sourceMessageIds: readonly string[] | undefined,
  anchors: ReadonlyMap<string, ConversationAnchor>,
): ConversationAnchor[] | undefined {
  if (sourceMessageIds === undefined || sourceMessageIds.length === 0) return undefined;
  const byKey = new Map<string, ConversationAnchor>();
  for (const id of sourceMessageIds) {
    const a = anchors.get(id);
    if (a === undefined) continue;
    const key = anchorOrderKey(a);
    if (!byKey.has(key)) byKey.set(key, a);
  }
  if (byKey.size === 0) return undefined;
  return [...byKey.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, a]) => a);
}

/**
 * 把锚点集合写进 metadata(返回**新对象**,不改入参——不可变更新)。
 *
 * 无锚点时不写键:老记录与"解析不到坐标"的记录保持与改动前**逐字一致的**
 * metadata,这样既有导出/比对/测试不会被一个空数组搅动。
 */
export function withSourceAnchors(
  metadata: Record<string, unknown> | undefined,
  anchors: ConversationAnchor[] | undefined,
): Record<string, unknown> {
  const base = metadata ?? {};
  if (anchors === undefined || anchors.length === 0) return base;
  return { ...base, [ANCHOR_METADATA_KEY]: anchors };
}

/**
 * 从 metadata 读回锚点集合(读侧唯一入口)。
 *
 * 形状校验从严:任何一项缺 `turn` 或类型不对 → 该项丢弃;全丢 → `undefined`。
 * 宁可报告"无锚点",也不把半截坐标喂给下游的证据读取器。
 */
export function readSourceAnchors(metadata: unknown): ConversationAnchor[] | undefined {
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const raw = (metadata as Record<string, unknown>)[ANCHOR_METADATA_KEY];
  if (!Array.isArray(raw)) return undefined;
  const out: ConversationAnchor[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const sessionId = o.sessionId;
    const turn = o.turn;
    if (typeof sessionId !== 'string' || typeof turn !== 'number' || !Number.isFinite(turn)) continue;
    const anchor: ConversationAnchor = { sessionId, turn };
    if (typeof o.step === 'number' && Number.isFinite(o.step)) anchor.step = o.step;
    out.push(anchor);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 锚点的人类可读标签:**UI 契约(`UiRecord.sourceAnchors`)要的字符串形态**。
 *
 * 格式即 `t<turn>` / `t<turn> s<step>`(与 `reconcile.ts` 的证据行同一写法,
 * 见 contract.ts 对 `sourceAnchors` 的说明)。`step` 缺失就**不写**——
 * 不得用 0 或相邻事件的 step 补齐(红线 2:坐标永不推算)。
 *
 * 刻意**不带 sessionId**:该字段用于跨会话归并排序,而 UI 一行里只有
 * "这条记忆出在会话内哪个位置",带上 id 反而把可用信息挤掉。
 */
export function anchorLabel(anchor: ConversationAnchor): string {
  return anchor.step === undefined ? `t${anchor.turn}` : `t${anchor.turn} s${anchor.step}`;
}

/** 读侧一步到位:`l1_records.metadata_json` → UI 契约的标签数组。
 *  无锚点返回**空数组**(`UiRecord.sourceAnchors` 的契约语义是"空数组 = 无锚点",
 *  与 `readSourceAnchors` 的 `undefined` 区分开,故此处完成转换)。 */
export function sourceAnchorLabels(metadata: unknown): string[] {
  return (readSourceAnchors(metadata) ?? []).map(anchorLabel);
}
