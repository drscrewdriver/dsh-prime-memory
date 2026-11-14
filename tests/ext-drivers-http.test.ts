/**
 * 六家 HTTP 驱动契约测(计划 T1.13 的 HTTP 半边)。
 *
 * 手法:注入 fetch mock(驱动构造函数留了注入位,不 stub 全局),fixture 直接内联
 * 参考实现 driver.spec 的响应形状;钉四类事实:
 * ① 请求形态(路径/方法/头)与参考实现逐条一致——漂移即红;
 * ② 字段映射容错(memory/text/content 三候选、scores.final 嵌套、缺 id 行剔除);
 * ③ 错误面(HTTP 非 2xx 带详情、信封 error、空 endpoint 配置错);
 * ④ Phase 1 写侧桩:remember/forget 恒 failed,不发起网络。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExtDriverFactoryInput, ExtSpace } from '../src/ext-memory/types.js';
import { HTTP_DRIVER_FACTORIES } from '../src/ext-memory/drivers/http-drivers.js';

type FetchMock = ReturnType<typeof vi.fn>;

function input(over: Partial<ExtDriverFactoryInput> & { fetch: FetchMock }): ExtDriverFactoryInput {
  return { id: 'd1', connection: { endpoint: 'https://x.test', apiKey: 'k1', space: 'sp1' }, requestTimeoutMs: 15_000, ...over };
}

function space(over: Partial<ExtSpace> = {}): ExtSpace {
  return { spaceId: 'd1:sp1', driverId: 'd1', externalId: 'sp1', name: 'sp1', description: '', ...over };
}

function fetchJson(body: unknown, ok = true, status = 200): FetchMock {
  return vi.fn(async () => ({ ok, status, text: async () => JSON.stringify(body) }));
}

/** 读 fetch 实际收到的请求头(httpJson 会 `new Headers()` 包装,大小写不敏感)。 */
function hdr(init: RequestInit, name: string): string | null {
  return init.headers instanceof Headers ? init.headers.get(name) : ((init.headers as Record<string, string>)[name] ?? null);
}

const cfgOf = (typeId: keyof typeof HTTP_DRIVER_FACTORIES) => HTTP_DRIVER_FACTORIES[typeId];

describe('mem0 driver', () => {
  it('platform:POST /v3/memories/search/ + Token 头;字段三候选映射 + categories 归 tags', async () => {
    const f = fetchJson({
      results: [
        { id: 'm1', memory: '内容甲', score: 0.9, categories: ['pref'], created_at: '2026-01-01' },
        { id: 'm2', text: '内容乙' },
        { id: '', memory: '缺 id 剔除' },
      ],
    });
    const d = cfgOf('mem0')(input({ fetch: f }));
    const r = await d.search(space(), { query: '内容', limit: 5 });
    expect(r.results.map((h) => h.externalId)).toEqual(['m1', 'm2']);
    expect(r.results[0]!.content).toBe('内容甲');
    expect(r.results[0]!.tags).toEqual(['pref']);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.test/v3/memories/search/');
    expect(init.method).toBe('POST');
    expect(hdr(init, 'authorization')).toBe('Token k1');
    expect(JSON.parse(String(init.body))).toMatchObject({ query: '内容', top_k: 5, filters: { user_id: 'dsh-user', agent_id: 'dsh' } });
  });

  it('self-hosted:裸 /search 路径 + X-API-Key 头', async () => {
    const f = fetchJson({ results: [] });
    const d = cfgOf('mem0')(input({ fetch: f, connection: { endpoint: 'http://localhost:8888', apiKey: 'k1', space: 'sp1', mode: 'self-hosted' } }));
    await d.search(space(), { query: 'q' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8888/search');
    expect(hdr(init, 'x-api-key')).toBe('k1');
  });

  it('HTTP 5xx → 抛错带响应详情;Phase 3 实装后 remember 同样触网并透传错', async () => {
    const f = fetchJson({ detail: 'rate limited' }, false, 429);
    const d = cfgOf('mem0')(input({ fetch: f }));
    await expect(d.search(space(), { query: 'q' })).rejects.toThrow(/429.*rate limited/);
    await expect(d.remember(space(), { content: 'x' })).rejects.toThrow(/429.*rate limited/);
  });
});

describe('hindsight driver', () => {
  it('bank 路径 + scores.final 提取 + status 打 /health/live 不打 recall', async () => {
    const f = fetchJson({ results: [{ id: 'h1', text: '事实', scores: { final: 0.42 }, entities: '张三(角色), 李四', type: 'world' }] });
    const d = cfgOf('hindsight')(input({ fetch: f }));
    const r = await d.search(space({ externalId: 'bank-9' }), { query: 'q', limit: 3 });
    expect(r.results[0]).toMatchObject({ externalId: 'h1', score: 0.42, entities: ['张三', '李四'], category: 'world' });
    const [url] = f.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://x.test/v1/default/banks/bank-9/memories/recall');
    const fs = fetchJson({});
    const d2 = cfgOf('hindsight')(input({ fetch: fs }));
    await expect(d2.status()).resolves.toMatchObject({ healthy: true });
    expect((fs.mock.calls[0] as unknown as [string])[0]).toBe('https://x.test/health/live');
  });
});

describe('openviking driver', () => {
  it('信封拆 result;status:error 视同失败;uri 即 id + categoryFromUri', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', result: { memories: [{ uri: 'viking://user/memories/prefs/a.md', overview: '概要', score: 0.7 }] } }) }));
    const d = cfgOf('openviking')(input({ fetch: f }));
    const r = await d.search(space({ externalId: 'viking://user/memories' }), { query: 'q' });
    expect(r.results[0]).toMatchObject({ externalId: 'viking://user/memories/prefs/a.md', content: '概要', category: 'prefs' });
    const fe = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'error', error: { message: 'bad account' } }) }));
    const de = cfgOf('openviking')(input({ fetch: fe }));
    await expect(de.search(space(), { query: 'q' })).rejects.toThrow(/bad account/);
  });

  it('自定义头三件套(account/user/actor)只在配置了才发', async () => {
    const f = fetchJson({ result: { memories: [] } });
    const d = cfgOf('openviking')(input({ fetch: f, connection: { endpoint: 'https://x.test', apiKey: 'k', space: 'viking://user/memories', account: 'ac1', user: 'u9' } }));
    await d.search(space(), { query: 'q' });
    const headers = (f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer k');
    expect(headers.get('x-openviking-account')).toBe('ac1');
    expect(headers.get('x-openviking-user')).toBe('u9');
    expect(headers.get('x-openviking-actor-peer')).toBeNull();
  });
});

describe('honcho / retaindb / supermemory drivers', () => {
  it('honcho:conclusions/query + 双 peer 过滤;不产 score(none 语义)', async () => {
    const f = fetchJson({ items: [{ id: 'c1', content: '结论', level: 'persona' }] });
    const d = cfgOf('honcho')(input({ fetch: f }));
    const r = await d.search(space(), { query: 'q' });
    expect(r.results[0]!.score).toBeUndefined();
    expect(r.results[0]!.category).toBe('persona');
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.filters).toEqual({ observer_id: 'dsh', observed_id: 'dsh-user' });
  });

  it('retaindb:/v1/memory/search 双挂鉴权头 + include_pending', async () => {
    const f = fetchJson({ results: [{ id: 'r1', content: 'x', similarity: 0.6, memory_type: 'factual' }] });
    const d = cfgOf('retaindb')(input({ fetch: f }));
    const r = await d.search(space({ externalId: 'proj-a' }), { query: 'q' });
    expect(r.results[0]!.score).toBe(0.6);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(hdr(init, 'authorization')).toBe('Bearer k1');
    expect(hdr(init, 'x-api-key')).toBe('k1');
    expect(JSON.parse(String(init.body))).toMatchObject({ project: 'proj-a', include_pending: true });
  });

  it('supermemory:/v4/search containerTag 隔离 + metadata.category 提取', async () => {
    const f = fetchJson({ results: [{ id: 's1', memory: 'x', similarity: 0.5, metadata: { category: 'doc' } }] });
    const d = cfgOf('supermemory')(input({ fetch: f }));
    const r = await d.search(space({ externalId: 'tag1' }), { query: 'q' });
    expect(r.results[0]!.category).toBe('doc');
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ q: 'q', containerTag: 'tag1', searchMode: 'hybrid' });
  });

  it('端点未配置:首用即报配置错(不是静默空结果)', async () => {
    const d = cfgOf('honcho')(input({ fetch: vi.fn(), connection: { endpoint: '', apiKey: '', space: 'w1' } }));
    await expect(d.search(space(), { query: 'q' })).rejects.toThrow(/endpoint is not configured/);
  });
});

describe('Phase 3 hard-delete 五家写路径(T3.2)', () => {
  it('mem0:platform 回 accepted+eventId;self-hosted 走 /memories 同步 committed', async () => {
    const f = fetchJson({ id: 'm-1', event_id: 'ev-1', status: 'PENDING' });
    const d = cfgOf('mem0')(input({ fetch: f, connection: { endpoint: 'https://x.test', apiKey: 'k', mode: 'platform', userId: 'u1', agentId: 'a1' } }));
    const r = await d.remember(space(), { content: '甲' });
    expect(r).toMatchObject({ completion: 'accepted', pendingOp: 'ev-1', externalId: 'm-1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.test/v3/memories/add/');
    expect(JSON.parse(String(init.body))).toMatchObject({ user_id: 'u1', agent_id: 'a1', messages: [{ role: 'user', content: '甲' }] });
    const fs2 = fetchJson({ id: 'm-2' });
    const d2 = cfgOf('mem0')(input({ fetch: fs2, connection: { endpoint: 'https://x.test', apiKey: 'k', mode: 'self-hosted' } }));
    await expect(d2.remember(space(), { content: '乙' })).resolves.toEqual({ completion: 'committed', externalId: 'm-2' });
    expect((fs2.mock.calls[0] as unknown as [string])[0]).toBe('https://x.test/memories');
    await d2.forget(space(), 'm-2');
    expect((fs2.mock.calls[1] as unknown as [string])[0]).toBe('https://x.test/memories/m-2');
  });

  it('honcho:conclusion 入库回 id;forget DELETE conclusions/{id}', async () => {
    const f = fetchJson({ items: [{ id: 'c-9', content: '甲' }] });
    const d = cfgOf('honcho')(input({ fetch: f, connection: { endpoint: 'https://x.test', apiKey: 'k', space: 'ws1', agentId: 'a', userId: 'u' } }));
    const ws = space({ externalId: 'ws1' });
    await expect(d.remember(ws, { content: '甲' })).resolves.toEqual({ completion: 'committed', externalId: 'c-9' });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://x.test/v3/workspaces/ws1/conclusions');
    await d.forget(ws, 'c-9');
    const [u2, i2] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(u2).toBe('https://x.test/v3/workspaces/ws1/conclusions/c-9');
    expect(i2.method).toBe('DELETE');
  });

  it('openviking:session 三连 commit 回 taskId → accepted;无 taskId → skipped;forget 拒非 .md', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', result: { task_id: 't-1', archive_uri: 'viking://memories/a.md' } }) });
    const d = cfgOf('openviking')(input({ fetch: f, connection: { endpoint: 'https://x.test', apiKey: 'k', space: 'target' } }));
    await expect(d.remember(space({ externalId: 'viking://memories' }), { content: '甲' }))
      .resolves.toEqual({ completion: 'accepted', pendingOp: 't-1', externalId: 'viking://memories/a.md' });
    expect((f.mock.calls[2] as unknown as [string])[0]).toContain('/api/v1/sessions/');
    // 无 task_id 且无 archive_uri → skipped(远端未归档)
    const f2 = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', result: { reason: 'too short' } }) });
    const d2 = cfgOf('openviking')(input({ fetch: f2, connection: { endpoint: 'https://x.test', apiKey: 'k' } }));
    await expect(d2.remember(space(), { content: 'x' })).resolves.toEqual({ completion: 'skipped' });
    // forget 守卫:非 .md uri 直接拒
    await expect(d.forget(space(), 'viking://memories/a')).rejects.toThrow(/\.md/);
    const f3 = fetchJson({ estimated_deleted_count: 1 });
    const d3 = cfgOf('openviking')(input({ fetch: f3 }));
    await expect(d3.forget(space(), 'viking://memories/a.md')).resolves.toMatchObject({ completion: 'committed' });
    expect((f3.mock.calls[0] as unknown as [string])[0]).toContain('/api/v1/fs?uri=viking%3A%2F%2Fmemories%2Fa.md');
  });

  it('retaindb:/v1/memory 同步写回 id;forget 404 回落 /v1/memories', async () => {
    const f = fetchJson({ id: 'r-1' });
    const d = cfgOf('retaindb')(input({ fetch: f, connection: { endpoint: 'https://x.test', apiKey: 'k', space: 'proj' } }));
    await expect(d.remember(space({ externalId: 'proj' }), { content: '甲' })).resolves.toEqual({ completion: 'committed', externalId: 'r-1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.test/v1/memory');
    expect(JSON.parse(String(init.body))).toMatchObject({ project: 'proj', write_mode: 'sync' });
    const f2 = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{}' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' });
    const d2 = cfgOf('retaindb')(input({ fetch: f2 }));
    await expect(d2.forget(space(), 'r-1')).resolves.toMatchObject({ completion: 'committed' });
    expect((f2.mock.calls[1] as unknown as [string])[0]).toContain('/v1/memories/r-1');
  });
});

describe('Phase 2 soft 三家写路径(T2.4)', () => {
  it('hindsight.remember:异步入队只回 operationId(awaiting-settle 形态);forget=PATCH invalidate', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ operation_id: 'op-77', items_count: 1 }) }));
    const d = cfgOf('hindsight')(input({ fetch: f }));
    const receipt = await d.remember(space({ externalId: 'bank-9' }), { content: '新事实', category: 'work_fact' });
    expect(receipt).toEqual({ completion: 'accepted', pendingOp: 'op-77' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.test/v1/default/banks/bank-9/memories');
    expect(JSON.parse(String(init.body))).toMatchObject({ async: true });
    await d.forget(space({ externalId: 'bank-9' }), 'mem-5');
    const [u2, i2] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(u2).toBe('https://x.test/v1/default/banks/bank-9/memories/mem-5');
    expect(i2.method).toBe('PATCH');
    expect(JSON.parse(String(i2.body))).toMatchObject({ state: 'invalidated' });
  });

  it('hindsight.list:state=valid 参数与行映射(settle 回捞面)', async () => {
    const f = fetchJson({ items: [{ id: 'm1', text: '内容', type: 'world' }] });
    const d = cfgOf('hindsight')(input({ fetch: f }));
    const page = await d.list!(space({ externalId: 'bank-9' }), { limit: 100 });
    expect(page.hits[0]).toMatchObject({ externalId: 'm1', content: '内容' });
    expect((f.mock.calls[0] as unknown as [string])[0]).toContain('/memories/list?limit=100&offset=0&state=valid');
    // 总数不可得且本页未满 → 到底；谎报 hasMore 会让翻页循环白白空转
    expect(page.hasMore).toBe(false);
    // offset 必须随翻页推进（旧写法只拉首页，条目多于 limit 时导入永远追不完）
    await d.list!(space({ externalId: 'bank-9' }), { limit: 100, offset: 100 });
    expect((f.mock.calls[1] as unknown as [string])[0]).toContain('offset=100');
  });

  it('supermemory.remember 带 document id → accepted+externalId;forget 404 回落 documents 臂', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'doc-9', status: 'processing' }) }));
    const d = cfgOf('supermemory')(input({ fetch: f }));
    const r = await d.remember(space({ externalId: 'tag1' }), { content: 'x' });
    expect(r).toMatchObject({ completion: 'accepted', pendingOp: 'doc-9', externalId: 'doc-9' });
    // 第一次 DELETE 404,回落成功
    const f2 = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => JSON.stringify({ message: 'not found' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' });
    const d2 = cfgOf('supermemory')(input({ fetch: f2 }));
    await expect(d2.forget(space({ externalId: 'tag1' }), 'doc-9')).resolves.toMatchObject({ completion: 'committed' });
    expect((f2.mock.calls[1] as unknown as [string])[0]).toContain('/v3/documents/doc-9');
  });
});

/**
 * 遍历与翻页契约（计划 ext-to-l1-import task_6.1/6.2）。
 *
 * 这里用真驱动类 + 注入 fetch，不用替身驱动——上一轮“拉取方向 0 家能跑通”
 * 正是替身测掩盖的：替身永远返回好数据，而未实装路径只会抛错，两者在测试面长一个样。
 */
describe('遍历与翻页（真驱动 + 注入 fetch，禁替身）', () => {
  /** 造一个“按页给满”的 fetch：可断言 page/offset 真的随调用推进。 */
  function pageFetcher(key: 'results' | 'items' | 'memories', pageSize: number, total: number): FetchMock {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const url = String(_url);
      const u = new URL(url);
      const page = Number(u.searchParams.get('page') ?? '1');
      const offset = Number(u.searchParams.get('offset') ?? '0');
      const start = offset > 0 ? offset : (page - 1) * pageSize;
      const rows = [];
      for (let i = start; i < Math.min(start + pageSize, total); i++) {
        rows.push({ id: `i${i}`, memory: `内容 ${i}`, text: `内容 ${i}`, content: `内容 ${i}` });
      }
      void init;
      return { ok: true, status: 200, text: async () => JSON.stringify({ [key]: rows }) };
    }) as FetchMock;
  }

  it('mem0 platform:GET /v3/memories/?page&page_size，page 随 offset 递增', async () => {
    const f = pageFetcher('results', 100, 250);
    const d = cfgOf('mem0')(input({ fetch: f }));
    const p1 = await d.list!(space(), { limit: 100, offset: 0 });
    expect(p1.hits).toHaveLength(100);
    expect(p1.hasMore).toBe(true);
    const p2 = await d.list!(space(), { limit: 100, offset: 100 });
    const url2 = (f.mock.calls[1] as unknown as [string])[0];
    expect(url2).toContain('page=2');
    expect(url2).toContain('page_size=100');
    expect(p2.hits[0]!.externalId).toBe('i100');
    // 末页给不满 → hasMore=false（不得谎报还有）
    const p3 = await d.list!(space(), { limit: 100, offset: 200 });
    expect(p3.hits).toHaveLength(50);
    expect(p3.hasMore).toBe(false);
  });

  it('mem0 self-hosted:走 /memories?user_id&limit 形态（无 page 参数）', async () => {
    const f = fetchJson({ results: [{ id: 'm1', memory: '内容' }] });
    const d = cfgOf('mem0')(input({ fetch: f, connection: { endpoint: 'https://x.test', apiKey: 'k1', mode: 'self-hosted', userId: 'u9' } as never }));
    const p = await d.list!(space(), { limit: 50, offset: 0 });
    const url = (f.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('/memories?');
    expect(url).toContain('user_id=u9');
    expect(url).toContain('limit=50');
    expect(p.hits).toHaveLength(1);
    expect(p.hasMore).toBe(false); // 1 < 50 → 到底
  });

  it('honcho:POST conclusions/list?page&size，size 上限 100', async () => {
    const f = pageFetcher('items', 100, 100);
    const d = cfgOf('honcho')(input({ fetch: f }));
    const p = await d.list!(space({ externalId: 'ws1' }), { limit: 500, offset: 0 });
    const url = (f.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('/v3/workspaces/ws1/conclusions/list');
    expect(url).toContain('size=100'); // 越界被钳，不把 500 直接发给服务端
    expect(p.hits).toHaveLength(100);
    // 满页且无总数可查 → 保守报 hasMore=true（宁可末尾多一次空请求，不可提前停手漏条目）
    expect(p.hasMore).toBe(true);
  });

  it('openviking:fs/ls?uri&recursive&output，只留 .md 且跳隐藏项', async () => {
    const f = fetchJson({
      result: {
        entries: [
          { uri: 'viking://mem/a.md', content: '甲' },
          { uri: 'viking://mem/.hidden.md', content: '隐藏' },
          { uri: 'viking://dir', isDir: true, content: '目录' },
          { uri: 'viking://mem/raw.txt', content: '非md' },
        ],
      },
    });
    const d = cfgOf('openviking')(input({ fetch: f }));
    const p = await d.list!(space({ externalId: 'viking://mem' }), { limit: 10, offset: 0 });
    const url = (f.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('/api/v1/fs/ls?');
    expect(url).toContain('recursive=true');
    expect(p.hits.map((h) => h.externalId)).toEqual(['viking://mem/a.md']);
  });

  it('openviking 真服务形态：fs/ls 的 result 是**数组** + 正文要逐条 content/read 补读', async () => {
    // 真机（0.5.3）实测：{status:'ok',result:[{uri,name,size,isDir,rel_path}]}，
    // 旧实现走 unwrap() 只认对象 → 条目恒空 → 导入 0 条还报 truncation=complete。
    const f = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/v1/fs/ls')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', result: [
          { uri: 'viking://user/default/memories/a.md', name: 'a.md', size: 10, isDir: false, rel_path: 'a.md' },
          { uri: 'viking://user/default/memories/.hidden.md', name: '.hidden.md', isDir: false },
          { uri: 'viking://user/default/memories', name: 'memories', isDir: true },
        ] }) };
      }
      if (u.includes('/api/v1/content/read')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', result: '# 正文\n真正的文件内容' }) };
      }
      return { ok: false, status: 404, text: async () => '{}' };
    }) as FetchMock;
    const d = cfgOf('openviking')(input({ fetch: f }));
    const p = await d.list!(space({ externalId: 'viking://user/default/memories/' }), { limit: 10, offset: 0 });
    expect(p.hits.map((h) => h.externalId)).toEqual(['viking://user/default/memories/a.md']);
    expect(p.hits[0]!.content).toContain('真正的文件内容');
    expect(p.hits[0]!.content).not.toBe('viking://user/default/memories/a.md');
    expect(p.hasMore).toBe(false);
  });

  it('openviking:正文补读失败时保留元数据（content 回退 uri），不拖垮整页', async () => {
    const f = vi.fn(async (url: string) => {
      if (String(url).includes('/api/v1/fs/ls')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', result: [
          { uri: 'viking://m/x.md', name: 'x.md', isDir: false },
        ] }) };
      }
      return { ok: false, status: 500, text: async () => '{"status":"error"}' };
    }) as FetchMock;
    const d = cfgOf('openviking')(input({ fetch: f }));
    const p = await d.list!(space(), { limit: 10, offset: 0 });
    expect(p.hits).toHaveLength(1);
    expect(p.hits[0]!.content).toBe('viking://m/x.md');
  });

  it('openviking:条目多于 limit 时 hasMore=true（不得照参考实现的 slice 谎报到底）', async () => {
    const many = { result: { entries: Array.from({ length: 12 }, (_, i) => ({ uri: `viking://m/${i}.md`, content: `内容${i}` })) } };
    const f = fetchJson(many);
    const d = cfgOf('openviking')(input({ fetch: f }));
    const p = await d.list!(space(), { limit: 5, offset: 0 });
    expect(p.hits).toHaveLength(5);
    expect(p.hasMore).toBe(true);
  });

  it('retaindb:profile 形态失败则回落 collection 形态（而不是直接报错）', async () => {
    const f = vi.fn(async (url: string) => {
      if (String(url).includes('/v1/memory/profile/')) return { ok: false, status: 404, text: async () => '{"message":"no profile"}' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ id: 'r1', content: '内容' }] }) };
    }) as FetchMock;
    const d = cfgOf('retaindb')(input({ fetch: f, connection: { endpoint: 'https://x.test', apiKey: 'k1', userId: 'u9' } as never }));
    const p = await d.list!(space({ externalId: 'proj1' }), { limit: 20, offset: 0 });
    expect(p.hits.map((h) => h.externalId)).toEqual(['r1']);
    const second = (f.mock.calls[1] as unknown as [string])[0];
    expect(second).toContain('/v1/memory?');
    expect(second).toContain('project=proj1');
  });

  it('supermemory:page 由 offset 推导（旧写法硬编码 page:1，翻页永远重拉首页）', async () => {
    const f = pageFetcher('results', 100, 300);
    const d = cfgOf('supermemory')(input({ fetch: f }));
    await d.list!(space({ externalId: 'tag1' }), { limit: 100, offset: 0 });
    await d.list!(space({ externalId: 'tag1' }), { limit: 100, offset: 200 });
    const body = (f.mock.calls[1] as unknown as [string, RequestInit])[1];
    const json = JSON.parse(String((body.body as string) ?? '{}')) as { page: number; containerTags: string[] };
    expect(json.page).toBe(3);
    expect(json.containerTags).toEqual(['tag1']);
  });
});
