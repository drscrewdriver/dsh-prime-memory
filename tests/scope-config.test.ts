/**
 * §E 存储作用域 / task_27（配置）＋ task_30（降级）：`scope` 的取值面与**归属判定**。
 *
 * 两轴**正交**（ADR-0008 条 1）：`family` 问「这是什么内容」，`scope` 问「它该在多大范围内可见」。
 * 正交的含义是**四象限都存在**——chat×global / chat×workspace / work×global / work×workspace。
 * 把两条轴合并成一条（例如"work 族一律 workspace"）等于把二维决策压成一维偏好。
 *
 * 本文件只钉**纯函数层**，不碰检索（检索侧在 `scope-isolation.test.ts`）：
 * ① 默认 `global`——**向后兼容的硬要求**：既有部署不传该键，行为必须与改动前逐字一致；
 * ② `workspace` 模式下 **work → workspace / chat → global**。这是**默认值**不是推导规则
 *    （条 2），故**记录级显式覆盖必须能赢**——否则退化成了一维偏好；
 * ③ **工作区标识缺失时回落 `global`**——不抛、不阻断（条 4）；
 * ④ 非法配置值一律归 `global`，**不抛错**（条 4：一个可见范围读错绝不该让插件树加载失败）。
 *
 * 反面判据（防空洞通过）：③④ 的断言若被写成恒真（比如 `resolveRecordScope` 无论传什么都
 * 返回 global），则"cfg=workspace → work 族归本工作区"那条会失败——同一文件内互为区分力。
 *
 * ⚠️ **`resolveRecordScope` 的 explicit 第 4 参当前无产品调用方**：它存在的目的是把
 * "四象限都成立"这一**语义**从"配置只有两档"里区分出来并**可测**（否则正交性只是文档里
 * 的一句话）。产品侧的写入接线目前只用默认规则；记录级覆盖的写入入口（prompt / 工具参数）
 * 属未排期项，已在 checklist 开放项登记。
 */
import { describe, expect, it } from 'vitest';
import { memorySchema } from '../src/config.js';
import { isScopeVisible, normScope, resolveRecordScope } from '../src/types.js';
import { normalizeWorkspacePath, workspaceIdOf } from '../src/workspace.js';

/** schemastery schema 对象可调用产出默认值（既有用法见 tests/contract-keys.test.ts:126）。 */
const parse = memorySchema as unknown as (v: unknown) => Record<string, unknown>;
const DEFAULTS = parse({});

describe('task_27 §E scope 配置：默认与取值面', () => {
  it('默认 global（向后兼容：既有部署不传该键）', () => {
    expect(DEFAULTS.scope).toBe('global');
  });

  it('显式 workspace 可被 schema 接受', () => {
    expect(parse({ scope: 'workspace' }).scope).toBe('workspace');
  });

  it('schema 产出部署默认键含 scope（契约面：patch.yml 按整行替换覆盖它）', () => {
    expect(Object.keys(DEFAULTS)).toContain('scope');
  });
});

describe('task_30 §E 降级：非法值不抛、不阻断', () => {
  it('schema 对非法值不抛（读错一个可见范围不该炸整棵插件树）', () => {
    expect(() => parse({ scope: 'bogus' })).not.toThrow();
  });

  it('normScope 把非法值归一到 global（而不是抛错或原样透传）', () => {
    expect(normScope('bogus')).toBe('global');
    expect(normScope('')).toBe('global');
    expect(normScope(undefined)).toBe('global');
    expect(normScope('GLOBAL')).toBe('global');
  });

  it('normScope 保留两个合法值（区分力：不是"恒返回 global"）', () => {
    expect(normScope('global')).toBe('global');
    expect(normScope('workspace')).toBe('workspace');
  });
});

describe('task_27 §E 归属判定：family 与 scope 正交', () => {
  it('cfg=global → 一律 global，且不写工作区归属', () => {
    expect(resolveRecordScope('global', 'work', '/ws/a')).toEqual({ scope: 'global', workspaceId: '' });
    expect(resolveRecordScope('global', 'chat', '/ws/a')).toEqual({ scope: 'global', workspaceId: '' });
  });

  it('cfg=workspace → work 族归本工作区', () => {
    expect(resolveRecordScope('workspace', 'work', '/ws/a')).toEqual({
      scope: 'workspace',
      workspaceId: '/ws/a',
    });
  });

  it('cfg=workspace → chat 族**默认**仍 global（是默认值，不是推导规则）', () => {
    expect(resolveRecordScope('workspace', 'chat', '/ws/a')).toEqual({ scope: 'global', workspaceId: '' });
  });

  it('工作区标识缺失 → 回落 global（不抛、不阻断）', () => {
    expect(resolveRecordScope('workspace', 'work', undefined)).toEqual({ scope: 'global', workspaceId: '' });
    expect(resolveRecordScope('workspace', 'work', '')).toEqual({ scope: 'global', workspaceId: '' });
  });
});

describe('task_27 §E 四象限：显式覆盖必须能赢过默认', () => {
  it('work×global：workspace 模式下显式声明该记忆跨项目通用', () => {
    expect(resolveRecordScope('workspace', 'work', '/ws/a', 'global')).toEqual({
      scope: 'global',
      workspaceId: '',
    });
  });

  it('chat×workspace：显式声明该记忆只属于本项目', () => {
    expect(resolveRecordScope('workspace', 'chat', '/ws/a', 'workspace')).toEqual({
      scope: 'workspace',
      workspaceId: '/ws/a',
    });
  });

  it('显式 workspace 但工作区标识缺失 → 仍回落 global（覆盖不能绕过降级）', () => {
    expect(resolveRecordScope('workspace', 'work', undefined, 'workspace')).toEqual({
      scope: 'global',
      workspaceId: '',
    });
  });

  it('cfg=global 时显式 workspace 同样生效（正交：scope 轴不依赖 family 轴）', () => {
    expect(resolveRecordScope('global', 'work', '/ws/a', 'workspace')).toEqual({
      scope: 'workspace',
      workspaceId: '/ws/a',
    });
  });
});

describe('task_28 §E 工作区标识：纯字符串归一，不碰文件系统', () => {
  it('同一目录的两种拼写归一到同一标识（否则同一工作区的记忆会被劈成两份）', () => {
    const plain = normalizeWorkspacePath('E:\\proj\\a');
    expect(normalizeWorkspacePath('E:\\proj\\a\\..\\a')).toBe(plain);
    expect(normalizeWorkspacePath('E:/proj/a/')).toBe(plain);
    expect(normalizeWorkspacePath('  E:\\proj\\a  ')).toBe(plain);
  });

  it('win32 归一小写（E:\\Proj 与 e:\\proj 是同一目录）', () => {
    expect(normalizeWorkspacePath('E:\\Proj\\A', 'win32')).toBe(normalizeWorkspacePath('e:\\proj\\a', 'win32'));
  });

  it('非 win32 **保留**大小写（POSIX 下 A 与 a 是两个不同目录）——区分力：平台参数确实改变结果', () => {
    const preserved = normalizeWorkspacePath('E:\\Proj\\A', 'linux');
    const lowered = normalizeWorkspacePath('E:\\Proj\\A', 'win32');
    expect(preserved).not.toBe(lowered);
    expect(lowered).toBe((lowered as string).toLowerCase());
  });

  it('空 / 非字符串 → undefined（不隔离；不抛）', () => {
    expect(normalizeWorkspacePath('')).toBeUndefined();
    expect(normalizeWorkspacePath('   ')).toBeUndefined();
    expect(normalizeWorkspacePath(undefined)).toBeUndefined();
    expect(normalizeWorkspacePath(42)).toBeUndefined();
  });

  it('workspaceIdOf 从 session.header.cwd 取值（与 §A 的 parentSession 同一条通路）', () => {
    expect(workspaceIdOf({ agent: { session: { header: { cwd: 'E:\\proj\\a' } } } })).toBe(
      normalizeWorkspacePath('E:\\proj\\a'),
    );
  });

  it('cwd 缺失一律 undefined，而不是空串（不隔离，且不把"没传"当成"匹配空归属"）', () => {
    expect(workspaceIdOf({ agent: { session: { header: {} } } })).toBeUndefined();
    expect(workspaceIdOf({ agent: {} })).toBeUndefined();
    expect(workspaceIdOf({})).toBeUndefined();
    expect(workspaceIdOf(undefined)).toBeUndefined();
    expect(workspaceIdOf({ agent: { session: { header: { cwd: '   ' } } } })).toBeUndefined();
  });

  it('isScopeVisible：global 恒可见；workspace 只在归属相同时可见（含空归属不可匹配）', () => {
    expect(isScopeVisible('global', '', '/ws/a')).toBe(true);
    expect(isScopeVisible('global', '/ws/b', '/ws/a')).toBe(true);
    expect(isScopeVisible('workspace', '/ws/a', '/ws/a')).toBe(true);
    expect(isScopeVisible('workspace', '/ws/b', '/ws/a')).toBe(false);
    expect(isScopeVisible('workspace', '', '/ws/a')).toBe(false);
    // 缺列/旧库读回 undefined 也按 global 处理 —— "读不到归属"等价于"跨工作区可见"
    expect(isScopeVisible(undefined, '', '/ws/a')).toBe(true);
  });
});
