/**
 * 场景重聚类消费器测试(治理 W3,T3.10/T3.11)。
 * 钉死:① 消费即删派生摘要(幂等重算入口,非单向标记);② 失败**整体回滚**
 * (不留"旧摘要已删新摘要未生成"中间态,P1-8);③ 队列空零动作。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
const sceneFileOf = (dir: string, family: string, name: string): string => join(dir, 'scenes', family, name);
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SceneStore } from '../src/store/scenes.js';
import { processSceneReclusterJobs, type ReclusterJobSource } from '../src/pipeline/recluster.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function source(queue: Array<{ jobId: string; family: string; sceneNames: string[] }>, finished: Array<[string, boolean]>): ReclusterJobSource {
  return {
    claimSceneRecluster: () => queue.shift() ?? null,
    finishSceneRecluster: (id, ok) => finished.push([id, ok]),
  };
}

describe('场景重聚类消费器(T3.10/T3.11)', () => {
  it('成功路径:受影响场景摘要被删([DELETED]),作业打 ok', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-recluster-ok-'));
    dirs.push(dir);
    const scenes = { chat: new SceneStore(dir, 'chat'), work: new SceneStore(dir, 'work') };
    await scenes.chat.write('scene-a.md', '# 场景 A\n旧摘要内容(基于已降级记忆)');
    const finished: Array<[string, boolean]> = [];
    const n = await processSceneReclusterJobs(
      source([{ jobId: 'j1', family: 'chat', sceneNames: ['scene-a.md'] }], finished),
      scenes,
    );
    expect(n).toBe(1);
    expect(finished).toEqual([['j1', true]]);
    await expect(readFile(sceneFileOf(dir, 'chat', 'scene-a.md'))).rejects.toThrow(); // 摘要已删,待由当前事实重算
  });
  it('失败路径:部分删除后整体回滚(第一个场景内容原样恢复)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-recluster-rb-'));
    dirs.push(dir);
    const scenes = { chat: new SceneStore(dir, 'chat'), work: new SceneStore(dir, 'work') };
    await scenes.chat.write('scene-a.md', '场景 A 原始摘要');
    await scenes.chat.write('scene-b.md', '场景 B 原始摘要');
    // 第二个 write 注入故障:第一个([DELETED])成功,第二个抛错 → 触发整体回滚
    const orig = scenes.chat.write.bind(scenes.chat);
    let calls = 0;
    scenes.chat.write = async (name: string, content: string) => {
      calls++;
      if (calls === 2) throw new Error('注入故障'); // 只拦第二次(删除后、回滚前)
      return orig(name, content);
    };
    const finished: Array<[string, boolean]> = [];
    const n = await processSceneReclusterJobs(
      source([{ jobId: 'j2', family: 'chat', sceneNames: ['scene-a.md', 'scene-b.md'] }], finished),
      scenes,
    );
    expect(n).toBe(0); // 失败不计成功
    expect(finished).toEqual([['j2', false]]);
    expect(await readFile(sceneFileOf(dir, 'chat', 'scene-a.md'), 'utf8')).toBe('场景 A 原始摘要'); // 回滚恢复
    expect(await readFile(sceneFileOf(dir, 'chat', 'scene-b.md'), 'utf8')).toBe('场景 B 原始摘要'); // 未动
  });
  it('队列空:零动作零打标', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-recluster-empty-'));
    dirs.push(dir);
    const scenes = { chat: new SceneStore(dir, 'chat'), work: new SceneStore(dir, 'work') };
    const finished: Array<[string, boolean]> = [];
    const n = await processSceneReclusterJobs(source([], finished), scenes);
    expect(n).toBe(0);
    expect(finished).toEqual([]);
  });
});
