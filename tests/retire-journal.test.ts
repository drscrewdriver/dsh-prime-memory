/**
 * T0.4 判据:软删 → 重建(重蒸同内容) → 推送 三步后端验证不复活。
 *
 * 环路形状(计划 spec「退场×重建环路修复」节):rebuild 从 L0 重蒸会产出
 * **新铸 id** 的同内容记录——按 id 的过滤结构上不成立,墓碑身份只能是规范化
 * 内容指纹。本测用 `tombstoneResweep` 验证重蒸产物被重新压回退场;
 * 另钉三条负向边界:superseded 不落墓碑(否则误杀"用户显式重新添加")、
 * restore 撤销墓碑、账本坏行只跳过不炸。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { L1Store } from '../src/store/l1.js';
import { MemoryDb } from '../src/store/sqlite.js';
import { NoopEmbeddingService } from '../src/store/embedding.js';
import { isRetired } from '../src/store/supersede.js';
import {
  RETIRE_JOURNAL_FILE,
  readTombstones,
  tombstoneHash,
  tombstoneResweep,
  normalizeForTombstone,
} from '../src/store/retire-journal.js';
import type { MemoryRecord } from '../src/types.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function rec(id: string, content: string, extKey?: string): MemoryRecord {
  const t = Date.now();
  const r: MemoryRecord = { id, content, type: 'episodic', priority: 50, scene_name: 's', timestamps: [t], createdAt: t, updatedAt: t };
  if (extKey !== undefined) r.extKey = extKey;
  return r;
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-tomb-'));
  dirs.push(dataDir);
  const db = new MemoryDb(join(dataDir, 'm.db'), 0);
  db.init();
  const store = new L1Store(dataDir, db, new NoopEmbeddingService(), 'keyword');
  await store.init();
  return { dataDir, db, store };
}

const at = () => new Date().toISOString();

describe('retire-journal(T0.4)', () => {
  it('指纹归一:空白折叠 + 大小写不敏感,内容不同必不同指纹', () => {
    expect(tombstoneHash('Hello   World')).toBe(tombstoneHash('hello world\n'));
    expect(tombstoneHash('部署用 nginx')).not.toBe(tombstoneHash('部署用 caddy'));
    expect(normalizeForTombstone('  A  B ')).toBe('a b');
  });

  it('manual 退场落墓碑;重蒸回来的同内容新 id 记录被 resweep 压回退场', async () => {
    const { dataDir, db, store } = await setup();
    await store.appendNew([rec('r-orig', '用户偏好: 提交信息一律中文')]);
    store.retire(['r-orig'], { at: at(), reason: 'manual' });

    // 退场侧:账本落了,且带内容指纹
    const journal = await readFile(join(dataDir, RETIRE_JOURNAL_FILE), 'utf8');
    expect(journal).toContain('"ev":"retire"');
    expect(journal).toContain('"reason":"manual"');
    const tombs = await readTombstones(dataDir);
    expect(tombs.reasonFor(tombstoneHash('用户偏好: 提交信息一律中文'))).toBe('manual');

    // 模拟 rebuild 重蒸:同内容、新铸 id、直接活跃入库
    await store.appendNew([rec('r-reborn', '用户偏好: 提交信息一律中文')]);
    expect(store.getByIds(['r-reborn'])[0]).toBeDefined();

    const sweep = await tombstoneResweep({
      dataDir,
      candidates: store.all(),
      retire: (ids, info) => store.retire(ids, info),
    });
    expect(sweep.repressed).toBe(1);
    const reborn = store.getByIds(['r-reborn'])[0];
    expect(reborn).toBeDefined();
    // 重压走同一汇流口 → marker 语义与人工软删无差别(可恢复、撤出检索面)
    const raw = db.getL1ByIds(['r-reborn'])[0];
    expect(isRetired(raw)).toBe(true);
    db.close();
  });

  it('restore 落反向事件:墓碑撤销,重添加不再被误压', async () => {
    const { dataDir, db, store } = await setup();
    await store.appendNew([rec('r1', '事实甲')]);
    store.retire(['r1'], { at: at(), reason: 'manual' });
    await store.restore(['r1']);
    await store.retire(['r1'], { at: at(), reason: 'manual' }); // 再次退场(最后事件=retire)
    expect((await readTombstones(dataDir)).size).toBe(1);
    await store.restore(['r1']); // 最终恢复
    expect((await readTombstones(dataDir)).size).toBe(0);
    db.close();
  });

  it('superseded/obsolete 不落墓碑——机器节奏的取代不压制用户显式重新添加', async () => {
    const { dataDir, db, store } = await setup();
    await store.appendNew([rec('r1', '被取代的旧事实')]);
    store.retire(['r1'], { at: at(), reason: 'superseded' });
    expect((await readTombstones(dataDir)).size).toBe(0);
    const journal = await readFile(join(dataDir, RETIRE_JOURNAL_FILE), 'utf8');
    // 事件仍在账上(审计完整),只是不带指纹、不构成墓碑
    expect(journal).toContain('"ev":"retire"');
    expect(journal).not.toContain('"hash"');
    db.close();
  });

  it('conflict 判负同样是墓碑(人工结论不因重建而失效)', async () => {
    const { dataDir, db, store } = await setup();
    await store.appendNew([rec('r1', '矛盾败方内容')]);
    store.retire(['r1'], { at: at(), reason: 'conflict', verdict: 'winner', pairId: 'p1' });
    expect((await readTombstones(dataDir)).reasonFor(tombstoneHash('矛盾败方内容'))).toBe('conflict');
    db.close();
  });

  it('账本坏行只跳过;整档不可读回空集(重扫退化为 no-op,绝不阻断重建)', async () => {
    const { dataDir, db, store } = await setup();
    await store.appendNew([rec('r1', '好行内容')]);
    store.retire(['r1'], { at: at(), reason: 'manual' });
    await appendFile(join(dataDir, RETIRE_JOURNAL_FILE), 'not-json\n{"ev":"retire"}\n', 'utf8');
    const tombs = await readTombstones(dataDir);
    expect(tombs.reasonFor(tombstoneHash('好行内容'))).toBe('manual'); // 好行仍生效

    // 指向不存在目录 → 空集不抛
    const empty = await readTombstones(join(dataDir, 'nope'));
    expect(empty.size).toBe(0);
    db.close();
  });

  it('无候选/无墓碑时 resweep 零动作(默认关部署零旁路)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-tomb-empty-'));
    dirs.push(dataDir);
    await mkdir(dataDir, { recursive: true });
    let retired = 0;
    const sweep = await tombstoneResweep({
      dataDir,
      candidates: [],
      retire: () => {
        retired++;
        return 0;
      },
    });
    expect(sweep).toEqual({ scanned: 0, repressed: 0 });
    expect(retired).toBe(0);
  });
});
