/**
 * `/memory` TUI 终端面新增三面（switch / on|off / injected）的行为闸（0.28.1）。
 * 纯函数 runMemoryCommand + fake deps，不触库不触宿主。
 */
import { describe, expect, it } from 'vitest';

import { runMemoryCommand, type MemoryCommandDeps } from '../src/tui-command.js';

function fakeDeps(over: Partial<MemoryCommandDeps> = {}): MemoryCommandDeps {
  return {
    status: () => ({ dbPath: '/tmp/x.db', dims: 1024, l0: 5, l1: 12, receipts: 3, conflicts: 1 }),
    records: () => [],
    conflicts: () => [],
    ext: () => ({ enabled: false, syncMode: 'shadow-read', drivers: [] }),
    rooms: () => [],
    scenes: async () => ({ chat: 0, work: 0, sample: [] }),
    switches: () => ({
      enabled: true, capture: true, distill: true, recall: true,
      injectBootMode: 'off', extractBootMode: 'off', memoryMutate: false,
      ceilings: { capture: true, distill: false, recall: true },
    }),
    setEnabled: async () => ({ applied: true, effective: true, drift: false }),
    recalled: () => [],
    recentSessions: () => [],
    ...over,
  };
}

describe('/memory switch', () => {
  it('显示两轴现值，被部署停用项加标注', async () => {
    const r = await runMemoryCommand('switch', fakeDeps());
    expect(r.kind).toBe('success');
    expect(r.text).toContain('注入 recall=true(启动=off)');
    expect(r.text).toContain('提取 capture=true/distill=true(启动=off)');
    expect(r.text).toContain('蒸馏=true(部署停用)');
  });
  it('--json 单行且含 ceilings', async () => {
    const r = await runMemoryCommand('switch --json', fakeDeps());
    const body = JSON.parse(r.text);
    expect(body.ok).toBe(true);
    expect(body.data.ceilings.distill).toBe(false);
  });
});

describe('/memory on|off', () => {
  it('无 --yes 只 dry 回显，不调用写入', async () => {
    let called = false;
    const r = await runMemoryCommand('off', fakeDeps({ setEnabled: async () => { called = true; return { applied: true, effective: false, drift: false }; } }));
    expect(r.text).toContain('dry run');
    expect(called).toBe(false);
  });
  it('--yes 调写入并回读一致 → success', async () => {
    let arg: boolean | null = null;
    const r = await runMemoryCommand('off --yes', fakeDeps({ setEnabled: async (n) => { arg = n; return { applied: true, effective: false, drift: false }; } }));
    expect(arg).toBe(false);
    expect(r.kind).toBe('success');
    expect(r.text).toContain('已写入');
  });
  it('回读漂移 → error 且提示可能回落', async () => {
    const r = await runMemoryCommand('on --yes', fakeDeps({ setEnabled: async () => ({ applied: true, effective: false, drift: true }) }));
    expect(r.kind).toBe('error');
    expect(r.text).toContain('回读不一致');
  });
});

describe('/memory injected', () => {
  it('--last 取最近会话并列出注入条目（含取代标记）', async () => {
    const deps = fakeDeps({
      recentSessions: () => [{ key: 'sess-1', at: 1, count: 2 }],
      recalled: (sid) => sid === 'sess-1'
        ? [{ id: 'a', content: '记忆甲', type: 'fact', superseded: false, lane: 'fts' }, { id: 'b', content: '记忆乙', superseded: true }]
        : [],
    });
    const r = await runMemoryCommand('injected --last', deps);
    expect(r.text).toContain('sess-1');
    expect(r.text).toContain('记忆甲');
    expect(r.text).toContain('[已取代]');
  });
  it('无 --last 无 session 时列最近会话给提示', async () => {
    const deps = fakeDeps({ recentSessions: () => [{ key: 'z', at: 2, count: 4 }] });
    const r = await runMemoryCommand('injected', deps);
    expect(r.text).toContain('需指定会话');
    expect(r.text).toContain('z');
  });
  it('--session=<id> 直取该会话', async () => {
    const deps = fakeDeps({ recalled: (sid) => sid === 'abc' ? [{ id: 'x', content: 'hello' }] : [] });
    const r = await runMemoryCommand('injected --session=abc', deps);
    expect(r.text).toContain('hello');
  });
});
