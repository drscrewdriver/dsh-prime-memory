/**
 * 三家本地/CLI 驱动契约测(计划 T1.13 的本地半边)。
 * CLI 两家吃**注入的 ProcessRunner**(proc.ts 类型,不真 spawn);holographic 用
 * 真实临时 store.json——它的排序语义(Jaccard/短语/实体 × trust,minTrust 地板)
 * 是九家里唯一完全在本地可判定的,必须按参考实现逐条钉。
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ExtDriverFactoryInput, ExtSpace } from '../src/ext-memory/types.js';
import { LOCAL_DRIVER_FACTORIES } from '../src/ext-memory/drivers/local-drivers.js';
import type { ProcessRunner, RunProcessResult } from '../src/ext-memory/proc.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function space(over: Partial<ExtSpace> = {}): ExtSpace {
  return { spaceId: 'd1:sp1', driverId: 'd1', externalId: 'sp1', name: 'sp1', description: '', ...over };
}

function fakeProcess(results: Array<Partial<RunProcessResult> | Error>): ProcessRunner {
  const fn = vi.fn(async (): Promise<RunProcessResult> => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    return { exitCode: 0, stdout: '', stderr: '', ...next };
  });
  return fn as unknown as ProcessRunner;
}

describe('holographic driver(真实文件)', () => {
  async function withStore(facts: unknown[]) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-holo-'));
    dirs.push(dir);
    const file = join(dir, 'store.json');
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, facts }), 'utf8');
    const input: ExtDriverFactoryInput & { connection: Record<string, string | number | boolean> } = {
      id: 'holo-1',
      connection: { endpoint: file, space: file, minTrust: 0.3 },
      requestTimeoutMs: 5000,
    };
    return LOCAL_DRIVER_FACTORIES.holographic(input);
  }

  it('trust 地板 + 短语命中优先 + trust 加权排序', async () => {
    const d = await withStore([
      { id: 'a', content: '部署用 nginx', category: 'work', tags: [], entities: [], trustScore: 0.9, createdAt: '', updatedAt: '' },
      { id: 'b', content: '完全不同的内容', category: 'work', tags: [], entities: [], trustScore: 0.95, createdAt: '', updatedAt: '' },
      { id: 'c', content: '部署用 nginx 部署 nginx 部署 nginx 部署', category: 'work', tags: [], entities: [], trustScore: 0.1, createdAt: '', updatedAt: '' },
    ]);
    const r = await d.search(space({ externalId: 'x' }), { query: '部署用 nginx', limit: 10 });
    // c 的 trust 0.1 < minTrust 0.3 被地板接住
    expect(r.results.map((h) => h.externalId)).toEqual(['a']);
    const idem = await d.search(space({ externalId: 'x' }), { query: '部署用 nginx' });
    expect(idem.results).toEqual(r.results);
  });

  it('store 缺失:status 报 unhealthy(不抛);search 抛错(lane 侧吞为空路)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-holo-'));
    dirs.push(dir);
    const d = LOCAL_DRIVER_FACTORIES.holographic({
      id: 'holo-x',
      connection: { endpoint: join(dir, 'nope.json'), space: join(dir, 'nope.json') },
      requestTimeoutMs: 5000,
    });
    const st = await d.status();
    expect(st.healthy).toBe(false);
    expect(st.error).toMatch(/store not found/);
    await expect(d.search(space(), { query: 'q' })).rejects.toThrow(/store not found/);
  });
});

describe('byterover driver', () => {
  it('query 文本 → 单条合成 Insight(sha 前缀 id,score=1);短输出视为零结果', async () => {
    const content = `x`.repeat(200);
    const run = fakeProcess([{ stdout: content }, { stdout: 'too short' }]);
    const d = LOCAL_DRIVER_FACTORIES.byterover({ id: 'br1', connection: { endpoint: 'brv', apiKey: 'secret-key', space: 'C:\\work\\kb' }, requestTimeoutMs: 5000, process: run });
    const r = await d.search(space(), { query: '部署' });
    expect(r.results).toHaveLength(1);
    const expectedId = `byterover:${createHash('sha256').update(content).digest('hex').slice(0, 24)}`;
    expect(r.results[0]!.externalId).toBe(expectedId);
    expect(r.results[0]!.score).toBe(1);
    const [cmd, args, opts] = (run as unknown as { mock: { calls: unknown[] } }).mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv; cwd: string }];
    expect(cmd).toBe('brv');
    expect(args).toEqual(['query', '--', '部署']);
    expect(opts.env.BRV_API_KEY).toBe('secret-key');
    expect(opts.cwd).toBe('C:\\work\\kb');
    const r2 = await d.search(space(), { query: 'nothing' });
    expect(r2.results).toEqual([]);
  });

  it('非零退出 → 抛 stderr;capabilities 声明 forget=false(不可删除传导)', async () => {
    const run = fakeProcess([{ exitCode: 3, stderr: 'not logged in' }]);
    const d = LOCAL_DRIVER_FACTORIES.byterover({ id: 'br2', connection: {}, requestTimeoutMs: 5000, process: run });
    await expect(d.search(space(), { query: 'q' })).rejects.toThrow(/not logged in/);
    expect(d.capabilities.forget).toBe(false);
    expect(d.capabilities.deletionMode).toBe('unsupported');
  });
});

describe('mnemon-native driver', () => {
  it('recall 参数 + --json/--store 拼装;嵌套 {insight:{...},score} 与新扁平双兼容', async () => {
    const run = fakeProcess([
      { stdout: JSON.stringify({ results: [{ insight: { id: 'n1', content: '旧形态', category: 'decision' }, score: 0.8 }, { id: 'n2', content: '新形态' }] }) },
    ]);
    const d = LOCAL_DRIVER_FACTORIES['mnemon-native']({ id: 'mn1', connection: { endpoint: 'mnemon', space: 'store-a', searchMode: 'smart' }, requestTimeoutMs: 5000, process: run });
    const r = await d.search(space({ externalId: 'store-a' }), { query: 'q', limit: 6 });
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({ externalId: 'n1', content: '旧形态', score: 0.8, category: 'decision' });
    expect(r.results[1]!.category).toBe('general');
    const [, args] = (run as unknown as { mock: { calls: unknown[] } }).mock.calls[0] as [string, string[]];
    expect(args).toEqual(['recall', 'q', '--limit', '6', '--json', '--store', 'store-a']);
  });

  it('status 解析 total_insights;非 JSON 输出→unhealthy 确定性文案(status 永不抛)', async () => {
    const run = fakeProcess([{ stdout: JSON.stringify({ total_insights: 42 }) }, { stdout: '<html>oops</html>' }]);
    const d = LOCAL_DRIVER_FACTORIES['mnemon-native']({ id: 'mn2', connection: {}, requestTimeoutMs: 5000, process: run });
    await expect(d.status()).resolves.toEqual({ healthy: true, stats: { count: 42 } });
    const bad = await d.status();
    expect(bad.healthy).toBe(false);
    expect(bad.error).toMatch(/non-JSON/);
  });

  it('Phase 2 写路径(T2.4):remember 带 id 即链 committed;forget 透传 CLI;list 走 --readonly recall', async () => {
    const run = fakeProcess([
      { stdout: JSON.stringify({ id: 'n-77', action: 'added' }) },
      { stdout: JSON.stringify({ action: 'forgotten' }) },
      { stdout: JSON.stringify({ results: [{ id: 'n1', content: '内容甲' }] }) },
    ]);
    const d = LOCAL_DRIVER_FACTORIES['mnemon-native']({ id: 'mn3', connection: { space: 'store-a' }, requestTimeoutMs: 5000, process: run });
    await expect(d.remember(space({ externalId: 'store-a' }), { content: '新事实', category: 'decision' }))
      .resolves.toEqual({ completion: 'committed', externalId: 'n-77' });
    const [, args] = (run as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string, string[]];
    expect(args.slice(0, 3)).toEqual(['remember', '新事实', '--cat']);
    await expect(d.forget(space({ externalId: 'store-a' }), 'n-77')).resolves.toMatchObject({ completion: 'committed' });
    const page = await d.list(space({ externalId: 'store-a' }), { limit: 100 });
    expect(page.hits[0]).toMatchObject({ externalId: 'n1', content: '内容甲' });
    // CLI 只有 --limit、无 offset：单页到底，hasMore 不得谎报 true
    expect(page.hasMore).toBe(false);
  });
});
