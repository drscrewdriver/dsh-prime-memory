/**
 * L2/L3 文件存储单元测试:META 块、[DELETED] 硬删、文件名归一化(Windows 保留名)、
 * 场景导航、画像导航段追加/剥离、旧布局迁移、BM25 评分。
 */
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SceneStore, sanitizeFilename } from '../src/store/scenes.js';
import { NAV_HEADER, PersonaStore, stripSceneNavigation } from '../src/store/persona.js';
import { Bm25Index } from '../src/store/bm25.js';

let dir: string;
async function tmp(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-l2-'));
  return dir;
}
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const SCENE_WITH_META = `---
-----META-START-----
created: 2026-08-01T10:00:00.000Z
updated: 2026-09-01T12:00:00.000Z
summary: 用户的咖啡偏好与冲煮设备
heat: 7
-----META-END-----
---

# 咖啡

用户偏好浅烘手冲,使用 V60。
`;

describe('scene store', () => {
  it('write/list/read roundtrip parses META block', async () => {
    const dataDir = join(await tmp(), `t-${Math.random().toString(36).slice(2, 8)}`);
    const scenes = new SceneStore(dataDir, 'chat');
    await scenes.init();
    const name = await scenes.write('咖啡偏好.md', SCENE_WITH_META);
    expect(name).toBe('咖啡偏好.md');
    const list = await scenes.list();
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      path: '咖啡偏好.md',
      created: '2026-08-01T10:00:00.000Z',
      updated: '2026-09-01T12:00:00.000Z',
      summary: '用户的咖啡偏好与冲煮设备',
      heat: 7,
    });
    const body = await scenes.read('咖啡偏好');
    expect(body).toContain('V60');
  });

  it('[DELETED] content hard-deletes the file; legacy marker skipped in list', async () => {
    const dataDir = join(await tmp(), `t-${Math.random().toString(36).slice(2, 8)}`);
    const scenes = new SceneStore(dataDir, 'chat');
    await scenes.init();
    await scenes.write('临时场景', '内容');
    expect(await scenes.listFiles()).toContain('临时场景.md');
    await scenes.write('临时场景', '[DELETED]');
    expect(await scenes.listFiles()).not.toContain('临时场景.md');

    // 遗留的 [DELETED] 文件:list 容错跳过
    await writeFile(join(dataDir, 'scenes', 'chat', '遗留.md'), '[DELETED]');
    const list = await scenes.list();
    expect(list.find((s) => s.path === '遗留.md')).toBeUndefined();
  });

  it('family isolation: work scenes live in scenes/work/', async () => {
    const dataDir = join(await tmp(), `t-${Math.random().toString(36).slice(2, 8)}`);
    const work = new SceneStore(dataDir, 'work');
    await work.init();
    await work.write('发布流程', '正文');
    expect((await work.listFiles()).join(',')).toContain('发布流程.md');
    const chat = new SceneStore(dataDir, 'chat');
    await chat.init();
    expect(await chat.listFiles()).toEqual([]);
  });

  it('legacy layout migrates: scenes/ root .md files move into scenes/chat/', async () => {
    const dataDir = join(await tmp(), `t-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(join(dataDir, 'scenes'), { recursive: true });
    await writeFile(join(dataDir, 'scenes', '旧场景.md'), '# 旧');
    const chat = new SceneStore(dataDir, 'chat');
    await chat.init();
    expect((await chat.listFiles()).join(',')).toContain('旧场景.md');
    const root = await readdir(join(dataDir, 'scenes'));
    expect(root.filter((f) => f.endsWith('.md'))).toEqual([]);
  });

  it('navigation renders index with NAV_HEADER', async () => {
    const dataDir = join(await tmp(), `t-${Math.random().toString(36).slice(2, 8)}`);
    const scenes = new SceneStore(dataDir, 'chat');
    await scenes.init();
    expect(await scenes.navigation()).toBe('');
    await scenes.write('咖啡偏好', SCENE_WITH_META);
    const nav = await scenes.navigation();
    expect(nav.startsWith(NAV_HEADER)).toBe(true);
    expect(nav).toContain('`咖啡偏好.md`');
    expect(nav).toContain('memory_read_scene');
  });
});

describe('filename sanitization', () => {
  it('normalizes spaces/punct, enforces .md suffix', () => {
    expect(sanitizeFilename('My Scene: 咖啡 / 烘焙')).toBe('My-Scene-咖啡-烘焙.md');
    expect(sanitizeFilename('plain')).toBe('plain.md');
    expect(sanitizeFilename(' already.md ')).toBe('already.md');
  });

  it('avoids Windows reserved device names and overlong stems', () => {
    expect(sanitizeFilename('CON')).toBe('_CON.md');
    expect(sanitizeFilename('com1')).toBe('_com1.md');
    const long = sanitizeFilename(`${'x'.repeat(300)}.md`);
    expect(long.length).toBeLessThanOrEqual(124); // 120 stem + .md
    expect(long.endsWith('.md')).toBe(true);
    expect(sanitizeFilename('???')).toBe(''); // 全非法 → 拒绝
  });
});

describe('persona store', () => {
  it('read strips navigation; write preserves existing nav segment', async () => {
    const dataDir = join(await tmp(), `t-${Math.random().toString(36).slice(2, 8)}`);
    const persona = new PersonaStore(dataDir, 'chat');
    await persona.init();
    await persona.write('# 用户画像\n\n喜欢简洁。');
    expect(await persona.read()).toBe('# 用户画像\n\n喜欢简洁。');

    // LLM 输出含导航段时剥出保留,正文覆盖但导航拼回
    const withNav = `${NAV_HEADER}\n- \`a.md\` — A\n- \`b.md\` — B`;
    await persona.write(`# 新画像\n${withNav}`);
    expect(await persona.read()).toBe('# 新画像');
    const raw = await import('node:fs/promises').then((m) => m.readFile(join(dataDir, 'persona-chat.md'), 'utf-8'));
    expect(raw).toContain(NAV_HEADER);
    expect(raw).toContain('`a.md`');

    // 再次 write:旧导航保留
    await persona.write('# 更新画像');
    expect(await persona.read()).toBe('# 更新画像');
    const raw2 = await import('node:fs/promises').then((m) => m.readFile(join(dataDir, 'persona-chat.md'), 'utf-8'));
    expect(raw2).toContain(NAV_HEADER);
  });

  it('legacy persona.md renames to persona-chat.md (chat family only)', async () => {
    const dataDir = join(await tmp(), `t-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'persona.md'), '# 旧画像');
    const persona = new PersonaStore(dataDir, 'chat');
    await persona.init();
    expect(await persona.read()).toBe('# 旧画像');
    // work 族不触发迁移
    const dataDir2 = join(await tmp(), 'w');
    await mkdir(dataDir2, { recursive: true });
    await writeFile(join(dataDir2, 'persona.md'), '# 不动');
    await new PersonaStore(dataDir2, 'work').init();
    expect(await import('node:fs/promises').then((m) => m.readdir(dataDir2))).toContain('persona.md');
  });

  it('stripSceneNavigation cuts at header', () => {
    expect(stripSceneNavigation('正文')).toBe('正文');
    expect(stripSceneNavigation(`正文\n\n${NAV_HEADER}\n- x`)).toBe('正文');
  });
});

describe('bm25 index', () => {
  it('scores matching docs higher and respects topK/filter', () => {
    const idx = new Bm25Index();
    idx.rebuild([
      { id: 'a', text: '用户喜欢手冲咖啡,每周三次' },
      { id: 'b', text: '团队每周一站会' },
      { id: 'c', text: '周末去爬山' },
    ]);
    expect(idx.size).toBe(3);
    const hits = idx.search('咖啡', 2);
    expect(hits[0].id).toBe('a');
    const filtered = idx.search('每周', 5, (id) => id !== 'b');
    expect(filtered.find((h) => h.id === 'b')).toBeUndefined();
    expect(idx.search('不存在的词xyzzy', 5)).toEqual([]);
    // 空查询/空库
    idx.rebuild([]);
    expect(idx.search('咖啡', 5)).toEqual([]);
  });
});
