/**
 * 面板路由 Host 围栏的白名单来源与 authority 比对（探针单测）。
 *
 * 钉死四件事：
 * ① loopback 判据不扩大（`127.x` 四段合法才算，`::1` 必须带方括号）；
 * ② 白名单有两条取数路径：宿主服务优先，取不到（cordis Proxy 面抛 / 作用域不可见 /
 *    空数组）必须落到进程参数 `--trusted-host`——只读服务会让围栏退化成「只认
 *    loopback」，远程访问时整个面板 403；
 * ③ authority 比对与宿主 isTrustedAuthority 同款：带端口条目精确匹配，不带端口条目
 *    匹配同名主机任意端口，大小写与冗余默认端口不参与判定；
 * ④ 围栏放行面 = loopback ∪ 白名单，其余一律拒绝。
 *
 * 不测什么：不拉 cordis 宿主、不真起 HTTP。ctx 的形状只用到属性读与可选 `ctx.get`，
 * 给结构化替身即可；真机侧的 Host 形状（局域网 IP / 反代域名 / 裸 IPv6）已在 issue
 * 复现记录里取证，不在单测里重复断言宿主内部。
 */
import { describe, expect, it } from 'vitest';
import {
  hostFenceAllows,
  isLoopbackHostname,
  matchesTrustedAuthority,
  readBindHostname,
  readStartupTrustedHosts,
  readTrustedHostsFromArgv,
  resolveTrustedAuthorities,
} from '../src/trusted-hosts.js';

/** 构造一个只暴露 webStartup（或 webRuntime）的结构化 ctx 替身。 */
const ctxWithStartup = (svc: unknown, name: 'webStartup' | 'webRuntime' = 'webStartup'): unknown => ({
  [name]: svc,
});

describe('isLoopbackHostname', () => {
  it('localhost / [::1] / 127.x.x.x 是 loopback', () => {
    for (const host of ['localhost', '[::1]', '127.0.0.1', '127.1.2.3']) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
  });

  it('非 loopback 一律 false（含裸 ::1 与非四段/越界数值）', () => {
    for (const host of ['192.168.31.9', 'dsh.example.com', '::1', '127.0.0', '127.0.0.256', '10.0.0.1']) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });
});

describe('readTrustedHostsFromArgv', () => {
  it('重复 flag 累积；单个 flag 后可跟多个值', () => {
    const argv = ['node', 'dsh', 'web', '--trusted-host', 'a.example.com', 'b.example.com:9443', '--trusted-host', '192.168.1.2:13080'];
    expect(readTrustedHostsFromArgv(argv)).toEqual(['a.example.com', 'b.example.com:9443', '192.168.1.2:13080']);
  });

  it('支持 --trusted-host=值 形式', () => {
    expect(readTrustedHostsFromArgv(['node', 'dsh', '--trusted-host=c.example.com'])).toEqual(['c.example.com']);
  });

  it('没有该 flag、或 flag 后紧跟别的 flag 时返回空数组', () => {
    expect(readTrustedHostsFromArgv(['node', 'dsh', 'web', '--no-open'])).toEqual([]);
    expect(readTrustedHostsFromArgv(['node', 'dsh', '--trusted-host', '--no-open'])).toEqual([]);
  });

  it('丢掉空白与非字符串条目，不产出空 authority', () => {
    expect(readTrustedHostsFromArgv(['node', 'dsh', '--trusted-host', '  ', 'd.example.com'])).toEqual(['d.example.com']);
  });
});

describe('readStartupTrustedHosts', () => {
  it('读 webStartup 的 trustedHosts', () => {
    expect(readStartupTrustedHosts(ctxWithStartup({ trustedHosts: ['a.example.com'] }))).toEqual(['a.example.com']);
  });

  it('webStartup 缺席时回退 webRuntime（0.2.1-a.2 前的宿主）', () => {
    expect(readStartupTrustedHosts(ctxWithStartup({ trustedHosts: ['b.example.com'] }, 'webRuntime'))).toEqual(['b.example.com']);
  });

  it('属性读抛（cordis Proxy 面）时退到 ctx.get，两层都取不到返回 undefined', () => {
    const throwing = {
      get webStartup(): unknown {
        throw new Error('cannot get property "webStartup" without inject');
      },
      get: (name: string) => (name === 'webRuntime' ? { trustedHosts: ['c.example.com'] } : undefined),
    };
    expect(readStartupTrustedHosts(throwing)).toEqual(['c.example.com']);
    expect(readStartupTrustedHosts({ get: () => undefined } as unknown)).toBeUndefined();
    expect(readStartupTrustedHosts(undefined)).toBeUndefined();
  });

  it('空数组视为「没读到」，交给下一档而不是当成「信任列表为空」', () => {
    expect(readStartupTrustedHosts(ctxWithStartup({ trustedHosts: [] }))).toBeUndefined();
  });
});

describe('resolveTrustedAuthorities', () => {
  const withArgv = (argv: string[], run: () => void): void => {
    const saved = process.argv;
    process.argv = argv;
    try {
      run();
    } finally {
      process.argv = saved;
    }
  };

  it('宿主服务优先于进程参数', () => {
    withArgv(['node', 'dsh', '--trusted-host', 'from-argv.example.com'], () => {
      expect(resolveTrustedAuthorities(ctxWithStartup({ trustedHosts: ['from-service.example.com'] }))).toEqual(['from-service.example.com']);
    });
  });

  it('服务取不到时落到进程参数（本机实测正是这条路径）', () => {
    withArgv(['node', 'dsh', 'web', '--trusted-host', '192.168.31.9:13080', 'dsh.example.com'], () => {
      expect(resolveTrustedAuthorities({ get: () => undefined } as unknown)).toEqual(['192.168.31.9:13080', 'dsh.example.com']);
    });
  });
});

describe('readBindHostname(绑定地址一档)', () => {
  it('读 webServer.host 并归一化(IPv6 方括号 / zone id 都要能对上)', () => {
    expect(readBindHostname({ webServer: { host: '10.0.0.7' } })).toBe('10.0.0.7');
    expect(readBindHostname({ webServer: { host: 'fd42::1' } })).toBe('fd42::1');
    expect(readBindHostname({ webServer: { host: '[fd42::1]' } })).toBe('fd42::1');
    expect(readBindHostname({ webServer: { host: 'fe80::1%eth0' } })).toBe('fe80::1');
  });

  it('服务缺席 / 空值一律 undefined', () => {
    expect(readBindHostname(undefined)).toBeUndefined();
    expect(readBindHostname({} as unknown)).toBeUndefined();
    expect(readBindHostname({ webServer: {} })).toBeUndefined();
    expect(readBindHostname({ webServer: { host: '   ' } })).toBeUndefined();
    expect(readBindHostname({ webServer: { host: 42 } })).toBeUndefined();
  });
});

describe('matchesTrustedAuthority', () => {
  const asUrl = (host: string, scheme = 'http:'): URL => new URL(`${scheme}//${host}`);

  it('带端口的条目只匹配该精确 authority', () => {
    const entries = ['192.168.31.9:13080'];
    expect(matchesTrustedAuthority(asUrl('192.168.31.9:13080'), entries)).toBe(true);
    expect(matchesTrustedAuthority(asUrl('192.168.31.9:9999'), entries)).toBe(false);
  });

  it('不带端口的条目匹配同名主机的任意端口（反代换端口场景）', () => {
    const entries = ['dsh.example.com'];
    expect(matchesTrustedAuthority(asUrl('dsh.example.com'), entries)).toBe(true);
    expect(matchesTrustedAuthority(asUrl('dsh.example.com:9443'), entries)).toBe(true);
    expect(matchesTrustedAuthority(asUrl('other.example.com'), entries)).toBe(false);
  });

  it('大小写不参与判定', () => {
    expect(matchesTrustedAuthority(asUrl('DSH.Example.COM'), ['dsh.example.com'])).toBe(true);
  });

  it('IPv6 字面量按方括号形式比对', () => {
    expect(matchesTrustedAuthority(asUrl('[fd42::1]:13080'), ['[fd42::1]:13080'])).toBe(true);
    expect(matchesTrustedAuthority(asUrl('[fd42::2]:13080'), ['[fd42::1]:13080'])).toBe(false);
  });

  it('非法条目被忽略，不影响后续条目', () => {
    expect(matchesTrustedAuthority(asUrl('dsh.example.com'), ['http://bad entry', 'dsh.example.com'])).toBe(true);
  });
});

describe('hostFenceAllows', () => {
  it('loopback 永远放行，与白名单无关', () => {
    for (const host of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080']) {
      expect(hostFenceAllows(host, undefined), host).toBe(true);
    }
  });

  it('Host 命中宿主受信列表即放行（局域网 IP / 反代域名）', () => {
    const ctx = ctxWithStartup({ trustedHosts: ['192.168.31.9:13080', 'dsh.example.com'] });
    expect(hostFenceAllows('192.168.31.9:13080', ctx)).toBe(true);
    expect(hostFenceAllows('dsh.example.com:9443', ctx)).toBe(true);
  });

  it('命中 --host 绑定地址即放行(端口不参与判定,同宿主语义)', () => {
    const v4 = { webServer: { host: '10.0.0.7' } };
    expect(hostFenceAllows('10.0.0.7:3080', v4)).toBe(true);
    expect(hostFenceAllows('10.0.0.8:3080', v4)).toBe(false);
    const v6 = { webServer: { host: 'fd42::1' } };
    expect(hostFenceAllows('[fd42::1]:3080', v6)).toBe(true);
    expect(hostFenceAllows('[fd42::2]:3080', v6)).toBe(false);
  });

  it('不在白名单的外站一律拒绝', () => {
    const ctx = ctxWithStartup({ trustedHosts: ['dsh.example.com'] });
    expect(hostFenceAllows('evil.example.com', ctx)).toBe(false);
    expect(hostFenceAllows('192.168.31.9:9999', ctx)).toBe(false);
  });

  it('缺失 / 空 / 非法 Host 一律拒绝', () => {
    expect(hostFenceAllows(undefined, undefined)).toBe(false);
    expect(hostFenceAllows('', undefined)).toBe(false);
    expect(hostFenceAllows('http://evil.example.com/path', undefined)).toBe(false);
  });
});
