/**
 * DRSC 健康探针（`probeDrscHealth`）单测。
 *
 * 六态 + 句柄复用，全部用注入 `load` 的假模块，**不真 import collector 包**
 * （devDeps 没有它，真 import 会让本仓测试挂）。
 *
 * 另外钉住三条纪律：
 * - 门面只有“真对象”才算 ok（`undefined` 是“装了没启用”）；
 * - `openProjectionStore` 在多次探测间**只调一次**（它会把摘要全表载入，Issue #1 根因）；
 * - 空库（聚合 MAX=NULL）是 `empty` 中性态，不是探针故障——「没数据」与「解析不了」必须分开。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRSC_STALE_AFTER_MS,
  probeDrscHealth,
  resetCollectorReadState,
  type CollectorReadModule,
} from '../src/clients/drsc-inproc.js';

afterEach(() => {
  resetCollectorReadState();
  vi.restoreAllMocks();
});

interface FakeOpts {
  facade?: boolean;
  syncedAt?: unknown;
  /** meta 表里 schema_version 的值；null = 行存在但值为 NULL。 */
  schemaVersion?: string | null;
  /** 假模块顶层导出的 PROJECTION_SCHEMA_VERSION；undefined = 不导出该常量。 */
  expectedSchemaVersion?: string;
  noDb?: boolean;
  openThrows?: boolean;
  dir?: string;
}

function fakeModule(opts: FakeOpts = {}) {
  const openProjectionStore = vi.fn((_dir: string) => {
    if (opts.openThrows) throw new Error('open failed');
    return opts.noDb
      ? {}
      : {
          db: {
            prepare: (sql: string) => ({
              get: () => (sql.includes('meta') ? { value: opts.schemaVersion ?? null } : { s: opts.syncedAt }),
            }),
          },
        };
  });
  const mod = {
    resolveIndexDir: () => opts.dir ?? '/tmp/projection',
    openProjectionStore,
    createQueryContext: () => ({}),
    search: () => ({ ok: true }),
    sessionDetail: () => ({ ok: true }),
    listSessions: () => ({ ok: true }),
    ...(opts.expectedSchemaVersion === undefined ? {} : { PROJECTION_SCHEMA_VERSION: opts.expectedSchemaVersion }),
    ...(opts.facade
      ? { drsReadFacade: () => ({ listSessions: () => ({}), sessionDetail: () => ({}), search: () => ({}) }) }
      : { drsReadFacade: () => undefined }),
  } as unknown as CollectorReadModule;
  return { mod, openProjectionStore };
}

const NOW = Date.parse('2026-11-03T00:00:00.000Z');

describe('probeDrscHealth', () => {
  it('包导入失败 → missing（installed=false）', async () => {
    const h = await probeDrscHealth({ now: NOW, load: async () => { throw new Error('Cannot find module'); } });
    expect(h.state).toBe('missing');
    expect(h.installed).toBe(false);
    expect(h.mounted).toBe(false);
    expect(h.error).toContain('Cannot find module');
  });

  it('门面可用 → ok/mounted，且不打开投影库', async () => {
    const { mod, openProjectionStore } = fakeModule({ facade: true });
    const h = await probeDrscHealth({ now: NOW, load: async () => mod });
    expect(h).toMatchObject({ state: 'ok', installed: true, mounted: true });
    expect(openProjectionStore).not.toHaveBeenCalled();
  });

  it('装了没启用 + 库新鲜 → not-running（不谎报过期）', async () => {
    const { mod } = fakeModule({ syncedAt: new Date(NOW - 60_000).toISOString() });
    const h = await probeDrscHealth({ now: NOW, load: async () => mod });
    expect(h.state).toBe('not-running');
    expect(h.installed).toBe(true);
    expect(h.mounted).toBe(false);
    expect(h.lagMs).toBe(60_000);
  });

  it('装了没启用 + 库滞后超阈 → stale（TEXT ISO 与数值两种写法都认）', async () => {
    const iso = fakeModule({ syncedAt: new Date(NOW - DRSC_STALE_AFTER_MS - 1000).toISOString() });
    expect((await probeDrscHealth({ now: NOW, load: async () => iso.mod })).state).toBe('stale');

    resetCollectorReadState();
    const num = fakeModule({ syncedAt: NOW - DRSC_STALE_AFTER_MS - 1000 });
    expect((await probeDrscHealth({ now: NOW, load: async () => num.mod })).state).toBe('stale');
  });

  it('读库失败/无 .db/synced_at 不可解析 → unknown（失败不等于故障）', async () => {
    const noDb = fakeModule({ noDb: true });
    const h1 = await probeDrscHealth({ now: NOW, load: async () => noDb.mod });
    expect(h1.state).toBe('unknown');
    expect(h1.error).toContain('无 .db');

    resetCollectorReadState();
    const bad = fakeModule({ syncedAt: 'not-a-date' });
    const h2 = await probeDrscHealth({ now: NOW, load: async () => bad.mod });
    expect(h2.state).toBe('unknown');
    expect(h2.error).toContain('synced_at');

    resetCollectorReadState();
    const boom = fakeModule({ openThrows: true });
    const h3 = await probeDrscHealth({ now: NOW, load: async () => boom.mod });
    expect(h3.state).toBe('unknown');
    expect(h3.installed).toBe(true);
  });

  it('空库（MAX=NULL）→ empty 中性态：不带 error，如实带出 schema 两版本', async () => {
    const { mod } = fakeModule({ syncedAt: null, schemaVersion: '6', expectedSchemaVersion: '6' });
    const h = await probeDrscHealth({ now: NOW, load: async () => mod });
    expect(h.state).toBe('empty');
    expect(h.installed).toBe(true);
    expect(h.mounted).toBe(false);
    expect(h.error).toBeUndefined();
    expect(h.lastSyncAt).toBeNull();
    expect(h.schemaVersion).toBe('6');
    expect(h.expectedSchemaVersion).toBe('6');
  });

  it('空库 + schema 断裂（旧库 v5 × 新包期望 v6）→ 仍 empty，两版本号如实不同', async () => {
    // 用户实测形态：0.2.12（期望 v6）对着 v5 空库，collector 首轮建库没跑成。
    // 旧代码在这里误报「synced_at 无法解析」；新代码必须把断裂本身报出来。
    const { mod } = fakeModule({ syncedAt: null, schemaVersion: '5', expectedSchemaVersion: '6' });
    const h = await probeDrscHealth({ now: NOW, load: async () => mod });
    expect(h.state).toBe('empty');
    expect(h.error).toBeUndefined();
    expect(h.schemaVersion).toBe('5');
    expect(h.expectedSchemaVersion).toBe('6');
  });

  it('collector 未导出 PROJECTION_SCHEMA_VERSION（旧包）→ expectedSchemaVersion 为 null，不猜', async () => {
    const { mod } = fakeModule({ syncedAt: null, schemaVersion: '5' });
    const h = await probeDrscHealth({ now: NOW, load: async () => mod });
    expect(h.state).toBe('empty');
    expect(h.schemaVersion).toBe('5');
    expect(h.expectedSchemaVersion).toBeNull();
  });

  it('多次探测只打开一次投影库（storeHandle 复用）', async () => {
    const { mod, openProjectionStore } = fakeModule({ syncedAt: new Date(NOW).toISOString() });
    await probeDrscHealth({ now: NOW, load: async () => mod });
    await probeDrscHealth({ now: NOW, load: async () => mod });
    await probeDrscHealth({ now: NOW, load: async () => mod });
    expect(openProjectionStore).toHaveBeenCalledTimes(1);
  });

  it('门面抛错按“装了没启用”继续判定，不误报 missing', async () => {
    const { mod } = fakeModule({ syncedAt: new Date(NOW).toISOString() });
    (mod as unknown as { drsReadFacade: () => never }).drsReadFacade = () => {
      throw new Error('not ready');
    };
    const h = await probeDrscHealth({ now: NOW, load: async () => mod });
    expect(h.state).toBe('not-running');
    expect(h.installed).toBe(true);
  });
});
