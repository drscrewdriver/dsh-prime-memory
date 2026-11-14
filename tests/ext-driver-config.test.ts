/**
 * 驱动配置纯函数 + 面板武装令牌测(计划 ext-driver-config-ui T1.3)。
 *
 * 钉四类事实:
 * ① 校验在函数层(绕过 UI 直接喂 RPC 也得被拦);
 * ② "没动的字段不被动":空 apiKey/space/extra 保留旧值、未传 enabled 保留旧开关;
 * ③ 顺序稳定与幂等:同 id 原位替换不跳行、删除不存在 id 不算错;
 * ④ nonce 一次性 + TTL + 上限(这是"用户专属写入口"的机器可验部分)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeDriverInput,
  removeDriverFromList,
  toPublicDriver,
  upsertDriverInList,
  verifyDriversReadback,
  verifyEnabledReadback,
  type ExtDriverCfg,
} from '../src/ext-memory/driver-config.js';
import { arm, consume, pendingCount, resetForTest as resetNonce } from '../src/ext-memory/config-arm.js';
import { commitDrivers, commitEnabled, currentDrivers, hasPendingEnabled, pendingEnabledValue, hasPendingReload, previewDrivers, resetForTest as resetOverlay } from '../src/ext-memory/driver-overlay.js';

function drv(over: Partial<ExtDriverCfg> = {}): ExtDriverCfg {
  return {
    id: 'hs1',
    type: 'hindsight',
    enabled: true,
    endpoint: 'https://api.example.test',
    apiKey: 'sk-old-secret',
    space: 'bank-9',
    extra: '{"budget":"high"}',
    ...over,
  };
}

function ok(input: unknown) {
  const r = normalizeDriverInput(input);
  if (!r.ok) throw new Error(`预期合法,实际拒绝: ${r.error}`);
  return r;
}

describe('normalizeDriverInput(服务端硬校验)', () => {
  it('合法形状通过并裁剪字段;enabled 缺省 = true 且标记未提供', () => {
    const r = ok({ id: 'mem0-prod', type: 'mem0', endpoint: 'https://x.test', apiKey: ' k1 ', space: 'u1' });
    expect(r.driver).toEqual({
      id: 'mem0-prod',
      type: 'mem0',
      enabled: true,
      endpoint: 'https://x.test',
      apiKey: 'k1',
      space: 'u1',
      extra: '',
    });
    expect(r.meta.enabledProvided).toBe(false);
    expect(ok({ id: 'a', type: 'mem0', endpoint: 'https://x.test', enabled: false }).meta.enabledProvided).toBe(true);
  });

  it('非法 id(大写/空格/超长/空)拒绝', () => {
    for (const bad of ['HS1', 'has space', '', 'x'.repeat(33), '_lead']) {
      const r = normalizeDriverInput({ id: bad, type: 'mem0', endpoint: 'https://x.test' });
      expect(r.ok, `id=${JSON.stringify(bad)}`).toBe(false);
      if (!r.ok) expect(r.error).toContain('id');
    }
  });

  it('非法 type(不在 9 家)拒绝;endpoint 非 URL 非绝对路径拒绝;extra 非 JSON 拒绝', () => {
    expect(normalizeDriverInput({ id: 'a', type: 'notion', endpoint: 'https://x.test' }).ok).toBe(false);
    expect(normalizeDriverInput({ id: 'a', type: 'mem0', endpoint: 'x.test' }).ok).toBe(false);
    expect(normalizeDriverInput({ id: 'a', type: 'mem0', endpoint: '' }).ok).toBe(false);
    expect(normalizeDriverInput({ id: 'a', type: 'mem0', endpoint: 'https://x.test', extra: '{oops' }).ok).toBe(false);
    expect(normalizeDriverInput({ id: 'a', type: 'mem0', endpoint: 'https://x.test', extra: '[1,2]' }).ok).toBe(false);
    // 本地型驱动的 endpoint 允许绝对路径(POSIX / Windows 盘符)
    expect(normalizeDriverInput({ id: 'a', type: 'holographic', endpoint: 'E:/data/store.json' }).ok).toBe(true);
    expect(normalizeDriverInput({ id: 'b', type: 'mnemon-native', endpoint: '/srv/mnemon' }).ok).toBe(true);
  });
});

describe('upsert / remove(编辑语义与幂等)', () => {
  const base = [drv({ id: 'a1' }), drv({ id: 'b2', apiKey: '' })];

  it('新增追加并 created=true;同 id 原位替换 created=false 且不跳行', () => {
    const added = upsertDriverInList(base, drv({ id: 'c3' }));
    expect(added.created).toBe(true);
    expect(added.list.map((d) => d.id)).toEqual(['a1', 'b2', 'c3']);

    const upd = upsertDriverInList(base, drv({ id: 'b2', endpoint: 'https://new.test' }));
    expect(upd.created).toBe(false);
    expect(upd.list.map((d) => d.id)).toEqual(['a1', 'b2']);
    expect(upd.list[1]!.endpoint).toBe('https://new.test');
  });

  it('空 apiKey/space/extra 保留旧值;非空才覆盖;新建时空串就是空值', () => {
    const keep = upsertDriverInList(base, drv({ id: 'a1', apiKey: '', space: '', extra: '', endpoint: 'https://x2.test' }));
    expect(keep.list[0]).toMatchObject({ apiKey: 'sk-old-secret', space: 'bank-9', extra: '{"budget":"high"}' });

    const wipe = upsertDriverInList(base, drv({ id: 'a1', apiKey: 'secret://new-ref' }));
    expect(wipe.list[0]!.apiKey).toBe('secret://new-ref');

    const fresh = upsertDriverInList(base, drv({ id: 'n9', apiKey: '', space: '', extra: '' }));
    expect(fresh.list[2]).toMatchObject({ apiKey: '', space: '', extra: '' });
  });

  it('未传 enabled 时保留原开关;显式 enabled=false 才停用', () => {
    const off = upsertDriverInList(base, { ...drv({ id: 'a1' }), enabled: false });
    expect(off.list[0]!.enabled).toBe(false);
    // 模拟 RPC:输入未带 enabled → normalize 给 true 但 meta 标记未提供
    const input = ok({ id: 'a1', type: 'hindsight', endpoint: 'https://x.test', apiKey: '' });
    const kept = upsertDriverInList(off.list, input.driver, input.meta);
    expect(kept.list[0]!.enabled).toBe(false); // 不能把用户停用的驱动静默启用
    const explicit = ok({ id: 'a1', type: 'hindsight', endpoint: 'https://x.test', enabled: true });
    expect(upsertDriverInList(off.list, explicit.driver, explicit.meta).list[0]!.enabled).toBe(true);
  });

  it('remove 摘除并 removed=true;不存在 id 幂等 removed=false 且列表不变', () => {
    const r = removeDriverFromList(base, 'a1');
    expect(r.removed).toBe(true);
    expect(r.list.map((d) => d.id)).toEqual(['b2']);
    const none = removeDriverFromList(base, 'ghost');
    expect(none.removed).toBe(false);
    expect(none.list).toHaveLength(2);
  });

  it('toPublicDriver 不回显明文,只给 hasApiKey 与 secret ref', () => {
    const plain = toPublicDriver(drv({ apiKey: 'sk-super-secret' }));
    expect(plain.hasApiKey).toBe(true);
    expect(plain.secretRef).toBe('');
    expect(JSON.stringify(plain)).not.toContain('sk-super-secret');
    const ref = toPublicDriver(drv({ apiKey: 'secret://mem0-prod' }));
    expect(ref.secretRef).toBe('mem0-prod');
    expect(toPublicDriver(drv({ apiKey: '' })).hasApiKey).toBe(false);
  });
});

describe('verifyDriversReadback(把"宿主合并语义未知"变成运行时自检)', () => {
  const list = [drv({ id: 'a1' }), drv({ id: 'b2' })];

  it('逐字一致 → confirmed 且无 message', () => {
    const r = verifyDriversReadback(list, { drivers: list });
    expect(r).toEqual({ state: 'confirmed', message: '' });
  });

  it('宿主不供读回 → unverified(不谎报校验过,也不当成失败)', () => {
    for (const absent of [undefined, null]) {
      const r = verifyDriversReadback(list, absent);
      expect(r.state).toBe('unverified');
      expect(r.message).toContain('未校验');
    }
  });

  it('数组深合并残留（删除后尾部还在）→ mismatch 并点名多的 id', () => {
    const r = verifyDriversReadback([list[0]!], { drivers: list });
    expect(r.state).toBe('mismatch');
    expect(r.message).toContain('b2');
    expect(r.message).toContain('深合并残留');
  });

  it('同长度但字段不同（写入被部分覆盖）→ mismatch 并点名字段', () => {
    const edited = [drv({ id: 'a1', endpoint: 'https://new.test' }), list[1]!];
    const stale = [drv({ id: 'a1', endpoint: 'https://old.test' }), list[1]!];
    const r = verifyDriversReadback(edited, { drivers: stale });
    expect(r.state).toBe('mismatch');
    expect(r.message).toContain('endpoint');
  });

  it('apiKey 不参与比对（读回常被脱敏,比不得）', () => {
    const masked = [{ ...list[0]!, apiKey: '***' }, list[1]!];
    expect(verifyDriversReadback(list, { drivers: masked }).state).toBe('confirmed');
  });

  it('读回不是数组 → mismatch(而不是抛)', () => {
    expect(verifyDriversReadback(list, { drivers: 'nope' }).state).toBe('mismatch');
    expect(verifyDriversReadback(list, { drivers: undefined }).state).toBe('mismatch');
  });
});

describe('driver overlay(待生效层,无热重载通道下的正确基线)', () => {
  const base = [drv({ id: 'a1' })];
  beforeEach(() => resetOverlay());

  it('无 overlay = 基线;preview 不改状态,commit 才改(写失败不留痕)', () => {
    expect(currentDrivers(base).map((d) => d.id)).toEqual(['a1']);
    const r = previewDrivers(base, (l) => upsertDriverInList(l, drv({ id: 'b2' })));
    expect(r.created).toBe(true);
    // 没 commit 之前基线不变:updateConfig 抛错时面板不会显示"已改"
    expect(currentDrivers(base)).toHaveLength(1);
    commitDrivers(r.list);
    expect(currentDrivers(base).map((d) => d.id)).toEqual(['a1', 'b2']);
    expect(hasPendingReload(base)).toBe(true);
  });

  it('连续两次编辑基于 overlay 累积(第二次不会拿启动值覆盖第一次)', () => {
    commitDrivers(previewDrivers(base, (l) => upsertDriverInList(l, drv({ id: 'b2' }))).list);
    const second = previewDrivers(base, (l) => upsertDriverInList(l, drv({ id: 'c3' })));
    commitDrivers(second.list);
    expect(currentDrivers(base).map((d) => d.id)).toEqual(['a1', 'b2', 'c3']);
  });

  it('overlay 与基线一致时 hasPendingReload=false(不假报待重载)', () => {
    commitDrivers(base);
    expect(hasPendingReload(base)).toBe(false);
  });
});

describe('nonce 一次性令牌(T1.2)', () => {
  beforeEach(() => resetNonce());

  it('签发 → 消费成功 → 重放被拒(单次消费)', () => {
    const { nonce } = arm(1_000);
    expect(consume(nonce, 1_000)).toBe(true);
    expect(consume(nonce, 1_001)).toBe(false);
  });

  it('过期(>120s)拒绝;恰好边界仍可用一次', () => {
    const { nonce, expiresAt } = arm(10_000);
    expect(expiresAt).toBe(130_000);
    expect(consume(nonce, 129_999)).toBe(true);
    const second = arm(10_000);
    expect(consume(second.nonce, 130_001)).toBe(false);
  });

  it('非字符串/空串/未知 token 一律拒绝且不抛', () => {
    arm(1);
    expect(consume(undefined)).toBe(false);
    expect(consume('')).toBe(false);
    expect(consume(42)).toBe(false);
    expect(consume('deadbeef')).toBe(false);
  });

  it('未消费上限 3:第 4 次签发挤掉最早那张', () => {
    const n1 = arm(1_000).nonce;
    arm(1_001);
    arm(1_002);
    expect(pendingCount()).toBe(3);
    const n4 = arm(1_003).nonce;
    expect(pendingCount()).toBe(3);
    expect(consume(n1, 1_004)).toBe(false); // 最早那张已被挤兑
    expect(consume(n4, 1_005)).toBe(true);
  });

  it('过期令牌在下次签发时被清理(不涨内存)', () => {
    arm(1_000);
    arm(1_000);
    expect(pendingCount()).toBe(2);
    arm(200_000); // 前两张(过期于 121s)已扫掉
    expect(pendingCount()).toBe(1);
  });
});

describe('总闸读回与待生效层（ext-config-enable 的纯函数地基）', () => {
  it('三态：一致 confirmed / 无读回能力 unverified / 值不同 mismatch 且带可读文案', () => {
    expect(verifyEnabledReadback(true, { enabled: true })).toEqual({ state: 'confirmed', message: '' });
    expect(verifyEnabledReadback(true, undefined).state).toBe('unverified');
    expect(verifyEnabledReadback(true, null).state).toBe('unverified');
    const bad = verifyEnabledReadback(true, { enabled: false });
    expect(bad.state).toBe('mismatch');
    expect(bad.message).toContain('不一致');
    expect(bad.message).toContain('请核对 profile');
  });
  it('非对象读回不当成“已校验”（不能拿 undefined 属性当证据）', () => {
    expect(verifyEnabledReadback(true, 'nope' as unknown as object).state).toBe('unverified');
    expect(verifyEnabledReadback(false, {}).state).toBe('mismatch'); // 缺字段 = 不等于 false
  });

  it('待生效总闸只影响“需重载”提示，不改生效态基线', () => {
    resetOverlay();
    expect(pendingEnabledValue()).toBeUndefined();
    expect(hasPendingEnabled(false)).toBe(false);
    commitEnabled(true);
    expect(pendingEnabledValue()).toBe(true);
    expect(hasPendingEnabled(false)).toBe(true); // 盘上还是 false → 待重载
    expect(hasPendingEnabled(true)).toBe(false); // 已采纳 → 不再报
  });

  it('resetForTest 同时清 drivers 与总闸待生效层（否则用例会互相污染）', () => {
    commitDrivers([drv({ id: 'a' })]);
    commitEnabled(true);
    resetOverlay();
    expect(pendingEnabledValue()).toBeUndefined();
    expect(currentDrivers([drv({ id: 'base' })]).map((d) => d.id)).toEqual(['base']);
  });
});
