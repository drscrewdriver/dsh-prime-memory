/**
 * 去重 prompt(批量冲突检测:store/update/merge/skip 决策词表)。
 *
 * §C 矛盾冻结(task_20):`conflictFreeze` 开启时额外注入 `conflict` 动作
 * (要求 winner/loser 两个不同 id),关闭时三份变体逐字不变。
 *
 * 净室重写说明:本文件的 prompt 文案按重写规格(Phase 2 决策)逐字沿用——
 * prompt 内容直接决定蒸馏质量,是已发布行为的一部分,不属于可自由重写文本;
 * 代码结构与注释随实现重写。
 */
export const CONFLICT_DETECTION_SYSTEM_PROMPT = `你是记忆冲突检测器。批量比较多条【新记忆】与【统一候选记忆池】中的已有记忆，逐条决定如何处理。

**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言；JSON 字段名、枚举值、record_id、ISO 时间戳保持英文。

## 核心规则

- **跨 type 合并**：不同 type（persona / episodic / instruction / work_fact / work_task / work_method / work_artifact）的记忆如果语义上描述同一事实/事件，**可以合并**。
- **多对多合并**：一条新记忆可以同时替换/合并候选池中的**多条**已有记忆（通过 target_ids 数组指定）。
- 合并后你必须判断新记忆的最佳 type（merged_type）。

## 判断逻辑

1. **分辨记忆性质**：
   - **状态类**（persona/instruction）：偏好、特质、长期设定、相对稳定的事实、行为规则
   - **事件类**（episodic）：一次性经历、带时间点的客观记录，建议合并同一件事的前因后果

2. **判断是否同一事实/事件**：主体相同、主题一致、时间接近、scene_name 相似

3. **选择动作**：
   - "store"：视为新信息，新增当前记忆。
   - "skip"：已有记忆更好，新记忆无增量或更模糊，忽略当前记忆。
   - "update"：同一事实/事件，新记忆在内容或时间上更优（更具体、更晚或纠错），以新记忆为主覆盖旧记忆，可保留旧记忆中仍正确的细节。
   - "merge"：同一事实或同一演化过程，多条记忆信息互补且不矛盾，合并成一条更完整记忆，信息尽量不冗余。

4. **策略倾向**：
   - 状态类：多条描述同一偏好/特质 → 倾向 merge；无增量 → skip；明确更新 → update
   - 事件类：同一事件的前因后果、不同阶段 → 倾向 merge 为一条完整叙述；完全相同 → skip
   - 跨类型示例：一条 episodic "用户在 2018 年开始做播客" + 一条 persona "用户有播客制作经验" → 可 merge 为一条 persona 或 episodic（取决于信息侧重）

5. **timestamp 处理**：
   - merge / update 时，merged_timestamps 应包含**所有相关记忆的时间戳并集**（去重排序）
   - 这样可以保留事件发生的完整时间线

## 输出格式

严格输出 JSON 数组，每个元素对应一条新记忆的决策。不输出任何其他内容：

[
  {
    "record_id": "新记忆的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要删除的候选记忆 record_id 1", "record_id 2"],
    "merged_content": "合并/更新后的记忆内容（merge/update 时必填）",
    "merged_type": "合并后的最佳 type：persona|episodic|instruction|work_fact|work_task|work_method|work_artifact（merge/update 时必填）",
    "merged_priority": 85,
    "merged_timestamps": ["合并后的时间戳数组，包含所有新旧记忆时间戳的并集（merge/update 时必填）"]
  }
]

字段说明：
- target_ids：要删除替换的旧记忆 ID **数组**（可以 1 条或多条）。store/skip 时省略或为空。
- merged_content：merge/update 时的最终记忆文本。store/skip 时省略。
- merged_type：merge/update 后记忆应归属的 type。根据合并后内容本质判断。
- merged_priority：merge/update 后的新优先级（0-100 整数，merge/update 时必填）。合并后信息更完整、更确定，通常应**酌情提升** priority（例如两条 priority 70 的记忆合并后可提升到 80）。参考标准：80-100（核心特质/重要事件），60-79（一般偏好/普通活动），<60（次要信息）。
- merged_timestamps：合并后的时间戳数组。收集新记忆 + 所有被合并旧记忆的时间戳，去重排序。`;
export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `你是团队工作记忆冲突检测器。批量比较多条【新记忆】与【统一候选记忆池】中的已有记忆，逐条决定如何处理。

**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言；JSON 字段名、枚举值、record_id、ISO 时间戳保持英文。

## 核心规则

- **跨 type 合并**：不同 type（work_fact / work_task / work_method / work_artifact）的记忆如果语义上描述同一工作对象、任务、方法或资产，**可以合并**。
- **多对多合并**：一条新记忆可以同时替换/合并候选池中的**多条**已有记忆（通过 target_ids 数组指定）。
- 合并后你必须判断新记忆的最佳 type（merged_type）。
- 记忆默认会在项目团队内共享，合并内容应只保留工作相关信息。

## 判断逻辑

1. **分辨记忆性质**：
   - **工作事实类（work_fact）**：项目事实、需求、决策、状态、风险、约束、实验结果、客户反馈。
   - **工作任务类（work_task）**：待办、owner、deadline、下一步计划、任务状态变化。
   - **工作方法类（work_method）**：SOP、禁忌、原则、经验、设计思路、判断标准、Agent 行为规则。
   - **工作资产类（work_artifact）**：文档、PR、Issue、Prompt、报告、代码分支、设计稿、链接等。

2. **判断是否同一工作对象/演化过程**：
   - 同一项目、模块、需求、任务、风险、决策、方法、资产，且 scene_name 或语义高度相似。
   - 同一任务的不同阶段、同一方法的补充、同一资产的版本或用途变化，通常可以合并。
   - 仅属于同一大项目但讨论对象不同，不应强行合并。

3. **选择动作**：
   - "store"：视为新信息，新增当前记忆。
   - "skip"：已有记忆更好，新记忆无增量或更模糊，忽略当前记忆。
   - "update"：同一工作对象，新记忆更具体、更新、更权威或纠正旧信息，以新记忆为主覆盖旧记忆，可保留旧记忆中仍正确的细节。
   - "merge"：同一工作对象或同一演化过程，新旧记忆互补且不矛盾，合并成一条更完整记忆，信息尽量不冗余。

4. **策略倾向**：
   - work_fact：同一事实/决策/状态的补充或修正 → 倾向 update 或 merge。
   - work_task：同一任务的 owner、deadline、状态变化 → 倾向 update；补充依赖或验收标准 → 倾向 merge。
   - work_method：同一 SOP、禁忌、原则、经验的补充 → 倾向 merge；更清晰通用的表述 → 倾向 update。
   - work_artifact：同一文档、PR、Prompt、报告等资产的用途、版本、链接补充 → 倾向 merge 或 update。
   - 跨类型示例：一条 work_fact "团队决定 L1 type 保持少量高层分类" + 一条 work_method "L1 type 不宜过细，否则影响 L2/L3 聚合" → 可 merge 为 work_method。

5. **timestamp 处理**：
   - merge / update 时，merged_timestamps 应包含**所有相关记忆的时间戳并集**（去重排序）。
   - 这样可以保留工作事实、任务或方法演化的完整时间线。

## 输出格式

严格输出 JSON 数组，每个元素对应一条新记忆的决策。不输出任何其他内容：

[
  {
    "record_id": "新记忆的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要删除的候选记忆 record_id 1", "record_id 2"],
    "merged_content": "合并/更新后的记忆内容（merge/update 时必填）",
    "merged_type": "合并后的最佳 type：work_fact|work_task|work_method|work_artifact（merge/update 时必填）",
    "merged_priority": 85,
    "merged_timestamps": ["合并后的时间戳数组，包含所有新旧记忆时间戳的并集（merge/update 时必填）"]
  }
]

字段说明：
- target_ids：要删除替换的旧记忆 ID **数组**（可以 1 条或多条）。store/skip 时省略或为空。
- merged_content：merge/update 时的最终记忆文本。store/skip 时省略。
- merged_type：merge/update 后记忆应归属的 type。根据合并后内容本质判断。
- merged_priority：merge/update 后的新优先级（0-100 整数，merge/update 时必填）。合并后信息更完整、更确定，通常应**酌情提升** priority。参考标准：80-100（关键事实/重要任务/核心方法/重要资产），60-79（一般工作信息），<60（次要信息）。
- merged_timestamps：合并后的时间戳数组。收集新记忆 + 所有被合并旧记忆的时间戳，去重排序。`;
export const ALL_CONFLICT_DETECTION_SYSTEM_PROMPT = `你是记忆冲突检测器。批量比较多条【新记忆】与【统一候选记忆池】中的已有记忆，逐条决定如何处理。候选池同时包含个人记忆（persona/episodic/instruction）与团队工作记忆（work_fact/work_task/work_method/work_artifact），判断时按各自语义处理。

**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言；JSON 字段名、枚举值、record_id、ISO 时间戳保持英文。

## 核心规则

- **跨 type 合并**：不同 type（persona / episodic / instruction / work_fact / work_task / work_method / work_artifact）的记忆如果语义上描述同一事实/事件/工作对象，**可以合并**。
- **多对多合并**：一条新记忆可以同时替换/合并候选池中的**多条**已有记忆（通过 target_ids 数组指定）。
- 合并后你必须判断新记忆的最佳 type（merged_type）。
- 工作记忆默认会在项目团队内共享，合并内容应只保留相关信息；个人记忆与工作记忆描述同一底层事实时可以合并，按合并后内容本质选择归属 type。

## 判断逻辑

1. **分辨记忆性质**：
   - **状态类**（persona/instruction）：偏好、特质、长期设定、相对稳定的事实、行为规则
   - **事件类**（episodic）：一次性经历、带时间点的客观记录，建议合并同一件事的前因后果
   - **工作事实类**（work_fact）：项目事实、需求、决策、状态、风险、约束、实验结果
   - **工作任务类**（work_task）：待办、owner、deadline、下一步计划、任务状态变化
   - **工作方法类**（work_method）：SOP、禁忌、原则、经验、设计思路、判断标准、Agent 行为规则
   - **工作资产类**（work_artifact）：文档、PR、Issue、Prompt、报告、代码分支、设计稿、链接等

2. **判断是否同一事实/事件/工作对象**：
   - 个人记忆：主体相同、主题一致、时间接近、scene_name 相似
   - 工作记忆：同一项目、模块、需求、任务、风险、决策、方法、资产，或同一任务的不同阶段、同一方法的补充、同一资产的版本变化，通常可以合并；仅同属一个大项目但讨论对象不同，不应强行合并

3. **选择动作**：
   - "store"：视为新信息，新增当前记忆。
   - "skip"：已有记忆更好，新记忆无增量或更模糊，忽略当前记忆。
   - "update"：同一事实/事件/工作对象，新记忆在内容或时间上更优（更具体、更晚、更权威或纠错），以新记忆为主覆盖旧记忆，可保留旧记忆中仍正确的细节。
   - "merge"：同一事实、同一演化过程或信息互补且不矛盾的多条记忆，合并成一条更完整记忆，信息尽量不冗余。

4. **策略倾向**：
   - 状态类：多条描述同一偏好/特质 → 倾向 merge；无增量 → skip；明确更新 → update
   - 事件类：同一事件的前因后果、不同阶段 → 倾向 merge 为一条完整叙述；完全相同 → skip
   - work_task：同一任务的 owner、deadline、状态变化 → 倾向 update；补充依赖或验收标准 → 倾向 merge
   - work_method：同一 SOP、禁忌、原则、经验的补充 → 倾向 merge；更清晰通用的表述 → 倾向 update
   - work_artifact：同一资产的用途、版本、链接补充 → 倾向 merge 或 update
   - 跨类型示例：一条 episodic "用户在 2018 年开始做播客" + 一条 persona "用户有播客制作经验" → 可 merge 为一条 persona 或 episodic（取决于信息侧重）

5. **timestamp 处理**：
   - merge / update 时，merged_timestamps 应包含**所有相关记忆的时间戳并集**（去重排序）
   - 这样可以保留事件与工作对象演化的完整时间线

## 输出格式

严格输出 JSON 数组，每个元素对应一条新记忆的决策。不输出任何其他内容：

[
  {
    "record_id": "新记忆的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要删除的候选记忆 record_id 1", "record_id 2"],
    "merged_content": "合并/更新后的记忆内容（merge/update 时必填）",
    "merged_type": "合并后的最佳 type：persona|episodic|instruction|work_fact|work_task|work_method|work_artifact（merge/update 时必填）",
    "merged_priority": 85,
    "merged_timestamps": ["合并后的时间戳数组，包含所有新旧记忆时间戳的并集（merge/update 时必填）"]
  }
]

字段说明：
- target_ids：要删除替换的旧记忆 ID **数组**（可以 1 条或多条）。store/skip 时省略或为空。
- merged_content：merge/update 时的最终记忆文本。store/skip 时省略。
- merged_type：merge/update 后记忆应归属的 type。根据合并后内容本质判断。
- merged_priority：merge/update 后的新优先级（0-100 整数，merge/update 时必填）。合并后信息更完整、更确定，通常应**酌情提升** priority。参考标准：80-100（核心特质/重要事件/关键事实/重要任务/核心方法/重要资产），60-79（一般信息），<60（次要信息）。
- merged_timestamps：合并后的时间戳数组。收集新记忆 + 所有被合并旧记忆的时间戳，去重排序。`;
/**
 * §C 矛盾冻结:注入 `conflict` 动作后,三份变体输出契约里的 action 枚举。
 * 用**字面量替换**而非把三份 base 改成函数——base 是已发布行为的一部分,
 * 关闭态必须逐字不变(见 task_23 的零漂移判据)。
 */
const ACTION_ENUM_BASE = '"action": "store|update|skip|merge"';
const ACTION_ENUM_FROZEN = '"action": "store|update|skip|merge|conflict"';
/**
 * §C 矛盾冻结追加的决策词表条款(与档位无关,三份变体共用)。
 *
 * 语义承自 mneme(dream layer **不**自动裁决 winner/loser):检测到矛盾后
 * 不是"拦住写入",而是"不自动裁决"——把冲突对停放到待审区。
 */
export const CONFLICT_ACTION_CLAUSE = `## 矛盾冻结动作（"conflict"）

上面四条动作在**判定冲突**时都不可用——"update" 与 "merge" 都会由你直接改写记忆，**没有"停下来等人裁决"这个选项**。故新增第五条动作：

- "conflict"：新记忆与候选池中某条已有记忆**描述同一事实/事件/工作对象，但内容互相矛盾**，且你**无法依据现有信息判定哪一方更可信**时使用。**不覆盖、不合并**：该条新记忆照常写入，与冲突的已有记忆作为**一对**停放到待人工裁决区，双方内容都不被改写。

### conflict 的追加输出字段

{
  "record_id": "本条新记忆的 record_id",
  "action": "conflict",
  "winner": "其中一方的 record_id",
  "loser": "另一方的 record_id"
}

- "winner" / "loser"：**二者必须不同**。取值均为 record_id，来自「本条新记忆的 record_id」或「候选池中的 record_id」。
- "winner" 只表示进入待裁决对时的排序位，**不代表最终结论**；最终结论由人工裁决写入。
- action 为 "conflict" 时**不要**输出 merged_content / merged_type / merged_priority / merged_timestamps——它们只属于 update / merge。

### 什么时候**不**用 conflict

- 新记忆更具体、更新、更权威，或能明确纠正旧记忆的错误 → 仍用 "update"。
- 新旧记忆信息互补且**不矛盾** → 仍用 "merge"。
- 只是同属一个主题但描述对象不同 → 仍用 "store"。

conflict 只留给"两边都像是对的、机器判不了"的情况——它消耗人的注意力，不可滥用。`;
/**
 * 把注入词表后的 prompt 交给调用方。
 *
 * 关闭态直接返回 base（逐字不变）；开启态先换掉 action 枚举行、再追加条款。
 * 枚举行未被找到时**不抛错**——条款自身也重述了完整输出契约，退化为
 * "只靠追加段覆盖"，属安全降级而非静默错误（回归由 task_20 的枚举行用例守住）。
 */
export function getConflictDetectionSystemPrompt(mode, opts) {
    const base = mode === 'auto'
        ? ALL_CONFLICT_DETECTION_SYSTEM_PROMPT
        : mode === 'work'
            ? WORK_CONFLICT_DETECTION_SYSTEM_PROMPT
            : CONFLICT_DETECTION_SYSTEM_PROMPT;
    if (!opts?.conflictFreeze)
        return base;
    const withEnum = base.includes(ACTION_ENUM_BASE)
        ? base.replace(ACTION_ENUM_BASE, ACTION_ENUM_FROZEN)
        : base;
    return `${withEnum}\n\n${CONFLICT_ACTION_CLAUSE}`;
}
/**
 * 格式化批量冲突检测 prompt（统一候选池）。
 */
export function formatBatchConflictPrompt(matches) {
    const unifiedPool = new Map();
    const perMemoryCandidateIds = new Map();
    for (const m of matches) {
        const candidateIds = [];
        for (const c of m.candidates) {
            if (!unifiedPool.has(c.id))
                unifiedPool.set(c.id, c);
            candidateIds.push(c.id);
        }
        perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
    }
    const poolList = Array.from(unifiedPool.values()).map((c) => ({
        record_id: c.id,
        content: c.content,
        type: c.type,
        priority: c.priority,
        scene_name: c.scene_name,
        timestamps: c.timestamps,
    }));
    let poolSection;
    if (poolList.length === 0) {
        poolSection = '## 统一候选记忆池\n\n（空，没有已有记忆，所有新记忆直接 store）';
    }
    else {
        const poolStr = JSON.stringify(poolList, null, 2);
        poolSection = `## 统一候选记忆池（共 ${poolList.length} 条已有记忆）\n\n${poolStr}`;
    }
    const memoryParts = matches.map((m, idx) => {
        const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
        const relatedNote = relatedIds.length > 0 ? JSON.stringify(relatedIds) : '[]（无相似候选，直接 store）';
        const memStr = JSON.stringify({
            record_id: m.newMemory.record_id,
            content: m.newMemory.content,
            type: m.newMemory.type,
            priority: m.newMemory.priority,
            scene_name: m.newMemory.scene_name,
        }, null, 2);
        return `### 第 ${idx + 1} 条新记忆 (record_id: ${m.newMemory.record_id})\n${memStr}\n\n【关联候选 ID】${relatedNote}`;
    });
    const newMemoriesText = memoryParts.join('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');
    return `**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言。

${poolSection}

${'═'.repeat(50)}

## 待判断的新记忆（共 ${matches.length} 条）

${newMemoriesText}

请逐条判断并输出决策 JSON 数组。当某条新记忆的候选列表为空时，该条直接输出 action=store。`;
}
