/**
 * 驱动配置 RPC 端到端测(计划 ext-driver-config-ui 的门禁证据)。
 *
 * 纯函数测把校验钉住了,但**真正的验收面在 RPC**:两道门是否逐个生效、
 * 写出去的是不是完整段、apiKey 留空是否真保住明文、overlay 是否让第二次编辑
 * 基于第一次结果累积。这些都只有过 `handleEndpoint` 才算被证明——
 * 单测里直接调 upsertDriverInList 通过不代表 case 里真调了它。
 *
 * 夹具用真 MemoryDb/L1Store(影子与 outbox 计数走真表),live 用可记录 patch 的
 * fake:`updateConfig` 收到的 patch 就是"将要写进 profile 的东西",逐字段断言。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleEndpoint, type EndpointDeps } from '../src/stats.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import type { MemoryConfig } from '../src/config.js';
import type { LiveSettingsHandle } from '../src/settings.js';
import type { MemoryLiveSettings } from '../src/contract.js';
import type { MemoryLogger } from '../src/types.js';
import { resetForTest as resetNonce } from '../src/ext-memory/config-arm.js';
import { ExtDriverRegistry } from '../src/ext-memory/registry.js';
import { EXT_DRIVER_SPECS, type ExternalMemoryDriver } from '../src/ext-memory/types.js';
import { resetForTest as resetOverlay, currentDrivers } from '../src/ext-memory/driver-overlay.js';
import type { ExtDriverCfg } from '../src/ext-memory/driver-config.js';

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface StartDriver {
  id: string;
  type: string;
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  space: string;
  extra: string;
}

interface Fix {
  deps: EndpointDeps;
  db: MemoryDb;
  l1: L1Store;
  writes: Array<Record<string, unknown>>;
  dataDir: string;
  setMutate(on: boolean): void;
  setWritable(on: boolean): void;
  setReadback(v: unknown | ((submitted: unknown) => unknown)): void;
  drivers(): ExtDriverCfg[];
  close(): void;
}

async function fix(start: StartDriver[] = [], opts: { enabled?: boolean } = {}): Promise<Fix> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-drvcfg-'));
  const db = new MemoryDb(join(dataDir, 'memory.db'), 0);
  db.init();
  const l1 = new L1Store(dataDir, db, undefined, 'keyword', noopLogger, 0);
  await l1.init();

  const writes: Array<Record<string, unknown>> = [];
  let mutate = true;
  let writable = true;
  // 默认模拟一个"忠实写入"的宿主:读回就是上一次提交的 extMemory(即 confirmed)。
  // readbackOverride 用于模拟不忠实的宿主(数组合并残留 / 根本不供读回能力)。
  let readback: unknown = undefined;
  let overrideOn = false;
  let overrideVal: unknown = undefined;
  const live: LiveSettingsHandle = {
    supported: true,
    get: () => ({ memoryMutate: mutate } as unknown as MemoryLiveSettings),
    update: async () => {},
    configWritable: writable,
    updateConfig: async (patch) => {
      // 真实宿主可能在此抛错(权限/校验);默认成功,专项用例覆盖失败面
      writes.push(patch);
      readback = patch.extMemory;
    },
    readConfig: () => {
      if (!overrideOn) return readback;
      // 函数型 override:基于"刚提交的值"造失真(真实残留就是提交 N 条、盘上 N+k 条)
      return typeof overrideVal === 'function' ? (overrideVal as (v: unknown) => unknown)(readback) : overrideVal;
    },
  };
  Object.defineProperty(live, 'configWritable', { get: () => writable });

  const cfg = {
    dataDir,
    memExport: { enabled: false },
    extMemory: {
      enabled: opts.enabled ?? true,
      syncMode: 'shadow-read',
      drivers: start,
      lane: { maxItemsPerDriver: 10 },
      push: { enabled: false, maxItems: 200, timeBudgetMs: 120_000, settleTimeoutMs: 180_000, allowHardDelete: false, families: 'work', maxAttempts: 3, backoffMs: '1000,3000,10000', settleScanLimit: 100 },
      pull: { enabled: false, intervalMs: 900_000, maxItems: 2000, timeBudgetMs: 120_000, families: 'work' },
      requestTimeoutMs: 15_000,
      health: { cacheMs: 60_000, failureThreshold: 3, openMs: 300_000 },
    },
  } as unknown as MemoryConfig;

  const deps = {
    ctx: {} as never,
    cfg,
    stores: { l1 } as never,
    logger: noopLogger,
    live,
    dataDir,
    extAssembly: undefined,
  } as unknown as EndpointDeps;

  return {
    deps,
    db,
    l1,
    writes,
    dataDir,
    setMutate: (on) => {
      mutate = on;
    },
    setWritable: (on) => {
      writable = on;
    },
    setReadback: (v) => {
      overrideOn = true;
      overrideVal = v;
    },
    // profile 的真相:最后一次写进去的 drivers(启动值不动,与无热重载一致)
    drivers: () => {
      const last = writes[writes.length - 1];
      const section = last?.extMemory as { drivers?: ExtDriverCfg[] } | undefined;
      return (section?.drivers ?? (cfg.extMemory?.drivers ?? [])) as ExtDriverCfg[];
    },
    close: () => db.close(),
  };
}

/** 走完真实两步:arm 取票 → 带票写。 */
async function armAndWrite(f: Fix, body: Record<string, unknown>): Promise<unknown> {
  const a = (await handleEndpoint('dsh-memory/ext-config-arm', {}, f.deps)) as { nonce?: string };
  expect(typeof a.nonce).toBe('string');
  return handleEndpoint('dsh-memory/ext-driver-upsert', { nonce: a.nonce, ...body }, f.deps);
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    if (d !== '') await rm(d, { recursive: true, force: true });
  }
});
beforeEach(() => {
  resetNonce();
  resetOverlay();
});

async function fixWithTmp(start: StartDriver[] = []): Promise<Fix> {
  const f = await fix(start);
  dirs.push(f.dataDir);
  return f;
}

/** 总闸关闭态夹具（装配真相为关，但面板仍应能写 profile）。 */
async function fixGateOff(start: StartDriver[] = []): Promise<Fix> {
  const f = await fix(start, { enabled: false });
  dirs.push(f.dataDir);
  return f;
}

/** 领票后开/关总闸。 */
async function armAndToggleGate(f: Fix, want: boolean): Promise<Record<string, unknown>> {
  const a = (await handleEndpoint('dsh-memory/ext-config-arm', {}, f.deps)) as { nonce?: string };
  expect(typeof a.nonce).toBe('string');
  return (await handleEndpoint('dsh-memory/ext-config-enable', { nonce: a.nonce, enabled: want }, f.deps)) as Record<string, unknown>;
}

describe('两道门(nonce / 宿主能力)与高权限模式解耦', () => {
  it('缺 nonce、乱 nonce、同一 nonce 重放:全部拒,且一次写入都不发生', async () => {
    const f = await fixWithTmp();
    try {
      await expect(handleEndpoint('dsh-memory/ext-driver-upsert', { id: 'a1', type: 'mem0', endpoint: 'https://x.test' }, f.deps)).rejects.toThrow(/令牌/);
      await expect(handleEndpoint('dsh-memory/ext-driver-upsert', { nonce: 'made-up', id: 'a1', type: 'mem0', endpoint: 'https://x.test' }, f.deps)).rejects.toThrow(/令牌/);
      const a = (await handleEndpoint('dsh-memory/ext-config-arm', {}, f.deps)) as { nonce: string };
      await handleEndpoint('dsh-memory/ext-driver-upsert', { nonce: a.nonce, id: 'a1', type: 'mem0', endpoint: 'https://x.test' }, f.deps);
      await expect(handleEndpoint('dsh-memory/ext-driver-upsert', { nonce: a.nonce, id: 'a2', type: 'mem0', endpoint: 'https://x.test' }, f.deps)).rejects.toThrow(/令牌/);
      expect(f.writes).toHaveLength(1); // 只有第一次真写
    } finally {
      f.close();
    }
  });

  it('高权限模式与配置写口已解耦:关着 memoryMutate 仍能领票并写入', async () => {
    // 解耦前的行为是“配驱动必须先给模型开写删记忆工具”,那个耦合本身是错的
    // (memoryMutate 定义在工具面上,且可被 settings-set 裸写,拦不住同机进程)。
    // 本 case 钉的是“不再依赖”:若日后有人把判断加回来,这里必红。
    const f = await fixWithTmp();
    try {
      f.setMutate(false);
      const a = (await handleEndpoint('dsh-memory/ext-config-arm', {}, f.deps)) as { armed: boolean; nonce?: string };
      expect(a.armed).toBe(true);
      expect(typeof a.nonce).toBe('string');
      const w = (await handleEndpoint('dsh-memory/ext-driver-upsert', { nonce: a.nonce, id: 'a1', type: 'mem0', endpoint: 'https://x.test' }, f.deps)) as { ok: boolean };
      expect(w.ok).toBe(true);
      expect(f.writes).toHaveLength(1);
      expect(f.drivers().map((d) => d.id)).toEqual(['a1']);
    } finally {
      f.close();
    }
  });

  it('nonce 仍是独立的硬门:无票与假票一律拒,一次写入也不发生', async () => {
    // 拆了 memoryMutate 后 nonce 是第一道真门,必须单独证它不因解耦而失效。
    const f = await fixWithTmp();
    try {
      await expect(handleEndpoint('dsh-memory/ext-driver-upsert', { id: 'a1', type: 'mem0', endpoint: 'https://x.test' }, f.deps)).rejects.toThrow(/令牌/);
      await expect(handleEndpoint('dsh-memory/ext-driver-upsert', { nonce: 'made-up', id: 'a1', type: 'mem0', endpoint: 'https://x.test' }, f.deps)).rejects.toThrow(/令牌/);
      expect(f.writes).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it('宿主不支持配置写入:armed=false 并指向 profile.yaml', async () => {
    const f = await fixWithTmp();
    try {
      f.setWritable(false);
      const a = (await handleEndpoint('dsh-memory/ext-config-arm', {}, f.deps)) as { armed: boolean; reason?: string };
      expect(a.armed).toBe(false);
      expect(a.reason).toContain('profile.yaml');
    } finally {
      f.close();
    }
  });

  it('探而不发:issue:false 不占令牌名额(3 张上限不被刷新挤爆)', async () => {
    const f = await fixWithTmp();
    try {
      for (let i = 0; i < 6; i++) {
        const probe = (await handleEndpoint('dsh-memory/ext-config-arm', { issue: false }, f.deps)) as { armed: boolean; nonce?: string };
        expect(probe.armed).toBe(true);
        expect(probe.nonce).toBeUndefined();
      }
      const used = (await handleEndpoint('dsh-memory/ext-config-arm', {}, f.deps)) as { nonce: string };
      const r = (await handleEndpoint('dsh-memory/ext-driver-upsert', { nonce: used.nonce, id: 'a1', type: 'mem0', endpoint: 'https://x.test' }, f.deps)) as { ok: boolean };
      expect(r.ok).toBe(true); // 若刷新也签发,这里会因名额被占而"令牌失效"
    } finally {
      f.close();
    }
  });
});

describe('写后读回自检(R1:宿主对数组的合并语义)', () => {
  it('宿主深合并残留(读回多一条)→ notice 点名 + overlay 不更新(面板不摆假成功)', async () => {
    const f = await fixWithTmp();
    try {
      // 残留型宿主:提交什么就在读回结果尾部多留一条 ghost(典型按下标深合并)
      const ghost: ExtDriverCfg = { id: 'ghost', type: 'mem0', enabled: true, endpoint: 'https://g.test', apiKey: '', space: '', extra: '' };
      f.setReadback((submitted: unknown) => {
        const s = submitted as { drivers?: ExtDriverCfg[] };
        return { ...(s ?? {}), drivers: [...(s?.drivers ?? []), ghost] };
      });
      const r = (await armAndWrite(f, { id: 'a1', type: 'mem0', endpoint: 'https://a.test' })) as { notice?: string };
      expect(r.notice).toContain('ghost');
      expect(r.notice).toContain('深合并残留');
      // 关键:overlay 没被更新 → 列表不会把"以为删了"的行当成已存配置
      const list = (await handleEndpoint('dsh-memory/ext-drivers-list', {}, f.deps)) as { drivers: Array<{ driverId: string }> };
      expect(list.drivers.find((d) => d.driverId === 'a1')).toBeUndefined();
    } finally {
      f.close();
    }
  });

  it('宿主不供读回 → 告知未校验,但 overlay 照常生效(可用性与诚实共存)', async () => {
    const f = await fixWithTmp();
    try {
      f.setReadback(null); // readConfig 不可用
      const r = (await armAndWrite(f, { id: 'a1', type: 'mem0', endpoint: 'https://a.test' })) as { notice?: string };
      expect(r.notice).toContain('未校验');
      const list = (await handleEndpoint('dsh-memory/ext-drivers-list', {}, f.deps)) as { drivers: Array<{ driverId: string }>; notice?: string };
      expect(list.drivers.find((d) => d.driverId === 'a1')).toBeDefined();
    } finally {
      f.close();
    }
  });

  it('宿主忠实读回 → 无 notice 且 overlay 生效', async () => {
    const f = await fixWithTmp();
    try {
      const r = (await armAndWrite(f, { id: 'a1', type: 'mem0', endpoint: 'https://a.test' })) as { notice?: string };
      expect(r.notice).toBeUndefined();
      const list = (await handleEndpoint('dsh-memory/ext-drivers-list', {}, f.deps)) as { drivers: Array<{ driverId: string }> };
      expect(list.drivers.find((d) => d.driverId === 'a1')).toBeDefined();
    } finally {
      f.close();
    }
  });

  it('删除后读回仍有残留 → 移除也报 mismatch(不把"没删掉"说成已删)', async () => {
    const f = await fixWithTmp([{ id: 'x1', type: 'mem0', enabled: true, endpoint: 'https://a.test', apiKey: '', space: '', extra: '' }]);
    try {
      const a = (await handleEndpoint('dsh-memory/ext-config-arm', {}, f.deps)) as { nonce: string };
      // 提交了空列表,盘上还留着 x1:删除没落地
      f.setReadback((submitted: unknown) => ({ ...(submitted as object), drivers: [{ id: 'x1', type: 'mem0', enabled: true, endpoint: 'https://a.test', apiKey: '', space: '', extra: '' }] }));
      const r = (await handleEndpoint('dsh-memory/ext-driver-remove', { nonce: a.nonce, id: 'x1' }, f.deps)) as { removed: boolean; notice?: string };
      expect(r.removed).toBe(true);
      expect(r.notice).toContain('x1');
    } finally {
      f.close();
    }
  });
});

describe('写入内容与密钥保全', () => {
  it('新增驱动:写出完整 extMemory 段,push/pull/lane 原样保留,响应带 needsReload', async () => {
    const f = await fixWithTmp();
    try {
      const r = (await armAndWrite(f, { id: 'hs1', type: 'hindsight', endpoint: 'https://hs.test', space: 'bank-9' })) as Record<string, unknown>;
      expect(r).toMatchObject({ ok: true, needsReload: true, created: true, shadows: 0, outboxPending: 0 });
      const section = f.writes[0]!.extMemory as Record<string, unknown>;
      expect(Object.keys(section)).toEqual(expect.arrayContaining(['enabled', 'syncMode', 'drivers', 'lane', 'push', 'pull', 'requestTimeoutMs', 'health']));
      expect((section.drivers as ExtDriverCfg[])[0]).toMatchObject({ id: 'hs1', type: 'hindsight', endpoint: 'https://hs.test', space: 'bank-9', enabled: true });
    } finally {
      f.close();
    }
  });

  it('编辑只改 endpoint、apiKey 留空:profile 里明文原样保住(不回显不等于会丢)', async () => {
    const f = await fixWithTmp([{ id: 'm1', type: 'mem0', enabled: true, endpoint: 'https://old.test', apiKey: 'sk-keepme', space: 'u1', extra: '' }]);
    try {
      await armAndWrite(f, { id: 'm1', type: 'mem0', endpoint: 'https://new.test', apiKey: '', space: '', extra: '' });
      const written = f.drivers()[0]!;
      expect(written.endpoint).toBe('https://new.test');
      expect(written.apiKey).toBe('sk-keepme');
      expect(written.space).toBe('u1');
    } finally {
      f.close();
    }
  });

  it('连续两次编辑累积在 overlay 上(不会用启动值把第一次改动冲掉)', async () => {
    const f = await fixWithTmp();
    try {
      await armAndWrite(f, { id: 'a1', type: 'mem0', endpoint: 'https://a.test' });
      await armAndWrite(f, { id: 'b2', type: 'hindsight', endpoint: 'https://b.test' });
      expect(f.writes).toHaveLength(2);
      expect(f.drivers().map((d) => d.id)).toEqual(['a1', 'b2']);
      // 累积后的视图也认这两条
      expect(currentDrivers((f.deps.cfg.extMemory as never as { drivers: ExtDriverCfg[] }).drivers).map((d) => d.id)).toEqual(['a1', 'b2']);
    } finally {
      f.close();
    }
  });

  it('非法形状与非法 type 被拒且不写 profile;重复 id 的存量配置被守卫拦下', async () => {
    const f = await fixWithTmp([
      { id: 'dup', type: 'mem0', enabled: true, endpoint: 'https://a.test', apiKey: '', space: '', extra: '' },
      { id: 'dup', type: 'mem0', enabled: true, endpoint: 'https://b.test', apiKey: '', space: '', extra: '' },
    ]);
    try {
      await expect(armAndWrite(f, { id: 'BAD ID', type: 'mem0', endpoint: 'https://x.test' })).rejects.toThrow(/id/);
      await expect(armAndWrite(f, { id: 'ok1', type: 'notion', endpoint: 'https://x.test' })).rejects.toThrow(/9 类清单/);
      await expect(armAndWrite(f, { id: 'ok1', type: 'mem0', endpoint: 'nota-url' })).rejects.toThrow(/endpoint/);
      expect(f.writes).toHaveLength(0);
      // 存量重复:任何写入都先被健康检查拦住(改哪条都算不上),同时列表给出健康问题 notice
      await expect(armAndWrite(f, { id: 'dup', type: 'mem0', endpoint: 'https://c.test' })).rejects.toThrow(/同 id 驱动/);
      const list = (await handleEndpoint('dsh-memory/ext-drivers-list', {}, f.deps)) as { notice?: string };
      expect(list.notice).toContain('配置健康问题');
    } finally {
      f.close();
    }
  });

  it('remove:存在则移除并写回;不存在 removed=false 且不产生写入', async () => {
    const f = await fixWithTmp([{ id: 'x1', type: 'mem0', enabled: true, endpoint: 'https://a.test', apiKey: '', space: '', extra: '' }]);
    try {
      const a = (await handleEndpoint('dsh-memory/ext-config-arm', {}, f.deps)) as { nonce: string };
      const r = (await handleEndpoint('dsh-memory/ext-driver-remove', { nonce: a.nonce, id: 'x1' }, f.deps)) as { removed: boolean; needsReload: boolean };
      expect(r).toMatchObject({ removed: true, needsReload: true });
      expect(f.drivers()).toHaveLength(0);
      const b = (await handleEndpoint('dsh-memory/ext-config-arm', {}, f.deps)) as { nonce: string };
      const none = (await handleEndpoint('dsh-memory/ext-driver-remove', { nonce: b.nonce, id: 'ghost' }, f.deps)) as { removed: boolean };
      expect(none.removed).toBe(false);
      expect(f.writes).toHaveLength(1); // 幂等删除不写盘
    } finally {
      f.close();
    }
  });

  it('待生效行进列表:新驱动以 enabled=false + 明确 lastError 出现,并带 endpoint/space/shadows', async () => {
    const f = await fixWithTmp();
    try {
      await armAndWrite(f, { id: 'new1', type: 'supermemory', endpoint: 'https://s.test', space: 'tag1' });
      const list = (await handleEndpoint('dsh-memory/ext-drivers-list', {}, f.deps)) as {
        drivers: Array<{ driverId: string; enabled: boolean; healthy: boolean; lastError: string; endpoint: string; space: string; shadows: number; configuredSecrets: string[] }>;
        notice?: string;
      };
      const row = list.drivers.find((d) => d.driverId === 'new1');
      expect(row).toMatchObject({ enabled: false, healthy: false, endpoint: 'https://s.test', space: 'tag1', shadows: 0 });
      expect(row!.lastError).toContain('重载');
      expect(list.notice).toContain('尚未生效');
    } finally {
      f.close();
    }
  });

  it('写 profile 失败时不留 overlay 痕(面板不会显示"已改"而盘上没写)', async () => {
    const f = await fixWithTmp();
    try {
      // 让 updateConfig 抛错:替换 live 的写面(同 fix() 的形状,只改这一处行为)
      const broken: LiveSettingsHandle = {
        ...f.deps.live!,
        configWritable: true,
        updateConfig: async () => {
          throw new Error('profile 写入被宿主拒绝');
        },
      };
      const deps = { ...f.deps, live: broken } as unknown as EndpointDeps;
      const a = (await handleEndpoint('dsh-memory/ext-config-arm', {}, deps)) as { nonce: string };
      await expect(handleEndpoint('dsh-memory/ext-driver-upsert', { nonce: a.nonce, id: 'boom', type: 'mem0', endpoint: 'https://x.test' }, deps)).rejects.toThrow(/宿主拒绝/);
      const list = (await handleEndpoint('dsh-memory/ext-drivers-list', {}, f.deps)) as { drivers: Array<{ driverId: string }> };
      expect(list.drivers.find((d) => d.driverId === 'boom')).toBeUndefined();
    } finally {
      f.close();
    }
  });
});

describe('总闸开关 ext-config-enable（面板开总闸 + 整段合并不互相抹除）', () => {
  it('无票与假票一律拒，一次写入也不发生', async () => {
    const f = await fixWithTmp();
    try {
      await expect(handleEndpoint('dsh-memory/ext-config-enable', { enabled: true }, f.deps)).rejects.toThrow(/令牌/);
      await expect(handleEndpoint('dsh-memory/ext-config-enable', { nonce: 'deadbeef', enabled: true }, f.deps)).rejects.toThrow(/令牌/);
      expect(f.writes).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it('开启：写出的整段带 enabled=true 且保留 drivers/push/pull 形状，响应带 needsReload', async () => {
    const f = await fixGateOff([{ id: 'h1', type: 'holographic', enabled: true, endpoint: 'E:/x/store.json', apiKey: '', space: '', extra: '' }]);
    try {
      const r = (await armAndToggleGate(f, true)) as { ok: boolean; needsReload: boolean; enabled: boolean };
      expect(r).toMatchObject({ ok: true, needsReload: true, enabled: true });
      const section = f.writes[f.writes.length - 1]?.extMemory as Record<string, unknown>;
      expect(section.enabled).toBe(true);
      // 整段覆盖写回：除 enabled 外的键必须原样带上，否则一开总闸就把部署侧的推送参数打回默认。
      expect((section.drivers as Array<{ id: string }>).map((d) => d.id)).toEqual(['h1']);
      expect(Object.keys(section)).toEqual(expect.arrayContaining(['push', 'pull', 'lane', 'health', 'syncMode', 'requestTimeoutMs']));
    } finally {
      f.close();
    }
  });

  it('先改 drivers 再开总闸：写出的 drivers 仍含刚改的（不被启动值抹回）', async () => {
    const f = await fixWithTmp();
    try {
      await armAndWrite(f, { id: 'new1', type: 'mem0', endpoint: 'https://n.test' });
      await armAndToggleGate(f, true);
      expect(f.drivers().map((d) => d.id)).toEqual(['new1']);
    } finally {
      f.close();
    }
  });

  it('先开总闸再改 driver：写出的 enabled 仍为刚开的值（两个写口对称互不抹除）', async () => {
    const f = await fixGateOff();
    try {
      await armAndToggleGate(f, true);
      await armAndWrite(f, { id: 'a1', type: 'mem0', endpoint: 'https://a.test' });
      const section = f.writes[f.writes.length - 1]?.extMemory as { enabled?: boolean };
      // 没有这层合并：装配真相仍为 false 时，一次驱动保存会把用户刚写的总闸抹回 false——
      // “面板说保存成功、盘上却是旧值”就是这类最难归因的坑。
      expect(section.enabled).toBe(true);
    } finally {
      f.close();
    }
  });

  it('总闸关时列表仍列出已写入 profile 的驱动（enabled=false + 明写原因）', async () => {
    const f = await fixGateOff([{ id: 'h1', type: 'holographic', enabled: true, endpoint: 'E:/x/store.json', apiKey: 'k', space: '', extra: '' }]);
    try {
      const list = (await handleEndpoint('dsh-memory/ext-drivers-list', {}, f.deps)) as {
        enabled: boolean;
        drivers: Array<{ driverId: string; enabled: boolean; healthy: boolean; lastError: string; endpoint: string; configuredSecrets: string[] }>;
      };
      expect(list.enabled).toBe(false);
      const row = list.drivers.find((d) => d.driverId === 'h1');
      expect(row).toBeDefined();
      expect(row!.enabled).toBe(false);
      expect(row!.healthy).toBe(false);
      expect(row!.lastError).toContain('总闸未开');
      expect(row!.endpoint).toBe('E:/x/store.json');
      expect(row!.configuredSecrets).toEqual(['apiKey']); // 只回键名，不回值
    } finally {
      f.close();
    }
  });

  it('宿主不供读回 → 告知未校验但仍记待生效，列表点名“总闸改动已写入 profile”', async () => {
    const f = await fixGateOff();
    try {
      f.setReadback(null);
      const r = (await armAndToggleGate(f, true)) as { notice?: string };
      expect(r.notice).toContain('未校验');
      const list = (await handleEndpoint('dsh-memory/ext-drivers-list', {}, f.deps)) as { notice?: string };
      expect(list.notice).toContain('总闸改动已写入 profile');
      // 生效态仍以装配真相为准：不能把待生效当成已生效回显。
      expect(list.enabled).toBe(false);
    } finally {
      f.close();
    }
  });

  it('读回不一致 → notice 点名且不记待生效（不骗人）', async () => {
    const f = await fixGateOff();
    try {
      f.setReadback({ enabled: false }); // 宿主“按提交写了 false”
      const r = (await armAndToggleGate(f, true)) as { notice?: string };
      expect(r.notice).toContain('不一致');
      const list = (await handleEndpoint('dsh-memory/ext-drivers-list', {}, f.deps)) as { notice?: string };
      expect(list.notice ?? '').not.toContain('总闸改动已写入 profile');
    } finally {
      f.close();
    }
  });

  it('宿主不支持配置写入 → 拒绝并指向 profile.yaml', async () => {
    const f = await fixWithTmp();
    try {
      f.setWritable(false);
      const a = (await handleEndpoint('dsh-memory/ext-config-arm', {}, f.deps)) as { armed: boolean; nonce?: string; reason?: string };
      expect(a.armed).toBe(false);
      expect(a.reason).toContain('profile.yaml');
      await expect(handleEndpoint('dsh-memory/ext-config-enable', { nonce: 'x', enabled: true }, f.deps)).rejects.toThrow(/令牌/);
    } finally {
      f.close();
    }
  });

  it('生效态 = 装配真相：配置已改关而驱动仍在跑 → enabled=true + configured=false + 点名不一致', async () => {
    // 真宿主的 extMemory 是 volatile 节，写入后内存值立即变；拿配置值当生效态就会
    // 在面板上显示“已关闭”而实际还在推/拉（沙箱实测命中了这个坑，所以有这一目）。
    const f = await fixGateOff();
    try {
      const running = { enabled: true, registry: { list: () => [] }, lane: { statusOf: () => [] } } as never;
      const deps = { ...f.deps, extAssembly: running } as unknown as EndpointDeps;
      const list = (await handleEndpoint('dsh-memory/ext-drivers-list', {}, deps)) as { enabled: boolean; configuredEnabled?: boolean; notice?: string };
      expect(list.enabled).toBe(true); // 在跑的是真相
      expect(list.configuredEnabled).toBe(false); // profile 已改关
      expect(list.notice).toContain('不一致');
      expect(list.notice).toContain('重载后对齐');
    } finally {
      f.close();
    }
  });

  it('反方向也说得清：配置已开但尚未装配 → enabled=false + configured=true（归入待重载分支）', async () => {
    const f = await fix([{ id: 'h1', type: 'holographic', enabled: true, endpoint: 'E:/x/store.json', apiKey: '', space: '', extra: '' }]);
    try {
      const notYet = { enabled: false, registry: { list: () => [] }, lane: { statusOf: () => [] } } as never;
      const deps = { ...f.deps, extAssembly: notYet } as unknown as EndpointDeps;
      const list = (await handleEndpoint('dsh-memory/ext-drivers-list', {}, deps)) as { enabled: boolean; configuredEnabled?: boolean; drivers: Array<{ driverId: string; lastError: string }> };
      expect(list.enabled).toBe(false);
      expect(list.configuredEnabled).toBe(true);
      // 未装配时仍把配置里的行列出来（带原因），不给空列表。
      expect(list.drivers.map((d) => d.driverId)).toEqual(['h1']);
      expect(list.drivers[0]!.lastError).toContain('总闸未开');
    } finally {
      f.close();
    }
  });
});

describe('分票：导入不靠配置写能力（ext-to-l1-import task_6.3）', () => {
  const driver = (): ExternalMemoryDriver => ({
    id: 'hs',
    typeId: 'holographic',
    capabilities: EXT_DRIVER_SPECS.holographic.capabilities,
    scoreSemantics: 'normalized-relevance',
    status: async () => ({ healthy: true }),
    search: async () => ({ results: [], hasMore: false }),
    remember: async () => ({ completion: 'failed' as const, error: 'unsupported' }),
    forget: async () => ({ completion: 'failed' as const, error: 'unsupported' }),
    list: async () => ({ hits: [], hasMore: false }),
    // holographic 声明 graph:true，registry.assertRuntime 会要求方法在场。
    graph: async () => ({ nodes: [], edges: [], generatedAt: '' }),
  }) as unknown as ExternalMemoryDriver;

  it('configWritable=false：config 票被拒，import 票照给且能启动导入（且不写 profile）', async () => {
    const f = await fix([{ id: 'hs', type: 'holographic', enabled: true, endpoint: 'E:/x/store.json', apiKey: '', space: '', extra: '' }]);
    try {
      f.setWritable(false);
      // 配置票：仍要求宿主写能力
      const cfgArm = (await handleEndpoint('dsh-memory/ext-config-arm', { issue: false, scope: 'config' }, f.deps)) as { armed: boolean; reason?: string };
      expect(cfgArm.armed).toBe(false);
      expect(cfgArm.reason ?? '').toContain('配置写入');

      const registry = new ExtDriverRegistry();
      registry.register(driver());
      const started: string[] = [];
      const deps = {
        ...f.deps,
        extAssembly: { enabled: true, registry, lane: { statusOf: () => [] } } as never,
        importer: {
          start: (inp: { driverId: string }) => {
            started.push(inp.driverId);
            return { accepted: true as const, startedAt: 1 };
          },
          status: () => null,
          cancel: () => ({ cancelled: false }),
          resetBreakpoint: () => ({ cleared: false }),
        } as never,
      } as unknown as EndpointDeps;

      // 探而不发：导入面就绪，且不挤掉待用票
      const probe = (await handleEndpoint('dsh-memory/ext-config-arm', { issue: false, scope: 'import' }, deps)) as { armed: boolean; notice?: string; nonce?: string };
      expect(probe.armed).toBe(true);
      expect(probe.notice ?? '').toContain('导入面');
      expect(probe.nonce, 'issue:false 不得发票').toBeUndefined();

      // 真领票 → 受理导入；全程不得碰 profile
      const arm = (await handleEndpoint('dsh-memory/ext-config-arm', { scope: 'import' }, deps)) as { armed: boolean; nonce?: string };
      expect(arm.armed).toBe(true);
      expect(typeof arm.nonce).toBe('string');
      const r = (await handleEndpoint('dsh-memory/ext-import-start', { nonce: arm.nonce, driverId: 'hs', maxItems: 5 }, deps)) as { accepted: boolean };
      expect(r.accepted).toBe(true);
      expect(started).toEqual(['hs']);
      expect(f.writes, '导入是运行期动作，不得写 profile').toHaveLength(0);
    } finally {
      resetNonce();
      f.close();
    }
  });

  it('导入面未装配时 import 票必须置灰并说原因（不留“能点但不起作用”的钮）', async () => {
    const f = await fix([], { enabled: false });
    try {
      const arm = (await handleEndpoint('dsh-memory/ext-config-arm', { issue: false, scope: 'import' }, f.deps)) as { armed: boolean; reason?: string };
      expect(arm.armed).toBe(false);
      expect(arm.reason ?? '').toContain('外部记忆未开启');
    } finally {
      f.close();
    }
  });
});
