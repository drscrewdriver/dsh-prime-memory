/**
 * 防再发守卫：工具「声明面 ↔ 实际返回视图」不得漂移（issue #23 的同类面机械闸）。
 *
 * 钉一件事：宿主对工具输出做无损校验，`additionalProperties: false` 下**实际返回对象里
 * 出现未声明的键即整工具被拒**（"is not a declared property"）。这个约束在
 * `src/tools/index.ts` 里原本只靠该文件自己的一句注释维持（"schema 必须跟视图同步"），
 * 而注释不是闸 —— #23 就是视图加了 `winner_maturity`/`loser_maturity` 两笔旁注、声明面
 * 没跟着走，于是 `memory_conflicts` 从 0.26.11 起每次调用都被拒，跨 5 个版本无人发现。
 *
 * 本文件把该纪律换成机械判据：对读工具**真实执行一次**，把返回对象里所有键路径拿去
 * 对照它自己声明的 `output.schema`，多一个键就红。
 *
 * 不测什么（诚实标注覆盖面边界）：
 * - 不校验值类型/枚举取值是否匹配（那是宿主侧的另一类拒绝，本仓另有 schema 编译用例）；
 *   本守卫只咬「未声明的多余键」这一种，也正是 #23 的形状。
 * - 只覆盖下表列出的读工具。写侧工具（memory_add/delete/update/import 等）会改库，
 *   不在只读守卫范围内；它们的 schema 漂移由各自的用例负责。
 * - 不穷举每个工具的每一条返回分支：种子库只保证「有数据」与「无数据」两种形态，
 *   稀有分支（如 off 档 notice）由各工具自身的用例覆盖。
 * - 不连宿主：这里复刻的是拒绝**判据**（未声明键），不是宿主的完整校验器。
 *
 * 另有一条 describe 守 `interpolate` 声明（issue #24 的同类面）：宿主对 systemPrompt
 * 贡献项的 interpolate 缺省按 true 处理，正文含字面 `{{...}}` 时在 prompt 组装期抛错、
 * 整轮报废 —— 所以每个注册点都必须**显式**声明该键，而不是"看起来不需要就省略"。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

import { registerMemoryTools } from '../src/tools/index.js';
import { buildConflictPair } from '../src/store/conflicts.js';
import { SlotStore } from '../src/store/slots.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { L0Store } from '../src/store/l0.js';
import { L1Store } from '../src/store/l1.js';
import { SceneStore } from '../src/store/scenes.js';
import { PersonaStore } from '../src/store/persona.js';
import { SessionModeStore } from '../src/store/session-modes.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryLiveSettings } from '../src/contract.js';
import type { MemoryConfig } from '../src/config.js';
import type { MemoryLogger } from '../src/types.js';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

let dir: string;
const openDbs: MemoryDb[] = [];
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-view-sync-'));
  return dir;
}
afterAll(async () => {
  openDbs.forEach((db) => {
    try { db.close(); } catch { /* 已关 */ }
  });
  openDbs.length = 0;
  if (!dir) return;
  // 与 tools.test.ts 同款:Windows Defender 会短暂锁住刚写完的 memory.db
  for (let i = 0; i < 5; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  await rm(dir, { recursive: true, force: true });
});

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface CapturedTool {
  name: string;
  output?: { schema?: unknown };
  execute: (args: Record<string, unknown>, exec?: { agent?: { id?: string } }) => Promise<unknown>;
}

/** 最小装配：只需读工具能跑通，故 stores 用真库、live 用手写对象。 */
async function setup(opts: { conflictFreeze?: boolean } = {}) {
  const dataDir = join(await tmp(), `vs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
  db.init();
  openDbs.push(db);
  const l1 = new L1Store(dataDir, db, undefined, 'hybrid', noopLogger, 0);
  const l0 = new L0Store(db);
  await l1.init();
  const now = Date.now();
  await l1.appendNew([
    { id: 'r1', content: '用户喜欢手冲咖啡', type: 'preference', priority: 60, scene_name: '日常', timestamps: [now], createdAt: now, updatedAt: now },
    { id: 'r2', content: '团队用 GitLab CI', type: 'work_fact', priority: 50, scene_name: '基建', timestamps: [now], createdAt: now, updatedAt: now },
  ]);
  if (opts.conflictFreeze === true) {
    // 一对冻结冲突：r1 胜 r2 负。成熟度旁注正是从这条对的两侧记录派生的，必须真有数据
    // 才能让 winner_maturity/loser_maturity 出现在视图里（空队列只会走 enabled:false 分支）。
    l1.recordConflictPending([
      buildConflictPair({
        runId: 'run-vs', winnerId: 'r1', loserId: 'r2',
        createdAt: new Date(now).toISOString(),
      }),
    ]);
  }
  const scenes = { chat: new SceneStore(dataDir, 'chat'), work: new SceneStore(dataDir, 'work') };
  await scenes.chat.init();
  await scenes.work.init();
  await scenes.chat.write('咖啡.md', '# 咖啡偏好');
  const persona = { chat: new PersonaStore(dataDir, 'chat'), work: new PersonaStore(dataDir, 'work') };
  await persona.chat.init();
  await persona.work.init();
  await persona.chat.write('# 用户画像');

  const live = {
    enabled: true, capture: true, distill: true, recall: true,
    reasoningEffort: '', distillProvider: '', distillModel: '', distillChain: [] as MemoryLiveSettings['distillChain'],
    distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0, graph: 0 }, distillMaxInputChars: 0,
    distillLayerChains: { l1: [], l2: [], l3: [] } as MemoryLiveSettings['distillLayerChains'],
    distillMode: '', directBaseURL: '', directApiKey: '',
    embedRemoteBaseURL: '', embedRemoteApiKey: '', embedRemoteModel: '', embedRemoteDimensions: 0,
    memoryMutate: false, skillsEnabled: false, toolSkills: true,
    conflictFreeze: opts.conflictFreeze === true,
  } as unknown as MemoryLiveSettings;
  const liveHandle: LiveSettingsHandle = { supported: true, get: () => live, update: async () => {} };
  const modes = new SessionModeStore('/nonexistent', 'auto');

  const registered: CapturedTool[] = [];
  const ctx = {
    tools: {
      register: (t: ToolDefinition) => {
        registered.push(t as unknown as CapturedTool);
        return () => {};
      },
    },
  } as unknown as Parameters<typeof registerMemoryTools>[0];
  const cfg = {
    tools: true,
    recall: { maxResults: 5 },
    skills: { enabled: false },
  } as unknown as MemoryConfig;
  const stores = { l1, l0, db, scenes, persona, slots: new SlotStore(dataDir) } as unknown as Parameters<typeof registerMemoryTools>[2];
  registerMemoryTools(ctx, cfg, stores, noopLogger, modes, liveHandle);

  const byName = (name: string): CapturedTool => {
    const t = registered.find((x) => x.name === name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t;
  };
  return { byName, l1, db, names: registered.map((t) => t.name).sort() };
}

/* ----------------------------------------------------------- 未声明键采集 */

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, unknown>;
  items?: unknown;
  additionalProperties?: unknown;
  oneOf?: unknown[];
  anyOf?: unknown[];
}

const asObjectKeys = (v: unknown): string[] => (v && typeof v === 'object' ? Object.keys(v) : []);

/** 沿「实际值的形状」走声明 schema，收集值里有、声明里没有的键。 */
function collectUndeclared(value: unknown, schema: SchemaNode | undefined, path: string, out: string[], depth = 0): void {
  if (depth > 6) return; // 视图深度实测 ≤4，留余量并防环
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectUndeclared(value[i], arrayItemSchema(schema), `${path}[${i}]`, out, depth + 1);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (schema === undefined) return; // 无声明可比（如 schema 缺省）——交由下方用例保证有声明

  const objectSchema: SchemaNode | undefined =
    schema.type === 'object' || schema.properties !== undefined ? schema : undefined;
  if (objectSchema === undefined) {
    // oneOf/anyOf：命中任一分支即视为已声明；一个都不命中则取各分支的键并集去比，
    // 从而把"视图新增了任何分支都没准备的键"暴露出来。
    const branches = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])] as SchemaNode[];
    if (branches.length === 0) return;
    const hit = branches.find((b) => !hasUndeclared(value, b));
    if (hit !== undefined) {
      collectUndeclared(value, hit, path, out, depth + 1);
      return;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const declared = branches.some((b) => asObjectKeys(b.properties).includes(key));
      if (!declared) out.push(`${path}.${key}`);
      else collectUndeclared((value as Record<string, unknown>)[key], firstMatchingBranch(branches, key), `${path}.${key}`, out, depth + 1);
    }
    return;
  }

  const props = objectSchema.properties ?? {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) {
      out.push(`${path}.${key}`);
      continue;
    }
    collectUndeclared(child, props[key] as SchemaNode, `${path}.${key}`, out, depth + 1);
  }
}

function arrayItemSchema(schema: SchemaNode | undefined): SchemaNode | undefined {
  if (schema === undefined) return undefined;
  const items = schema.items;
  if (Array.isArray(items)) return undefined; // 元组形态：本仓未见，遇到再扩
  return items as SchemaNode | undefined;
}

function hasUndeclared(value: unknown, schema: SchemaNode): boolean {
  const out: string[] = [];
  collectUndeclared(value, schema, '$', out);
  return out.length > 0;
}

function firstMatchingBranch(branches: SchemaNode[], key: string): SchemaNode | undefined {
  return branches.find((b) => asObjectKeys(b.properties).includes(key))?.properties?.[key] as SchemaNode | undefined;
}

/* ------------------------------------------------------------------ 用例 */

describe('工具输出视图 ↔ 声明 schema 不得漂移（#23 同类面）', () => {
  it('memory_conflicts 带真实冻结对时，返回的每个键都已声明', async () => {
    const { byName } = await setup({ conflictFreeze: true });
    const tool = byName('memory_conflicts');
    const value = await tool.execute({ limit: 10 }, { agent: { id: 'auto-sess' } });
    const view = value as { enabled: boolean; items: Array<Record<string, unknown>> };
    // 前置自检：种子必须真产出了至少一对，否则本用例退化成空队列、测不到 items 的键集
    expect(view.enabled).toBe(true);
    expect(view.items.length).toBeGreaterThan(0);

    const undeclared: string[] = [];
    collectUndeclared(value, tool.output?.schema as SchemaNode, '$', undeclared);
    // #23 的现场就是这两笔：视图有、声明没有 → 宿主逐条拒
    expect(view.items[0]).toHaveProperty('winner_maturity');
    expect(view.items[0]).toHaveProperty('loser_maturity');
    expect(undeclared).toEqual([]);
  });

  it('同一视图多一个未声明键时守卫必须转红（自证有效性）', async () => {
    const { byName } = await setup({ conflictFreeze: true });
    const tool = byName('memory_conflicts');
    const value = await tool.execute({ limit: 10 }, { agent: { id: 'auto-sess' } });
    // 不改源码，在测试内复刻「改视图忘改 schema」这一步
    const mutated = JSON.parse(JSON.stringify(value)) as { items: Array<Record<string, unknown>> };
    mutated.items[0].who_knows_what = 'x';
    const undeclared: string[] = [];
    collectUndeclared(mutated, tool.output?.schema as SchemaNode, '$', undeclared);
    expect(undeclared).toContain('$.items[0].who_knows_what');
  });

  const readOnly: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'memory_conflicts', args: {} },
    { name: 'memory_conflicts_rejected', args: {} },
    { name: 'memory_receipts', args: { record_id: 'r1' } },
    { name: 'memory_ruminate_status', args: {} },
    { name: 'memory_search', args: { query: '咖啡' } },
    { name: 'memory_read_scene', args: { path: 'persona-chat.md' } },
    { name: 'memory_room_review', args: { action: 'next' } },
  ];
  for (const { name, args } of readOnly) {
    it(`${name} 的返回键全部落在声明内`, async () => {
      const { byName } = await setup({ conflictFreeze: true });
      const tool = byName(name);
      expect(tool.output?.schema, `${name} 必须有 output.schema 声明`).toBeTruthy();
      const value = await tool.execute(args, { agent: { id: 'auto-sess' } });
      const undeclared: string[] = [];
      collectUndeclared(value, tool.output?.schema as SchemaNode, '$', undeclared);
      expect(undeclared, `${name} 返回了未声明的键`).toEqual([]);
    });
  }
});

describe('systemPrompt 注册面必须显式声明 interpolate（#24 同类面）', () => {
  const repoRoot = join(__dirname, '..');

  function* tsFiles(root: string, rel = ''): Generator<string> {
    const abs = join(root, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const childRel = rel === '' ? entry.name : join(rel, entry.name);
      if (entry.isDirectory()) yield* tsFiles(root, childRel);
      else if (entry.name.endsWith('.ts')) yield join(root, childRel);
    }
  }

  /** 从 `{` 起按括号配平取整段入参（正文里的嵌套对象/箭头函数体都在括号内）。 */
  function balancedObject(source: string, openBrace: number): string {
    let depth = 0;
    for (let i = openBrace; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return source.slice(openBrace, i + 1);
      }
    }
    return source.slice(openBrace);
  }

  it('每个 systemPrompt.context/section 注册块的入参都含 interpolate 键', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of tsFiles(repoRoot)) {
      if (!file.includes(`${join('src')}`) && !file.includes(`${join('client')}`)) continue;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('systemPrompt')) continue;
      const re = /systemPrompt\s*[.\s]*\n?\s*(context|section)\s*\(\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        seen++;
        const open = source.indexOf('{', m.index + m[0].length - 1);
        const body = balancedObject(source, open);
        if (!/\binterpolate\s*:/.test(body)) {
          const line = source.slice(0, m.index).split('\n').length;
          offenders.push(`${file.replace(repoRoot, '')}:${line}`);
        }
      }
    }
    // 至少扫到一处，否则说明匹配式失效（那时"零违例"是假绿）
    expect(seen).toBeGreaterThan(0);
    expect(offenders, `以下注册点省略了 interpolate，宿主将按 true 处理并可能抛错`).toEqual([]);
  });
});
