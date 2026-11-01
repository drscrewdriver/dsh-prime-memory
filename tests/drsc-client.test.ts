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

  // 属性测试把三档的 scheme 规范化拉同形后，这里钉住具体形状：宿主 getOrigin() 返全 URL
  // 原样透传，而递 authority（如只拿到 host:port）要补 http://，不能产出无 scheme 的基址。
  it('origin 档与上两档同经 scheme 规范化', () => {
    expect(resolveDrscBaseUrl(undefined, [], 'http://127.0.0.1:51337')).toBe('http://127.0.0.1:51337');
    expect(resolveDrscBaseUrl(undefined, [], 'https://127.0.0.1:3080')).toBe('https://127.0.0.1:3080');
    expect(resolveDrscBaseUrl(undefined, [], '127.0.0.1:51337')).toBe('http://127.0.0.1:51337');
    expect(resolveDrscBaseUrl('  ', ['localhost'], '127.0.0.1:51337')).toBe('http://localhost');
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

/**
 * N-2：解析序的**属性测试**（逐条断言只钉住作者当时想到的几个点值，属性测试钉的是
 * 关系——后续改动只要把 origin 抬到 trustedHosts 之上、或把非空条目的基址换成 origin，
 * 就会在任何随机组合上挂，而不是恰好躲过那几个样本）。
 *
 * 固定种子的确定性伪随机（不用 Math.random）：失败可原样复现，不需第二个随机种子。
 */
describe('resolveDrscBaseUrl 优先级不变式(属性测试)', () => {
  /** mulberry32:32bit 确定性 PRNG，零依赖。 */
  const rng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const hostForms = ['host-a', 'host-b:8080', 'localhost', '127.0.0.1:51337', 'svc.example'];
  const origins = ['http://127.0.0.1:51337', 'http://127.0.0.1:53084', 'https://127.0.0.1:3080'];
  const blanks = ['', '   '];

  const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  /** 生成一组入参：显式值、trustedHosts（可空/可全空白）、origin（可缺）各态均覆到。 */
  function sample(r: () => number): { explicit?: string; hosts?: string[]; origin?: string } {
    const n = Math.floor(r() * 4); // 0..3 个条目
    const hosts = Array.from({ length: n }, () => (r() < 0.2 ? pick(r, blanks) : pick(r, hostForms)));
    return {
      explicit: r() < 0.35 ? pick(r, hostForms) : r() < 0.2 ? pick(r, blanks) : undefined,
      origin: r() < 0.65 ? pick(r, origins) : undefined,
      ...(hosts.length > 0 ? { hosts } : {}),
    };
  }

  it('任一档命中即不得被来路更低的档跨位抢走', () => {
    const r = rng(0x51_20_26_11);
    for (let i = 0; i < 400; i++) {
      const { explicit, hosts = [], origin } = sample(r);
      const got = resolveDrscBaseUrl(explicit, hosts, origin);
      const firstHost = hosts.find((e) => e.trim() !== '')?.trim();
      const desc = `explicit=${String(explicit)} hosts=${JSON.stringify(hosts)} origin=${String(origin)}`;

      if (explicit !== undefined && explicit.trim() !== '') {
        // 不变式①：显式配置永远是终值（同经 scheme 规范化，与条目一档同形）
        expect(got, desc).toBe(/^https?:\/\//u.test(explicit.trim()) ? explicit.trim() : `http://${explicit.trim()}`);
      } else if (firstHost !== undefined) {
        // 不变式②（#20 的命门）：有非空条目时绝不因 origin 可用而改基址
        expect(got, desc).toBe(/^https?:\/\//u.test(firstHost) ? firstHost : `http://${firstHost}`);
      } else if (origin !== undefined && origin.trim() !== '') {
        // 不变式③：origin 只替换那句 8080，且与上两档走同一规范化
        expect(got, desc).toBe(/^https?:\/\//u.test(origin.trim()) ? origin.trim() : `http://${origin.trim()}`);
      } else {
        expect(got, desc).toBe('http://127.0.0.1:8080');
      }

      // 不变式④：前两档之外的来源一律不回显 Host 头(与旧版同口径)
      const detail = resolveDrscBaseUrlDetail(explicit, hosts, origin);
      expect(detail.fromConfigured, desc).toBe(
        (explicit !== undefined && explicit.trim() !== '') || firstHost !== undefined,
      );
    }
  });

  it('origin 无论怎么变都不影响「有显式/有条目」时的结果(旧行为不可回归)', () => {
    const r = rng(0x99_11_22_33);
    for (let i = 0; i < 300; i++) {
      const { explicit, hosts = [] } = sample(r);
      const firstHost = hosts.find((e) => e.trim() !== '')?.trim();
      if (explicit === undefined || explicit.trim() === '') {
        if (firstHost === undefined) continue; // 此形态本就靠 origin 兜底
      }
      const withOrigin = resolveDrscBaseUrl(explicit, hosts, 'http://127.0.0.1:60000');
      const withoutOrigin = resolveDrscBaseUrl(explicit, hosts, undefined);
      expect(withOrigin, `hosts=${JSON.stringify(hosts)} explicit=${String(explicit)}`).toBe(withoutOrigin);
    }
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

// issue #20 追加修复：桌面宿主对所有注册路由有 pre-dispatch 鉴权，插件服务端 HTTP
// 拿不到 cookie 就只会 401（真机已实测）。因此缺省传输改成进程内直调 collector
// 只读面；但「显式 HTTP 意图」（配 baseUrl 或注入 fetchImpl）必须原样保留，
// 否则跨机/自托管 collector 与现有 wire 契约测试都会被误路由。
describe('传输分流：进程内为缺省、显式 HTTP 意图不被抢走（#20 追加）', () => {
  it('未给 baseUrl 且未注入 fetchImpl → 走进程内读面，不发请求', async () => {
    const seen: string[] = [];
    const client = new DrscClient({
      read: async (q) => {
        seen.push(q);
        return { ok: true, hits: [] };
      },
    });
    await client.search('端口', 5);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('op=search');
    expect(seen[0]).toContain('redact=1');
  });

  it('四个读点全部过进程内面，查询串形状与旧 HTTP 逐字一致', async () => {
    const seen: string[] = [];
    const client = new DrscClient({
      read: async (q) => {
        seen.push(q);
        return { ok: true, rows: [], hits: [], total: 0 };
      },
    });
    await client.sessionTail('s-1', 8);
    await client.sessionAll('s-1');
    await client.listSessions(10, 500);
    await client.search('a b', 3);
    expect(seen).toEqual([
      '?op=session&session=s-1&tail=8&redact=1',
      '?op=session&session=s-1&redact=1',
      '?op=sessions&offset=10&limit=500',
      '?op=search&q=a%20b&limit=3&redact=1',
    ]);
  });

  it('显式配了 baseUrl → 仍走 HTTP（跨机/自托管 collector 的意图不被抢）', async () => {
    const { impl, calls } = mockFetch(() => jsonResponse({ ok: true, hits: [] }));
    const client = new DrscClient({
      baseUrl: 'http://10.0.0.9:8080',
      fetchImpl: impl,
      read: async () => {
        throw new Error('进程内面不该被调用');
      },
    });
    await client.search('q', 2);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://10.0.0.9:8080/api/dsh-reference-session-collector?op=search&q=q&limit=2&redact=1');
  });

  it('进程内读面抛错 → 包成 DrscClientError（调用方的报错/降级分面不变）', async () => {
    const client = new DrscClient({
      read: async () => {
        throw new Error('collector 未知 op: (missing)');
      },
    });
    await expect(client.search('q', 1)).rejects.toBeInstanceOf(DrscClientError);
    await expect(client.search('q', 1)).rejects.toThrow(/进程内读失败/u);

    const noEnvelope = new DrscClient({ read: async () => ({ ok: false }) });
    await expect(noEnvelope.search('q', 1)).rejects.toThrow(/ok:true/u);
  });
});
