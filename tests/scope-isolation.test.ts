/**
 * §E 存储作用域 / task_28:隔离**真的生效**吗——端到端，走真实 SQLite。
 *
 * 为什么必须有这个文件:`workspaceId` 是**可选参数**，类型系统对"忘了传"完全沉默——
 * 忘传不会报错，只会静默地不做隔离。纯函数层（`scope-config.test.ts`）证明不了接线。
 * 故这里只跑真库真检索，用"两个工作区互相看不见"这一可观测事实钉住接线。
 *
 * 四条断言（每条都配了反向判据，防止写成恒真）:
 * ① **隔离生效**：ws-a 检索看不到 ws-b 的 `work` 记录；
 * ② **`global` 仍跨工作区可见**：标了 global 的 work 记录两边都看得到
 *    （少了这条，①无法区分"隔离生效"与"检索整体失效"——把结果全清空也能让①通过）；
 * ③ **`chat` 族默认不被隔离**：个人记忆本应跨项目（ADR-0008 条 2）；
 * ④ **不传 workspaceId = 不过滤**：这是零漂移的构造性保证——既有部署
 *    (`scope='global'`)压根不传这个参数，行为必须与改动前逐字一致。
 *
 * 另断言**去重候选层同样过滤**（ADR-0008 组合关系点名的那处接缝）:
 * 候选池决定新的去重决策，此处跨工作区会产出「项目 B 里看不见、却已经决定了
 * 项目 A 记忆去向」的记录——比不隔离更糟。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import type { MemoryFamily, MemoryRecord, MemoryScope } from '../src/types.js';

let dir: string;
let db: MemoryDb;
let store: L1Store;

/**
 * 工作区 fixture 必须是**当前平台 `path.resolve` 语义下的绝对路径**：这两个 id 会被原样写进
 * 库（`upsertL1Batch` 不做归一），而查询侧会经 `normalizeWorkspacePath` 归一（`path.resolve`
 * 恒用进程平台规则）。在 Linux runner 上 `e:\proj\a` 不是绝对路径，会被拼成
 * `/cwd/e:\proj\a`，与库里的原值失配——于是"本工作区记录可见"恒假，隔离用例全红。
 */
const IS_WIN = process.platform === 'win32';
const WS_A = IS_WIN ? 'e:\\proj\\a' : '/proj/a';
const WS_B = IS_WIN ? 'e:\\proj\\b' : '/proj/b';

/** 四条记录覆盖 ③ 里需要的全部组合。内容同含 `alpha`，保证 FTS 都能命中。 */
function rec(id: string, family: MemoryFamily, scope: MemoryScope, wsId: string): MemoryRecord {
  const now = Date.now();
  return {
    id,
    content: `alpha memory ${id}`,
    type: family === 'work' ? 'work_fact' : 'episodic',
    priority: 60,
    scene_name: 'scope-test',
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 0,
    family,
    scope,
    workspaceId: wsId,
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-scope-'));
  db = new MemoryDb(join(dir, 'memory.db'), 0);
  db.init();
  db.upsertL1Batch([
    rec('r-a-work', 'work', 'workspace', WS_A),
    rec('r-b-work', 'work', 'workspace', WS_B),
    rec('r-global-work', 'work', 'global', ''),
    rec('r-global-chat', 'chat', 'global', ''),
  ]);
  store = new L1Store(dir, db, undefined, 'keyword');
  await store.init();
});

afterAll(async () => {
  db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('task_28 §E 隔离生效（真库真检索）', () => {
  it('① ws-a 检索看不到 ws-b 的 work 记录', async () => {
    const hits = await store.search('alpha', 10, { workspaceId: WS_A });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('r-a-work');
    expect(ids).not.toContain('r-b-work');
  });

  it('② 对称：ws-b 看不到 ws-a 的（排除"只是单向漏了"）', async () => {
    const ids = (await store.search('alpha', 10, { workspaceId: WS_B })).map((h) => h.id);
    expect(ids).toContain('r-b-work');
    expect(ids).not.toContain('r-a-work');
  });

  it('② global 归属的 work 记录两个工作区都看得到（区分力：否则①可能是"检索全空"）', async () => {
    expect((await store.search('alpha', 10, { workspaceId: WS_A })).map((h) => h.id)).toContain('r-global-work');
    expect((await store.search('alpha', 10, { workspaceId: WS_B })).map((h) => h.id)).toContain('r-global-work');
  });

  it('③ chat 族默认不被隔离：ws-a 也看得到（个人记忆跨项目的默认语义）', async () => {
    const ids = (await store.search('alpha', 10, { workspaceId: WS_A })).map((h) => h.id);
    expect(ids).toContain('r-global-chat');
  });

  it('④ 不传 workspaceId = 不做任何过滤（零漂移的构造性保证）', async () => {
    const ids = (await store.search('alpha', 10, {})).map((h) => h.id);
    expect(ids.sort()).toEqual(['r-a-work', 'r-b-work', 'r-global-chat', 'r-global-work']);
  });

  it('④ 对照：传了 workspaceId 的结果是上面那个全集**真子集**（证明过滤确实改变了结果）', async () => {
    const filtered = (await store.search('alpha', 10, { workspaceId: WS_A })).map((h) => h.id);
    const all = (await store.search('alpha', 10, {})).map((h) => h.id);
    expect(filtered.length).toBeLessThan(all.length);
  });
});

describe('task_28 §E 去重候选层同样过滤（ADR-0008 点名的那处接缝）', () => {
  it('searchCandidates 在 ws-a 里看不到 ws-b 的 work 候选', async () => {
    const ids = (await store.searchCandidates('alpha', 10, 'work', WS_A)).map((r) => r.id);
    expect(ids).toContain('r-a-work');
    expect(ids).not.toContain('r-b-work');
  });

  it('searchCandidates 不传 workspaceId 时不过滤（既有调用方零行为变化）', async () => {
    const ids = (await store.searchCandidates('alpha', 10, 'work')).map((r) => r.id);
    expect(ids).toContain('r-b-work');
    expect(ids).toContain('r-a-work');
  });

  it('浏览路径 list 同样尊重可见范围（UI 不泄露跨工作区记录）', () => {
    const ids = store.list({ workspaceId: WS_A, limit: 50, offset: 0 }).items.map((r) => r.id);
    expect(ids).toContain('r-a-work');
    expect(ids).not.toContain('r-b-work');
  });
});

describe('task_28 §E 写入不变量：scope=global 的记录 workspace_id 恒为空串', () => {
  it('写出"global 却带工作区归属"的行是不可能的（语义含糊会被 SQL 直接观测到）', () => {
    const raw = new DatabaseSync(join(dir, 'memory.db'), { allowExtension: false });
    try {
      const bad = raw
        .prepare("SELECT COUNT(*) AS n FROM l1_records WHERE scope = 'global' AND workspace_id != ''")
        .get() as { n: number };
      expect(bad.n).toBe(0);
      const ok = raw
        .prepare("SELECT COUNT(*) AS n FROM l1_records WHERE scope = 'workspace' AND workspace_id = ''")
        .get() as { n: number };
      expect(ok.n).toBe(0); // workspace 归属也必须有非空工作区标识
    } finally {
      raw.close();
    }
  });
});
