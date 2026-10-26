/**
 * 图谱相关文案的**单一来源**（issue #16）。
 *
 * 为什么需要这个文件：图谱在界面上有**三件互不相同**的事，过去三处文案各写各的，
 * 撞名撞成了事故 ——
 *
 * | 概念 | 实体 | 作用 |
 * |---|---|---|
 * | 知识图谱（开关） | `live.graphEnabled` / `cfg.graph.enabled` | **生成**：把 L1 投影成实体与关系 |
 * | 图谱读工具 | `live.toolGraph` | **读取**：是否向模型注册 `memory_search_graph` 等 |
 * | 图谱投影预算 | `live.distillBudgets.graph` | **成本**：投影这一步的输出 token 上限 |
 *
 * 事故形态：概览页只有「图谱工具」（实为读工具封印），而「图谱投影」四个字出现在
 * **蒸馏预算的输入框**旁边（那是预算分层标签）。用户看到「图谱投影」以为自己开了投影，
 * 实际改的是 token 预算；`graph_nodes` 长期为 0 且看不出是"没开"还是"开了没跑"。
 */
export const GRAPH_FEATURE_LABEL = '知识图谱';
export const GRAPH_TOOL_LABEL = '图谱读工具';
export const GRAPH_BUDGET_LABEL = '图谱投影预算';

/** 空态/提示里指路用：告诉用户开关到底在哪，且说清它管的是写面。 */
export function graphEnableHint(): string {
  return `在设置页「概览 → ${GRAPH_FEATURE_LABEL}」打开开关后，存量记忆会逐批投影成实体与关系。`;
}

/** 开关下方的说明文案（未开/已开两态）。 */
export function graphSwitchDesc(on: boolean): string {
  return on
    ? '已开启：L1 记忆会投影成实体与关系，存量在启动/开启后逐批补齐（可与「图谱读工具」独立开关）'
    : '默认关闭：开启后才会生成知识图谱；这一步会逐条走 LLM，首次开启前会先给出预计耗时';
}
