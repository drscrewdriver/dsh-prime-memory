/**
 * DrscClient wire 契约测试(task_18):对 mock fetch 断言请求形状(URL/参数/
 * Host 回显/超时)与响应映射(包络收窄/行形状/角色过滤/缺席空数组/显式报错)。
 * collector 侧 schema v5 联调等 G3——本文件按 spec R3/R4 的 wire 契约先行钉死。
 */
import { describe, expect, it } from 'vitest';
import {
  DRSC_API_PATH,
  DrscClient,
  DrscClientError,
  drscRoleOf,
  drscRowToConversationMessage,
  firstDrscTrustedHost,
  resolveDrscBaseUrl,
  resolveDrscBaseUrlDetail,
} from '../src/clients/drsc.js';

/** 抓请求的 mock fetch:返回 (url 断言用, 响应工厂)。 */
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: u, init });
    return handler(u, init);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveDrscBaseUrl(steward 探针同款解析序)', () => {
  it('显式 > trustedHosts 首条(补 http://)> 缺省 127.0.0.1:8080', () => {
    expect(resolveDrscBaseUrl('http://127.0.0.1:9999', ['localhost:8080'])).toBe('http://127.0.0.1:9999');
    expect(resolveDrscBaseUrl(undefined, ['localhost:8080'])).toBe('http://localhost:8080');
    expect(resolveDrscBaseUrl('  ', ['host-a', 'host-b'])).toBe('http://host-a');
    expect(resolveDrscBaseUrl(undefined, undefined)).toBe('http://127.0.0.1:8080');
    expect(resolveDrscBaseUrl(undefined, [])).toBe('http://127.0.0.1:8080');
    expect(resolveDrscBaseUrl(undefined, ['', '  '])).toBe('http://127.0.0.1:8080');
  });

  // issue #20:Desktop App 走随机端口,写死的 8080 永远对不上。新增宿主 origin 一档,
  // 但**只允许替换 8080 那一句**,不得插到 trustedHosts 之前——否则靠 --trusted-host
  // 已经能工作的用户会被改到另一个 authority 上,那是回归。
  it('issue #20 新增的 origin 档只替 8080 兜底,不抢 trustedHosts', () => {
    // 空 trustedHosts + 有 origin → 用 origin(本 issue 的修复本体)
    expect(resolveDrscBaseUrl(undefined, [], 'http://127.0.0.1:51337')).toBe('http://127.0.0.1:51337');
    expect(resolveDrscBaseUrl(undefined, ['', '  '], 'http://127.0.0.1:53084')).toBe('http://127.0.0.1:53084');
    // 非空 trustedHosts 优先级不变:origin 不得抢位
    expect(resolveDrscBaseUrl(undefined, ['localhost:8080'], 'http://127.0.0.1:53084')).toBe('http://localhost:8080');
    expect(resolveDrscBaseUrl('http://127.0.0.1:9999', [], 'http://127.0.0.1:53084')).toBe('http://127.0.0.1:9999');
    // 取不到 origin → 逐字节等价旧行为
    expect(resolveDrscBaseUrl(undefined, [], undefined)).toBe('http://127.0.0.1:8080');
    expect(resolveDrscBaseUrl(undefined, [], '   ')).toBe('http://127.0.0.1:8080');
  });

  it('来源标记只对前两档置真(决定要不要回显 Host 头)', () => {
    expect(resolveDrscBaseUrlDetail(undefined, ['host-a'], 'http://127.0.0.1:1')).toEqual({ url: 'http://host-a', fromConfigured: true });
    expect(resolveDrscBaseUrlDetail('http://x:9', [], undefined)).toEqual({ url: 'http://x:9', fromConfigured: true });
    expect(resolveDrscBaseUrlDetail(undefined, [], 'http://127.0.0.1:53084')).toEqual({ url: 'http://127.0.0.1:53084', fromConfigured: false });
    expect(resolveDrscBaseUrlDetail(undefined, [], undefined)).toEqual({ url: 'http://127.0.0.1:8080', fromConfigured: false });
    expect(firstDrscTrustedHost(['  ', 'host-b'])).toBe('host-b');
    expect(firstDrscTrustedHost([])).toBeUndefined();
  });
});

describe('drscRowToConversationMessage(ConversationMessage 形状映射)', () => {
  it('user/assistant 段映射 id/role/content/timestamp/anchor;非消息段返回 undefined', () => {
    const base = { seq: 12, turn: 5, step: 2, kind: 'user/message', role: 'user', time: 1_700_000_000_000, text: '脱敏后正文' };
    const msg = drscRowToConversationMessage(base, 'sess-a');
    expect(msg).toBeDefined();
    expect(msg!.id).toBe('drsc:sess-a:12');
    expect(msg!.role).toBe('user');
    expect(msg!.content).toBe('脱敏后正文');
    expect(msg!.timestamp).toBe(1_700_000_000_000);
    expect(msg!.anchor).toEqual({ sessionId: 'sess-a', turn: 5, step: 2 });
    expect(drscRowToConversationMessage({ ...base, kind: 'tool/call' }, 's')).toBeUndefined();
    // turn=0(无坐标):锚点不成立,不伪造
    const noTurn = drscRowToConversationMessage({ ...base, turn: 0, step: 0 }, 'sess-a');
    expect(noTurn?.anchor).toBeUndefined();
  });

  it('drscRoleOf 词表:仅 user/message 与 assistant/message', () => {
    expect(drscRoleOf('user/message')).toBe('user');
    expect(drscRoleOf('assistant/message')).toBe('assistant');
    expect(drscRoleOf('tool/result')).toBeUndefined();
    expect(drscRoleOf('')).toBeUndefined();
  });
});

describe('DrscClient(wire 契约,mock fetch)', () => {
  it('sessionTail:op=session&session&tail&redact=1,行形状直取,Host 头回显 trustedHosts 首条', async () => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse({
        ok: true,
        session: { session_id: 'sess-a' },
        rows: [
          { seq: 0, turn: 1, step: 0, kind: 'user/message', role: 'user', time: 111, text: '第一段' },
          { seq: 1, turn: 1, step: 1, kind: 'assistant/message', role: 'assistant', time: 112, text: '第二段' },
        ],
      }),
    );
    const client = new DrscClient({
      fetchImpl: impl,
      trustedHosts: () => ['localhost'],
      baseUrl: 'http://127.0.0.1:9999',
    });
    const rows = await client.sessionTail('sess-a', 8);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://127.0.0.1:9999${DRSC_API_PATH}?op=session&session=sess-a&tail=8&redact=1`);
    expect((calls[0].init.headers as Record<string, string>)['host']).toBe('localhost');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ seq: 0, turn: 1, step: 0, kind: 'user/message', role: 'user', time: 111, text: '第一段' });
  });

  it('sessionTail:session=null(collector 无此会话)→ 空数组,非错误', async () => {
    const { impl } = mockFetch(() => jsonResponse({ ok: true, session: null, rows: [] }));
    const client = new DrscClient({ fetchImpl: impl });
    const rows = await client.sessionTail('never-seen', 8);
    expect(rows).toEqual([]);
  });

  // issue #20 的 wire 形状:靠宿主 origin 打真实端口时,不得拿另一个 authority 去填
  // Host 头——collector 信任门是精确匹配,错配只会把"端口不对"换成"Host 不被信任"。
  it('origin 兜底路径:URL 用真实端口,且不回显 Host 头', async () => {
    const { impl, calls } = mockFetch(() => jsonResponse({ ok: true, session: null, rows: [] }));
    const client = new DrscClient({
      fetchImpl: impl,
      trustedHosts: () => [],
      origin: () => 'http://127.0.0.1:51337',
    });
    await client.sessionTail('sess-a', 4);
    expect(calls[0].url).toBe(`http://127.0.0.1:51337${DRSC_API_PATH}?op=session&session=sess-a&tail=4&redact=1`);
    expect((calls[0].init.headers as Record<string, string>)['host']).toBeUndefined();
  });

  it('origin 探针抛错(服务未就绪)→ 落回 8080,请求照常发出', async () => {
    const { impl, calls } = mockFetch(() => jsonResponse({ ok: true, session: null, rows: [] }));
    const client = new DrscClient({
      fetchImpl: impl,
      trustedHosts: () => [],
      origin: () => {
        throw new Error('cannot get property "webServer" without inject');
      },
    });
    await client.sessionTail('sess-a', 4);
    expect(calls[0].url).toBe(`http://127.0.0.1:8080${DRSC_API_PATH}?op=session&session=sess-a&tail=4&redact=1`);
  });

  it('search:op=search&q&limit&redact=1,hits 直取', async () => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse({
        ok: true,
        query: '吉他',
        match: '吉他',
        hits: [
          { session_id: 's1', seq: 3, kind: 'user/message', rank: -1.2, snippet: '…练吉他…', time: 222, on_surface: 1, turn: 9 },
        ],
      }),
    );
    const client = new DrscClient({ fetchImpl: impl });
    const hits = await client.search('吉他', 5);
    expect(calls[0].url).toBe(`http://127.0.0.1:8080${DRSC_API_PATH}?op=search&q=${encodeURIComponent('吉他')}&limit=5&redact=1`);
    expect(hits).toHaveLength(1);
    expect(hits[0].session_id).toBe('s1');
    expect(hits[0].snippet).toContain('吉他');
  });

  it('缺席/超时/非 2xx/ok=false 一律 DrscClientError(显式报错,无本地回退)', async () => {
    const offline = new DrscClient({
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(offline.sessionTail('s', 8)).rejects.toBeInstanceOf(DrscClientError);
    await expect(offline.search('q', 5)).rejects.toThrow(/collector 不可达/);

    const http500 = new DrscClient({ fetchImpl: mockFetch(() => jsonResponse({ ok: false }, 500)).impl });
    await expect(http500.search('q', 5)).rejects.toThrow(/HTTP 500/);

    const badEnvelope = new DrscClient({
      fetchImpl: mockFetch(() => jsonResponse({ ok: false, error: 'unknown op' })).impl,
    });
    await expect(badEnvelope.sessionTail('s', 8)).rejects.toThrow(/包络异常.*unknown op/);
  });

  it('超时:挂起的 fetch 被 abort signal 打断 → DrscClientError', async () => {
    const hanging = (_url: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      }) as unknown as Promise<Response>;
    const client = new DrscClient({ fetchImpl: hanging as typeof fetch, timeoutMs: 30 });
    await expect(client.sessionTail('s', 8)).rejects.toBeInstanceOf(DrscClientError);
  });
});
