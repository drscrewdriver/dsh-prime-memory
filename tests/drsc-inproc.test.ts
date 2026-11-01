/**
 * DRSC 进程内读适配器（issue #20 追加修复）。
 *
 * 钉两件事：
 *  1. 查询串 → collector 函数调用的**参数映射**（tail 缺省=全量、redact 硬臂、
 *     limit 钳位、session 缺席=空行）—— 这些语义原先由 HTTP 参数承载，换传输后
 *     必须在本地等价，否则读面静默变形；
 *  2. 模块/句柄**只开一次**（重复 open 等于每请求重扫全表）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callCollectorRead,
  resetCollectorReadState,
  type CollectorReadModule,
} from '../src/clients/drsc-inproc.js';

function fakeModule() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const store = { tag: 'store' };
  const ctx = { tag: 'ctx' };
  const mod: CollectorReadModule = {
    resolveIndexDir: vi.fn(() => '/tmp/fake-index-dir'),
    openProjectionStore: vi.fn((dir: string) => {
      calls.push({ fn: 'openProjectionStore', args: [dir] });
      return store;
    }),
    createQueryContext: vi.fn((s: unknown) => {
      calls.push({ fn: 'createQueryContext', args: [s] });
      return ctx;
    }),
    search: vi.fn((_c, query: string, opts?: unknown) => {
      calls.push({ fn: 'search', args: [query, opts] });
      return { query, match: 'x', hits: [{ session_id: 's1', seq: 1 }] };
    }),
    sessionDetail: vi.fn((_c, id: string, opts?: unknown) => {
      calls.push({ fn: 'sessionDetail', args: [id, opts] });
      return { session: { session_id: id }, rows: [{ session_id: id, seq: 2 }] };
    }),
    listSessions: vi.fn((_c, offset?: number, limit?: number) => {
      calls.push({ fn: 'listSessions', args: [offset, limit] });
      return { total: 7, rows: [{ session_id: 'a' }, { session_id: 'b' }] };
    }),
  };
  return { mod, calls };
}

const loaderOf = (mod: CollectorReadModule) => async () => mod;

beforeEach(() => {
  resetCollectorReadState();
});

describe('callCollectorRead 参数映射（与旧 HTTP 语义等价）', () => {
  it('search：q/limit/redact 从查询串翻成 opts，返回包络与 HTTP 同形', async () => {
    const { mod, calls } = fakeModule();
    const body = await callCollectorRead('?op=search&q=%E7%AB%AF%E5%8F%A3&limit=5&redact=1', loaderOf(mod));
    const [query, opts] = calls.find((c) => c.fn === 'search')!.args as [string, Record<string, unknown>];
    expect(query).toBe('端口');
    expect(opts).toEqual({ limit: 5, redact: true });
    expect(body.ok).toBe(true);
    expect(body.hits).toHaveLength(1);
  });

  it('session：给了 tail 才切尾窗；不带 tail 必须走全量臂（#14-B 重建事实源依赖这点）', async () => {
    const { mod, calls } = fakeModule();
    await callCollectorRead('?op=session&session=s-9&tail=3&redact=1', loaderOf(mod));
    const [id, opts] = calls.find((c) => c.fn === 'sessionDetail')!.args as [string, Record<string, unknown>];
    expect(id).toBe('s-9');
    expect(opts).toEqual({ tail: 3, redact: true });

    calls.length = 0;
    resetCollectorReadState();
    await callCollectorRead('?op=session&session=s-9&redact=1', loaderOf(mod));
    const [, opts2] = calls.find((c) => c.fn === 'sessionDetail')!.args as [string, Record<string, unknown>];
    // 关键：tail 键必须整个缺席，而不是传 0/NaN —— collector 按「正整数才切窗」判。
    expect('tail' in opts2).toBe(false);
    expect(opts2.redact).toBe(true);
  });

  it('session 无 id（collector 无此会话）→ session:null + 空数组，不发查询也不抛', async () => {
    const { mod, calls } = fakeModule();
    const body = await callCollectorRead('?op=session&redact=1', loaderOf(mod));
    expect(body).toEqual({ ok: true, session: null, rows: [] });
    expect(calls.some((c) => c.fn === 'sessionDetail')).toBe(false);
  });

  it('sessions：offset/limit 翻成位置参数并保留 total', async () => {
    const { mod, calls } = fakeModule();
    const body = await callCollectorRead('?op=sessions&offset=10&limit=500', loaderOf(mod));
    const args = calls.find((c) => c.fn === 'listSessions')!.args as [number, number];
    expect(args).toEqual([10, 500]);
    expect(body.total).toBe(7);
    expect(body.rows).toHaveLength(2);
  });

  it('非法/缺省的数值参数不得混进 collector（NaN 会被它当合法值）', async () => {
    const { mod, calls } = fakeModule();
    await callCollectorRead('?op=search&q=abc&limit=abc&redact=1', loaderOf(mod));
    const [, opts] = calls.find((c) => c.fn === 'search')!.args as [string, Record<string, unknown>];
    expect('limit' in opts).toBe(false);
  });

  it('未知 op 显式抛错（与 collector 路由的 unknown op 口径一致）', async () => {
    const { mod } = fakeModule();
    await expect(callCollectorRead('?op=bogus', loaderOf(mod))).rejects.toThrow(/\u672a\u77e5 op/u);
    await expect(callCollectorRead('', loaderOf(mod))).rejects.toThrow(/\(missing\)/u);
  });
});

describe('callCollectorRead 生命周期', () => {
  it('模块与只读句柄只开一次，后续请求复用同一 QueryContext', async () => {
    const { mod, calls } = fakeModule();
    const load = loaderOf(mod);
    await callCollectorRead('?op=sessions&offset=0&limit=3', load);
    await callCollectorRead('?op=sessions&offset=3&limit=3', load);
    await callCollectorRead('?op=sessions&offset=6&limit=3', load);
    expect(calls.filter((c) => c.fn === 'openProjectionStore')).toHaveLength(1);
    expect(calls.filter((c) => c.fn === 'createQueryContext')).toHaveLength(1);
    expect(calls.filter((c) => c.fn === 'listSessions')).toHaveLength(3);
  });

  it('载入失败不缓存 rejection：collector 稍后就位时下一次读能自愈', async () => {
    const { mod } = fakeModule();
    let first = true;
    const flaky = async () => {
      if (first) {
        first = false;
        throw new Error('collector not yet installed');
      }
      return mod;
    };
    await expect(callCollectorRead('?op=sessions&offset=0&limit=1', flaky)).rejects.toThrow(/not yet installed/u);
    const body = await callCollectorRead('?op=sessions&offset=0&limit=1', flaky);
    expect(body.ok).toBe(true);
  });
});
