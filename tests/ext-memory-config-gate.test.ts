/**
 * T0.5 判据:配置默认全关时行为逐字一致;T0.11 判据:闸门与捕获配置无关、幂等。
 */
import { describe, expect, it } from 'vitest';
import { memorySchema, readExtMemory } from '../src/config.js';
import { normSyncMode } from '../src/ext-memory/types.js';
import { pushRedactGate, pushRedactRecord } from '../src/ext-memory/redact-gate.js';

describe('ext_memory config(T0.5)', () => {
  it('空配置解析:总闸关、档默认 shadow-read、驱动表空、各预算取默认值', () => {
    const cfg = memorySchema({});
    // extMemory 节标了 volatile(面板要能写),解算结果是 `{ get }` 引用——统一经 readExtMemory。
    const ext = readExtMemory(cfg.extMemory)!;
    expect(ext.enabled).toBe(false);
    expect(ext.syncMode).toBe('shadow-read');
    expect(ext.drivers).toEqual([]);
    expect(ext.lane.maxItemsPerDriver).toBe(10);
    expect(ext.push.maxItems).toBe(200);
    expect(ext.push.settleTimeoutMs).toBe(180_000);
    expect(ext.pull.intervalMs).toBe(900_000);
    expect(ext.requestTimeoutMs).toBe(15_000);
    expect(ext.health.failureThreshold).toBe(3);
  });

  it('非法 syncMode 不抛(union 崩溃半径纪律):字符串透传,消费侧归一兜底', () => {
    const cfg = memorySchema({ extMemory: { syncMode: 'bogus-mode' } });
    const ext = readExtMemory(cfg.extMemory)!;
    expect(ext.syncMode).toBe('bogus-mode');
    expect(normSyncMode(ext.syncMode)).toBe('shadow-read');
  });

  it('驱动条目解析补全默认键;整体配置树不因 ext_memory 缺席而炸', () => {
    const cfg = memorySchema({ extMemory: { enabled: true, drivers: [{ id: 'm1', type: 'mem0' }] } });
    const ext = readExtMemory(cfg.extMemory)!;
    expect(ext.enabled).toBe(true);
    const d = ext.drivers[0];
    expect(d).toMatchObject({ id: 'm1', type: 'mem0', enabled: true, endpoint: '', apiKey: '', space: '', extra: '' });
  });
});

describe('push redact gate(T0.11)', () => {
  const samples: Array<[string, string]> = [
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAx6vJ5Q0KCj8\n-----END RSA PRIVATE KEY-----', 'PRIVATE_KEY'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345', 'AUTH'],
    ['my api_key is "sk-live-9fJ3kD2mNpQrS7tUvWxYz0123456789"', 'API'],
    ['联系 admin@example.com 同步进度', 'EMAIL'],
  ];

  it('密钥类样本过闸后原值消失、占位符在场;counts 非空', () => {
    for (const [text] of samples) {
      const g = pushRedactGate(text);
      if ('redactError' in g) throw new Error('gate must not error');
      expect(g.redacted, text.slice(0, 40)).toBe(true);
      expect(g.text).toContain('[REDACTED:');
      expect(Object.keys(g.counts).length).toBeGreaterThan(0);
    }
  });

  it('幂等:已脱文本再过一遍恒等(重放安全)', () => {
    const first = pushRedactGate(samples[2][0]);
    if ('redactError' in first) throw new Error('unexpected');
    const second = pushRedactGate(first.text);
    if ('redactError' in second) throw new Error('unexpected');
    expect(second.text).toBe(first.text);
    expect(second.redacted).toBe(false);
  });

  it('干净文本恒等透传(零误伤面)', () => {
    const g = pushRedactGate('项目下周迁移到 pnpm workspace');
    expect(g).toMatchObject({ redacted: false });
  });

  it('记录级:content 与 metadata 字符串叶子同闸;入参对象不被改写', () => {
    const rec = {
      content: 'token 是 Bearer zzzYYYYxxxxWWWWvvvvUUUU1234567890',
      metadata: { dsh_keywords: ['部署', 'password=hunter2hunter2hunter2'], origin: '__manual__' },
    };
    const frozenCopy = JSON.parse(JSON.stringify(rec));
    const out = pushRedactRecord(rec);
    if ('redactError' in out) throw new Error('unexpected');
    expect(out.content).toContain('[REDACTED:');
    expect(JSON.stringify(out.metadata)).toContain('[REDACTED:');
    expect(rec).toEqual(frozenCopy); // 入参原封不动(原文不可被旁路改写)
  });
});
