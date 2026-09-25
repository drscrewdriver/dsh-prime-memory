/**
 * T5 路径安全:symlink / 非普通文件 / 父目录非真实目录,读写均拒绝且错误可诊断。
 *
 * 跑法:vitest run tests/file-layer-path.test.ts --testTimeout=60000 --hookTimeout=600000
 */
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EmbeddingSourceStore } from '../src/store/embedding-source.js';
import { SlotStore } from '../src/store/slots.js';
import { atomicWriteJson, readJsonStrict } from '../src/util/io.js';
import { UnsafePathError, assertSafePath } from '../src/util/path-guard.js';
import { flTmp } from './file-layer-tmp.js';

const logs = () => {
  const warn: string[] = [];
  return { warn, logger: { debug() {}, info() {}, warn: (m: string) => warn.push(m), error() {} } };
};

describe('T5.1 三类违例', () => {
  it('父目录是 symlink → 拒绝', async () => {
    const d = await flTmp('path-parent');
    const real = join(d, 'real');
    await mkdir(real);
    const link = join(d, 'parent-link');
    await symlink(real, link, 'dir');
    await expect(assertSafePath(join(link, 'slots.json'))).rejects.toThrow(UnsafePathError);
    await expect(assertSafePath(join(link, 'slots.json'))).rejects.toThrow(/parent-symlink/);
  });

  it('目标自身是 symlink → 拒绝', async () => {
    const d = await flTmp('path-target');
    const outside = join(d, 'outside.json');
    await writeFile(outside, '{"version":1}', 'utf8');
    const target = join(d, 'slots.json');
    await symlink(outside, target, 'file');
    await expect(assertSafePath(target)).rejects.toThrow(/target-symlink/);
  });

  it('目标存在但不是普通文件(目录)→ 拒绝', async () => {
    const d = await flTmp('path-notdir');
    const target = join(d, 'slots.json');
    await mkdir(target);
    await expect(assertSafePath(target)).rejects.toThrow(/target-not-file/);
  });

  it('目标不存在 → 合法(首次写),不报错', async () => {
    const d = await flTmp('path-fresh');
    await expect(assertSafePath(join(d, 'slots.json'))).resolves.toBeUndefined();
  });
});

describe('T5.2 读写两侧都已接入', () => {
  it('写侧:symlink 目标 → 拒绝写入,且链接指向的原文件不被改写', async () => {
    const d = await flTmp('path-write');
    const outside = join(d, 'outside.json');
    const before = '{"version":1,"keep":"me"}';
    await writeFile(outside, before, 'utf8');
    const target = join(d, 'slots.json');
    await symlink(outside, target, 'file');
    // 走的是覆盖保护那条闸(严格读把它判为 unreadable)——同样拒绝写,错误信息里带违例类型
    await expect(atomicWriteJson(target, { version: 1, rev: 1, slots: [] })).rejects.toThrow(
      /拒绝覆盖|不安全|target-symlink/,
    );
    // 关键:没有跟着链接把内容写进去
    expect(await readFile(outside, 'utf8')).toBe(before);
  });

  it('读侧:symlink 目标 → 归类为 unreadable(不是 missing),detail 含违例类型', async () => {
    const d = await flTmp('path-read');
    const outside = join(d, 'outside.json');
    await writeFile(outside, '{"version":1}', 'utf8');
    const target = join(d, 'slots.json');
    await symlink(outside, target, 'file');
    const r = await readJsonStrict(target);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('unreadable');
    expect(r.ok === false && r.detail).toContain('target-symlink');
  });

  it('store 加载遇 symlink → 只读降级,不写盘', async () => {
    const d = await flTmp('path-store');
    const outside = join(d, 'outside.json');
    await writeFile(outside, '{"version":1,"rev":0,"slots":[]}', 'utf8');
    const target = join(d, 'slots.json');
    await symlink(outside, target, 'file');
    const log = logs();
    const store = new SlotStore(target, log.logger);
    await store.load();
    expect(log.warn.some((m) => m.includes('不回写'))).toBe(true);
    await store.upsert({ title: 'x' });
    expect(await readFile(outside, 'utf8')).toBe('{"version":1,"rev":0,"slots":[]}');
  });
});

describe('T5.5 embedding-source 覆盖', () => {
  it('其路径为 symlink → 读降级 + 写拒绝', async () => {
    const d = await flTmp('path-es');
    const outside = join(d, 'outside.json');
    await writeFile(outside, '{"source":"local","activeModel":"m"}', 'utf8');
    const target = join(d, 'embedding-source.json');
    await symlink(outside, target, 'file');
    const log = logs();
    const store = new EmbeddingSourceStore(d, log.logger);
    await store.init();
    expect(log.warn.some((m) => m.includes('不回写'))).toBe(true);
    await expect(store.set({ source: 'off', activeModel: null })).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('{"source":"local","activeModel":"m"}');
  });
});
