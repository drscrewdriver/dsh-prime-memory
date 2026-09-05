/**
 * 领域类型与词汇表(净室重写)。
 *
 * 覆盖:记忆族/档位、Hall 目录、L0/L1 记录形状、抽取产出与族判定三级兜底、
 * L2 场景摘要与 L1 检索命中。字段名与取值是磁盘/管线两侧的既定契约,不可更名。
 */
export const HALL_CATALOG = [
    { id: 'work', label: '工作' },
    { id: 'relationships', label: '人际关系' },
    { id: 'general', label: '通用' },
    { id: 'finance', label: '财务', experimental: true },
    { id: 'journey', label: '旅程', experimental: true },
];
/** 默认启用的 Hall id(主线 3;实验性条目要用户写进 config hall.enabled 才生效)。 */
export const HALL_DEFAULT_ENABLED = ['work', 'relationships', 'general'];
export function hallLabel(id) {
    const h = HALL_CATALOG.find((x) => x.id === id);
    return h ? h.label : id;
}
/** 记录族标签推断:work_* 前缀 → work,其余(含 auto 档兜底)→ chat。 */
export function familyForType(type) {
    return type.startsWith('work') ? 'work' : 'chat';
}
/** 抽取输出 family 字段归一:只认 chat|work,其余(缺省/非法值)交由调用方回落。 */
export function normExtractedFamily(raw) {
    return raw === 'chat' || raw === 'work' ? raw : undefined;
}
/** 记录族三级兜底链:会话档位强制(纯档)→ 抽取显式判定(auto)→ type 前缀推导(旧输出兜底)。 */
export function resolveRecordFamily(forced, extracted, type) {
    return forced ?? normExtractedFamily(extracted) ?? familyForType(type);
}
