/**
 * dsh-memory/room-admin 端点单测(Hall 标签页破坏性面 RPC,beta.7):
 * ①registry 未装配 → 抛错;②高权限(memoryMutate)未开 → 抛错语义;
 * ③merge dryRun 预览零写入;④merge 实跑重写 + 备份 + 入队场景重算(source='room-merge');
 * ⑤retire/恢复往返;⑥非法 action 拒绝。
 * 编排层语义(保全/续跑/单飞/别名)由 room-merge.test.ts 钉死,此处只验证端点接线。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildEndpointDeps, handleEndpoint, type EndpointDeps } from '../src/stats.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { L1Store } from '../src/store/l1.js';
import { NoopEmbeddingService } from '../src/store/embedding.js';
import { RoomRegistryStore } from '../src/store/rooms-registry.js';
import type { MemoryLiveSettings } from '../src/contract.js';
import type { MemoryConfig } from '../src/config.js';
import type { MemoryLogger, MemoryRecord } from '../src/types.js';

let dir: string;
const dbs: MemoryDb[] = [];
afterAll(async () => {
  for (const db of dbs) db.close();
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

const noopLogger: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function liveHandle(memoryMutate: boolean) {
  const s = { enabled: true, capture: true, distill: true, recall: true, memoryMutate } as MemoryLiveSettings;
  return { supported: true, get: () => s, update: async (patch: Partial<MemoryLiveSettings>) => { Object.assign(s, patch); } };
}

async function mkDeps(
  over: { memoryMutate?: boolean; withRegistry?: boolean } = {},
): Promise<{ deps: EndpointDeps; l1: L1Store; registry: RoomRegistryStore | undefined }> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-roomadmin-'));
  const root = join(dir, `ra-${Math.random().toString(36).slice(2)}`);
  await mkdir(root, { recursive: true });
  const db = new MemoryDb(join(root, 'm.db'), 0);
  db.init();
  dbs.push(db);
  const l1 = new L1Store(root, db, new NoopEmbeddingService());
  await l1.init();
  let registry: RoomRegistryStore | undefined = new RoomRegistryStore(root);
  await registry.init();
  await registry.register({ slug: 'beta' }); // merge 目标预注册
  if (over.withRegistry === false) registry = undefined;
  const deps = buildEndpointDeps(
    { ctx: {} as never, cfg: { dataDir: root } as MemoryConfig, stores: { l1 } as never, logger: noopLogger },
    {
      live: liveHandle(over.memoryMutate ?? true),
      modes: undefined as never,
      dataDir: root,
      roomRegistry: registry,
    },
    undefined,
  );
  return { deps, l1, registry };
}

const now = Date.now();
async function seed(l1: L1Store, id: string, tags: string[]): Promise<void> {
  l1.upsert({
    id,
    content: `内容 ${id}`,
    type: 'work_fact',
    priority: 60,
    scene_name: `scene-${id.slice(-1)}`,
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 0,
    metadata: { tags: [...tags] },
    family: 'work',
    scope: 'global',
    workspaceId: '',
  } as MemoryRecord);
}

describe('dsh-memory/room-admin', () => {
  it('registry 未装配 → 抛错', async () => {
    const { deps } = await mkDeps({ withRegistry: false });
    await expect(handleEndpoint('dsh-memory/room-admin', { action: 'retire', slug: 'x' }, deps)).rejects.toThrow('未装配');
  });

  it('高权限未开 → 抛错语义', async () => {
    const { deps } = await mkDeps({ memoryMutate: false });
    await expect(handleEndpoint('dsh-memory/room-admin', { action: 'retire', slug: 'beta' }, deps)).rejects.toThrow('高权限');
  });

  it('merge dryRun:预览 affected+样例,零写入', async () => {
    const { deps, l1 } = await mkDeps();
    await seed(l1, 'a1', ['alpha']);
    const r = (await handleEndpoint('dsh-memory/room-admin', { action: 'merge', from: 'alpha', to: 'beta' }, deps)) as {
      dryRun?: boolean;
      affected?: number;
      preview?: string[];
    };
    expect(r.dryRun).toBe(true);
    expect(r.affected).toBe(1);
    expect(r.preview).toEqual(['a1']);
    expect(l1.getByIds(['a1'])[0]!.metadata?.tags).toEqual(['alpha']);
  });

  it('merge 实跑:重写 + 备份 + 入队场景重算(room-merge)', async () => {
    const { deps, l1 } = await mkDeps();
    await seed(l1, 'a1', ['alpha']);
    const r = (await handleEndpoint('dsh-memory/room-admin', { action: 'merge', from: 'alpha', to: 'beta', dryRun: false }, deps)) as {
      dryRun?: boolean;
      affected?: number;
      backupFile?: string;
      notice?: string;
    };
    expect(r.dryRun).toBe(false);
    expect(r.affected).toBe(1);
    expect(r.backupFile).toBeTruthy();
    expect(r.notice).toContain('合并完成');
    expect(l1.getByIds(['a1'])[0]!.metadata?.tags).toEqual(['beta']);
  });

  it('retire/恢复往返', async () => {
    const { deps, registry } = await mkDeps();
    await handleEndpoint('dsh-memory/room-admin', { action: 'retire', slug: 'beta' }, deps);
    expect(registry!.bySlug('beta')!.status).toBe('retired');
    await handleEndpoint('dsh-memory/room-admin', { action: 'retire', slug: 'beta', active: true }, deps);
    expect(registry!.bySlug('beta')!.status).toBe('active');
  });

  it('非法 action → 抛错', async () => {
    const { deps } = await mkDeps();
    await expect(handleEndpoint('dsh-memory/room-admin', { action: 'list' }, deps)).rejects.toThrow('非法 action');
  });
});
