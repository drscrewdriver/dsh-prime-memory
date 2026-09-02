/**
 * 领域类型与词汇表(净室重写)。
 *
 * 覆盖:记忆族/档位、Hall 目录、L0/L1 记录形状、抽取产出与族判定三级兜底、
 * L2 场景摘要与 L1 检索命中。字段名与取值是磁盘/管线两侧的既定契约,不可更名。
 */

/** 蒸馏 Prompt 家族:chat = 个人记忆(persona/episodic/instruction + 用户画像),work = 工作记忆(work_fact/work_task/work_method/work_artifact + Team Operating Doctrine)。 */
export type MemoryFamily = 'chat' | 'work';

/** 会话记忆档位:auto = 双族自动判定 | chat/work = 单族 | off = 本会话对记忆系统隐身。 */
export type MemoryMode = 'auto' | 'chat' | 'work' | 'off';

/** 蒸馏可用的档位(off 在捕获侧被拦截,永远到不了管线)。 */
export type ExtractMode = 'auto' | 'chat' | 'work';

/**
 * Hall(粗分类属性通道,与 family/type 正交):给 L1 记忆加一个跨族的可检索标签。
 * 主线 3 个默认启用;finance/journey 为实验性(默认不进 hall.enabled,显式加入才参与
 * 自动打标)。细粒度归属由 prompt 语义判断,拿不准时省略 hall(不进 General 兜底,避免噪声)。
 */
export interface HallDef {
  id: string;
  label: string;
  /** 实验性(默认不进 hall.enabled,需用户显式开启才参与自动打标/过滤)。 */
  experimental?: boolean;
}

export const HALL_CATALOG: HallDef[] = [
  { id: 'work', label: '工作' },
  { id: 'relationships', label: '人际关系' },
  { id: 'general', label: '通用' },
  { id: 'finance', label: '财务', experimental: true },
  { id: 'journey', label: '旅程', experimental: true },
];

/** 默认启用的 Hall id(主线 3;实验性条目要用户写进 config hall.enabled 才生效)。 */
export const HALL_DEFAULT_ENABLED = ['work', 'relationships', 'general'];

export type HallId = (typeof HALL_CATALOG)[number]['id'];

export function hallLabel(id: string): string {
  const h = HALL_CATALOG.find((x) => x.id === id);
  return h ? h.label : id;
}

/** 记录族标签推断:work_* 前缀 → work,其余(含 auto 档兜底)→ chat。 */
export function familyForType(type: string): MemoryFamily {
  return type.startsWith('work') ? 'work' : 'chat';
}

/** 日志接口(适配 ctx.logger)。 */
export interface MemoryLogger {
  debug?(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** L0 会话消息(管线内的运行时形态)。 */
export interface ConversationMessage {
  /** 唯一消息 ID(L1 prompt 的 source_message_ids 追踪用)。 */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** epoch ms */
  timestamp: number;
}

/** L0 JSONL 记录(一条消息一行,磁盘事实源形状)。 */
export interface L0MessageRecord {
  sessionId: string;
  recordedAt: string;
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/** L1 抽取产出(LLM 返回的记忆条目,尚未分配 record id)。 */
export interface ExtractedMemory {
  content: string;
  type: string;
  priority: number;
  source_message_ids: string[];
  metadata: Record<string, unknown>;
  /** 所属情境名(L1 抽取的情境切分结果)。 */
  scene_name: string;
  /** auto 档抽取输出的显式族判定(chat|work;纯档 Prompt 无此字段)。
   *  语境归族、形状不归族——避免"个人计划性事实被 work_* 形状吸走"的族错标。 */
  family?: string;
}

/** 抽取输出 family 字段归一:只认 chat|work,其余(缺省/非法值)交由调用方回落。 */
export function normExtractedFamily(raw: unknown): MemoryFamily | undefined {
  return raw === 'chat' || raw === 'work' ? raw : undefined;
}

/** 记录族三级兜底链:会话档位强制(纯档)→ 抽取显式判定(auto)→ type 前缀推导(旧输出兜底)。 */
export function resolveRecordFamily(
  forced: MemoryFamily | undefined,
  extracted: unknown,
  type: string,
): MemoryFamily {
  return forced ?? normExtractedFamily(extracted) ?? familyForType(type);
}

/** L1 持久化记录(磁盘与 DB 的权威形状;version/source_message_ids/metadata 由写入侧补默认)。 */
export interface MemoryRecord {
  id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** 合并/更新时保留的时间戳并集。 */
  timestamps: number[];
  createdAt: number;
  updatedAt: number;
  /** 每次 update/merge 合并 +1。 */
  version?: number;
  /** 来源消息 id(JSONL 事实源保留;检索库不存该列)。 */
  source_message_ids?: string[];
  /** 类型附加信息(episodic 的活动起止时间等)。 */
  metadata?: Record<string, unknown>;
  /** 来源会话(缺省 default;跨会话记忆共享)。 */
  sessionId?: string;
  /** 所属族(写入缺省由 familyForType(type) 回填;召回/浏览/去重候选按族过滤的唯一依据)。 */
  family?: MemoryFamily;
}

/** L2 场景块摘要(META 解析结果)。 */
export interface SceneSummary {
  path: string;
  created: string;
  updated: string;
  summary: string;
  heat: number;
}

/** L1 检索命中。 */
export interface L1Hit {
  id: string;
  content: string;
  type: string;
  scene_name: string;
  score: number;
  priority?: number;
  family?: MemoryFamily;
}
