/**
 * 插件配置:Schemastery schema + 类型。
 *
 * 默认数据目录:$DSH_HOME/memory(用官方 dshHomePath 解析,DSH_HOME 缺省 ~/.dsh)。
 * 键名/默认值/取值范围是部署面契约(patch.yml 按"整行替换,不深合并"覆盖),不可更名。
 */
import Schema from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { HALL_DEFAULT_ENABLED } from './types.js';
/**
 * 蒸馏思考档位全词汇表(唯一事实源):'' = 自动(模型默认档 → high),
 * 其余为各适配器通用档位词汇(deepseek 认 'off',OpenAI 系是 'none')。
 * schema(config/settings)、运行时解析与 RPC 写入门共用,勿在别处再抄字面量表。
 */
export const EFFORT_CHOICES = ['', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const memorySchema = Schema.object({
    dataDir: Schema.string().default(''),
    family: Schema.union(['auto', 'chat', 'work']).default('auto'),
    capture: Schema.object({
        enabled: Schema.boolean().default(true),
        stripCodeBlocks: Schema.boolean().default(true),
        maxMessageChars: Schema.number().min(200).max(200_000).default(4000),
    }),
    extract: Schema.object({
        enabled: Schema.boolean().default(true),
        minMessages: Schema.number().min(1).max(100).default(6),
        idleSeconds: Schema.number().min(0).max(86_400).default(300),
        backgroundMessages: Schema.number().min(0).max(50).default(10),
        candidatePool: Schema.number().min(1).max(20).default(5),
    }),
    l2: Schema.object({
        enabled: Schema.boolean().default(true),
        minNewMemories: Schema.number().min(1).max(100).default(5),
        maxScenes: Schema.number().min(1).max(100).default(12),
        sceneContextLimit: Schema.number().min(0).max(20).default(3),
    }),
    l3: Schema.object({
        enabled: Schema.boolean().default(true),
        interval: Schema.number().min(1).max(200).default(20),
    }),
    // 知识图谱投影:默认关(新功能默认关,用户显式开启;开启后受运行时蒸馏门约束)
    graph: Schema.object({
        enabled: Schema.boolean().default(false),
    }),
    recall: Schema.object({
        enabled: Schema.boolean().default(true),
        maxResults: Schema.number().min(1).max(20).default(5),
        // 截断是引流——工具路径返回全文(注入形态契约见 ADR-0001)
        maxCharsPerMemory: Schema.number().min(0).max(100_000).default(500),
        maxTotalRecallChars: Schema.number().min(0).max(100_000).default(2000),
        timeoutMs: Schema.number().min(0).max(60_000).default(5000),
        includePersona: Schema.boolean().default(true),
        includeSceneNav: Schema.boolean().default(true),
        strategy: Schema.union(['keyword', 'embedding', 'hybrid']).default('hybrid'),
        scoreThreshold: Schema.number().min(0).max(1).default(0.3),
        // 时效衰减:乘法软加权 + 地板 0.5;0=关(bench 基线可比性可 pin 0)
        decayHalfLifeDays: Schema.number().min(0).max(3650).default(30),
    }),
    embedding: Schema.object({
        enabled: Schema.boolean().default(false),
        baseUrl: Schema.string().default(''),
        apiKey: Schema.string().default(''),
        model: Schema.string().default(''),
        // 0 = 纯 FTS 模式(合法值,勿设 min>0)
        dimensions: Schema.number().min(0).max(8192).default(0),
        maxInputChars: Schema.number().min(100).max(100_000).default(5000),
        timeoutMs: Schema.number().min(1000).max(300_000).default(10_000),
        allowLocalModels: Schema.boolean().default(true),
        mirror: Schema.string().default('https://hf-mirror.com'),
        proxy: Schema.string().default(''),
    }),
    llm: Schema.object({
        provider: Schema.string().default(''),
        model: Schema.string().default(''),
        // 压缩通道:'host' 复用宿主(默认);'direct' 插件原生直连,失败回退宿主路由
        mode: Schema.union(['host', 'direct']).default('host'),
        baseURL: Schema.string().default(''),
        apiKey: Schema.string().default(''),
        // 回退链:每条路由各享全额 timeoutMs(慢 TTFT 模型的回退位要留足首包时间);
        // 条目档位经能力钳制后发送
        fallbacks: Schema.array(Schema.object({
            provider: Schema.string().default(''),
            model: Schema.string().default(''),
            reasoningEffort: Schema.union([...EFFORT_CHOICES]).default(''),
        })).default([]),
        // 按层静态路由链:每层一条完整链(头行须双显式——启动侧只做形状默认,
        // 语义校验在解析侧防御 + 设置页写入门;空数组 = 该层跟随全局)
        layerRoutes: Schema.object({
            l1: Schema.array(Schema.object({
                provider: Schema.string().default(''),
                model: Schema.string().default(''),
                reasoningEffort: Schema.union([...EFFORT_CHOICES]).default(''),
            })).default([]),
            l2: Schema.array(Schema.object({
                provider: Schema.string().default(''),
                model: Schema.string().default(''),
                reasoningEffort: Schema.union([...EFFORT_CHOICES]).default(''),
            })).default([]),
            l3: Schema.array(Schema.object({
                provider: Schema.string().default(''),
                model: Schema.string().default(''),
                reasoningEffort: Schema.union([...EFFORT_CHOICES]).default(''),
            })).default([]),
        }).default({ l1: [], l2: [], l3: [] }),
        // 推理模型的 reasoning 计入输出预算:各蒸馏层显式传分层预算,本值为未分层调用的兜底总闸
        maxTokens: Schema.number().min(1024).max(1_000_000).default(65_536),
        // 蒸馏思考档位:'' = 自动(按模型能力解析);显式值仅在该模型声明支持时发送。
        // 旧默认 'off' 在非 deepseek 模型上必炸(400/本地拒绝)
        reasoningEffort: Schema.union([...EFFORT_CHOICES]).default(''),
        temperature: Schema.number().min(0).max(2).default(0.3),
        // 模型上下文 1M token,日常压到 ~700k 使用(中文按 1 字≈1 token 保守折算)
        maxInputChars: Schema.number().min(1000).max(1_000_000).default(700_000),
        timeoutMs: Schema.number().min(1000).max(600_000).default(120_000),
    }),
    hall: Schema.object({
        enabled: Schema.array(Schema.string()).default([...HALL_DEFAULT_ENABLED]),
    }),
    // token_cost 明细保留期(写入时滚动清理;0 = 永久保留)。成本看板「近 N 天」窗口上限同源
    tokenCost: Schema.object({
        retentionDays: Schema.number().min(0).max(3650).default(365),
    }),
    tools: Schema.boolean().default(true),
    benchControl: Schema.boolean().default(false),
});
export function resolveDataDir(cfg) {
    if (cfg.dataDir)
        return cfg.dataDir;
    return dshHomePath('memory');
}
