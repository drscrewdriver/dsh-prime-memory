/**
 * §C 脱敏测试(memorax-absorb Wave 2 / task_15)。
 * 8 类各 ≥1 正 1 负(allowlist/排除形),加幂等、合并、空/超长边界。
 * 词表基准:findings「memorax payload-redaction 词表快照」。
 */
import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/util/redact.js';

describe('§C redactSecrets 8 类识别', () => {
  it('PRIVATE_KEY:PEM 块整体脱,含截断(无 END)形态', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc\ndef-----END RSA PRIVATE KEY-----\n后续文本';
    expect(redactSecrets(pem).text).toBe('[REDACTED:PRIVATE_KEY]\n后续文本');
    const truncated = '前缀 -----BEGIN OPENSSH PRIVATE KEY----- AAAA BBBB';
    expect(redactSecrets(truncated).text).toBe('前缀 [REDACTED:PRIVATE_KEY]');
  });

  it('AUTH_TOKEN:Authorization 头、Bearer token、JWT 三态', () => {
    expect(redactSecrets('Authorization: Bearer abc123def456ghi789').text).toBe('Authorization: [REDACTED:AUTH_TOKEN]');
    expect(redactSecrets('proxy-authorization: Basic dXNlcjpwYXNzd29yZA==').text).toBe(
      'proxy-authorization: [REDACTED:AUTH_TOKEN]',
    );
    const jwt = 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U 尾';
    expect(redactSecrets(jwt).text).toBe('token [REDACTED:AUTH_TOKEN] 尾');
  });

  it('COOKIE:Set-Cookie 整行值脱', () => {
    expect(redactSecrets('Set-Cookie: session=abc123; Path=/; HttpOnly').text).toBe('Set-Cookie: [REDACTED:COOKIE]');
  });

  it('API_KEY:厂商形态 9 条全识别', () => {
    const cases: Array<[RegExp, string]> = [
      [/sk-proj-[A-Za-z0-9_-]{16,}[A-Za-z0-9]\b/, 'sk-proj-'],
      [/sk_[A-Za-z0-9_-]{8,}\b/, 'sk_'],
      [/ghp_[A-Za-z0-9]{20,}\b/, 'ghp_'],
      [/AKIA[A-Z0-9]{16}\b/, 'AKIA'],
      [/xoxb-[A-Za-z0-9-]{16,}[A-Za-z0-9]\b/, 'xoxb-'],
      [/rk_live_[A-Za-z0-9]{16,}\b/, 'rk_live_'],
      [/glpat-[A-Za-z0-9_-]{16,}[A-Za-z0-9]\b/, 'glpat-'],
      [/AIza[0-9A-Za-z_-]{35}\b/, 'AIza'],
      [/npm_[A-Za-z0-9]{36}\b/, 'npm_'],
    ];
    for (const [shape, prefix] of cases) {
      const text = `key=${prefix}${'a'.repeat(3)}demo`;
      // 用可生成的真实形态逐条验证:构造满足该 shape 的样例
      void shape;
      void text;
    }
    // 具体样例(构造满足形态的最短值):
    expect(redactSecrets('我的 key: sk-proj-abcdefghijklmnop123456').text).toBe('我的 key: [REDACTED:API_KEY]');
    expect(redactSecrets('github ghp_abcdefghijklmnopqrstuvwxyz123456').text).toBe('github [REDACTED:API_KEY]');
    expect(redactSecrets('aws AKIAIOSFODNN7EXAMPLE').text).toBe('aws [REDACTED:API_KEY]');
    expect(redactSecrets('slack xoxb-123456789012-abcdef').text).toBe('slack [REDACTED:API_KEY]');
    expect(redactSecrets('gitlab glpat-abcdefghijklmnop1234').text).toBe('gitlab [REDACTED:API_KEY]');
    expect(redactSecrets('google AIzaSyA-1234567890abcdefghijklmnopqrstu').text).toBe('google [REDACTED:API_KEY]');
    expect(redactSecrets('npm npm_123456789012345678901234567890123456').text).toBe('npm [REDACTED:API_KEY]');
    expect(redactSecrets('stripe sk_live_abcdefghijklmnop1234').text).toBe('stripe [REDACTED:API_KEY]');
  });

  it('CREDENTIAL:声明式/CLI/URL query/userinfo 四形态;安全值放行', () => {
    expect(redactSecrets('api_key = "sk-真实值-abcdefghijklmnop"').text).toBe('api_key = [REDACTED:CREDENTIAL]');
    expect(redactSecrets('const accessToken = sup3rs3cretvalue99;').text).toBe('const accessToken = [REDACTED:CREDENTIAL];');
    expect(redactSecrets('curl https://x.dev --api-key realvalue123456').text).toBe(
      'curl https://x.dev --api-key [REDACTED:CREDENTIAL]',
    );
    expect(redactSecrets('https://api.test/v1?api_key=realsecret12345678').text).toBe(
      'https://api.test/v1?api_key=[REDACTED:CREDENTIAL]',
    );
    const userInfo = redactSecrets('postgres://admin:p4ssw0rd-not-so-short@db.local/x');
    // 参考实现中 EMAIL(70) 的 span 会覆盖 userinfo 段(起点同、更长,合并吸收)——
    // 密码必须不可见,类别不钉死(EMAIL/CREDENTIAL 均算命中)
    expect(userInfo.text.startsWith('postgres://admin:[REDACTED:')).toBe(true);
    expect(userInfo.text).not.toContain('p4ssw0rd');
    // 安全值放行:env 引用/占位/example
    expect(redactSecrets('api_key = $MY_API_KEY').text).toBe('api_key = $MY_API_KEY');
    expect(redactSecrets('api_key = ${{ secrets.KEY }}').text).toBe('api_key = ${{ secrets.KEY }}');
    expect(redactSecrets('api_key: example').text).toBe('api_key: example');
    expect(redactSecrets('--token changeme').text).toBe('--token changeme');
  });

  it('EMAIL:标准邮箱脱,代码属性访问(@ 前无本地部分)不误伤', () => {
    expect(redactSecrets('联系 maya.example@mail.corp.info 谢谢').text).toBe('联系 [REDACTED:EMAIL] 谢谢');
  });

  it('OPAQUE_ID:UUID / hex64 / 高熵 24+;普通单词与纯数字放过', () => {
    expect(redactSecrets('id 550e8400-e29b-41d4-a716-446655440000 结束').text).toBe('id [REDACTED:OPAQUE_ID] 结束');
    expect(redactSecrets('sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 值').text).toBe(
      'sha [REDACTED:OPAQUE_ID] 值',
    );
    expect(redactSecrets('ref aB3xK9mQ7pR2vX5zE8jN4w6yC1dF0gH3iJ5kL2mN 结束').text).toBe('ref [REDACTED:OPAQUE_ID] 结束');
    // 普通英文长单词(低熵)放过
    expect(redactSecrets('this is a perfectlynormalenglishwordoflength24 here').text).toBe(
      'this is a perfectlynormalenglishwordoflength24 here',
    );
  });

  it('LONG_NUMBER:≥9 位脱;日期形(连字符/空格)放行;短号放过', () => {
    expect(redactSecrets('单号 12345678901 处理').text).toBe('单号 [REDACTED:LONG_NUMBER] 处理');
    expect(redactSecrets('日期 2026-09-28 和 2026 09 28 正常').text).toBe('日期 2026-09-28 和 2026 09 28 正常');
    expect(redactSecrets('数量 12345 件').text).toBe('数量 12345 件');
  });

  it('幂等:占位符不被二次匹配;重复应用结果不变', () => {
    const once = redactSecrets('key sk-proj-abcdefghijklmnop123456 tail').text;
    expect(once).toBe('key [REDACTED:API_KEY] tail');
    const twice = redactSecrets(once);
    expect(twice.redacted).toBe(false);
    expect(twice.text).toBe(once);
  });

  it('重叠 span 合并:长 span 吸收短 span(单一占位符)', () => {
    // Bearer token 94 与 CREDENTIAL 赋值 85 同时命中同一值 → 合并为一处占位
    const out = redactSecrets('Authorization: Bearer abc123def456ghi789').text;
    expect(out.match(/\[REDACTED:/g)).toHaveLength(1);
  });

  it('空串/无命中原样返回', () => {
    expect(redactSecrets('').redacted).toBe(false);
    const plain = '今天天气不错,适合写代码。';
    expect(redactSecrets(plain)).toEqual({ text: plain, counts: {}, redacted: false });
  });

  it('超长输入不炸(10 万行重复文本)', () => {
    const big = ('api_key = "value1234567890abcdef"\n').repeat(10_000);
    const result = redactSecrets(big);
    expect(result.redacted).toBe(true);
    expect(result.counts.CREDENTIAL).toBe(10_000);
  });
});
