/**
 * issue #20 的探针单测：宿主监听 origin 的两条取数路径与三档降级。
 *
 * 钉死:① `getOrigin()` 优先于 `port`(它带正确的 protocol 与 bind host 形式,插件算不出);
 * ② `getOrigin()` 抛错(宿主自己的语义:未 listen / 绑定地址带 zone id)时落 `port`;
 * ③ 老线只有 `port`,且必须 `number > 0` 才用(未 listen 时宿主读到 undefined,
 *   拼出来的 `http://127.0.0.1:undefined` 是能发出但永远错的 URL);
 * ④ 全都取不到 → undefined,由调用方落回写死的 8080 = 旧行为。
 *
 * 不测什么:不拉 cordis 宿主。ctx 的形状只用到 `webServer` 属性与可选 `ctx.get`,
 * 故这里给结构化替身即可——真机侧的 origin 值形状已在计划产物里逐线取证(见
 * findings「新取证」节),不在单测里重复断言宿主内部。
 */
import { describe, expect, it } from 'vitest';
import { readWebServerOrigin } from '../src/clients/web-server-origin.js';

/** 只给 webServer 属性的最小 ctx 替身。 */
const ctxWith = (svc: unknown): unknown => ({ webServer: svc });

describe('readWebServerOrigin(issue #20 降级探针)', () => {
  it('getOrigin() 可用时优先采用，哪怕 port 也在(新线宿主两者都有)', () => {
    const svc = { getOrigin: () => 'https://127.0.0.1:3080', port: 3080 };
    expect(readWebServerOrigin(ctxWith(svc))).toBe('https://127.0.0.1:3080');
  });

  it('getOrigin() 抛错(未 listen)→ 落 port 一档', () => {
    const svc = {
      getOrigin: () => {
        throw new Error('webserver: origin read before the listener bound a port');
      },
      port: 51337,
    };
    expect(readWebServerOrigin(ctxWith(svc))).toBe('http://127.0.0.1:51337');
  });

  it('getOrigin() 返回空/非串 → 同样落 port，不产出空 origin', () => {
    expect(readWebServerOrigin(ctxWith({ getOrigin: () => '   ', port: 4001 })))
      .toBe('http://127.0.0.1:4001');
    expect(readWebServerOrigin(ctxWith({ getOrigin: () => 42, port: 4002 })))
      .toBe('http://127.0.0.1:4002');
  });

  it('老线无 getOrigin：port 为正数才用', () => {
    expect(readWebServerOrigin(ctxWith({ port: 53084 }))).toBe('http://127.0.0.1:53084');
  });

  it('port 未就绪(undefined/0/负/非数/NaN)一律返回 undefined', () => {
    for (const port of [undefined, 0, -1, Number.NaN, '8080', null]) {
      expect(readWebServerOrigin(ctxWith({ port })), `port=${String(port)}`).toBeUndefined();
    }
  });

  it('webServer 缺席 / ctx.get 兜底 / 属性读抛 三种装配形态', () => {
    // ① 属性不存在
    expect(readWebServerOrigin({})).toBeUndefined();
    // ② 直读为空但 ctx.get 拿得到(服务晚就绪后的形态)
    expect(readWebServerOrigin({ get: (n: string) => (n === 'webServer' ? { port: 4100 } : undefined) }))
      .toBe('http://127.0.0.1:4100');
    // ③ cordis Proxy 面：未授权属性读直接抛，须视作未就绪而非冒泡
    const throwing = {
      get webServer(): never {
        throw new Error('cannot get property "webServer" without inject');
      },
    };
    expect(readWebServerOrigin(throwing)).toBeUndefined();
    // ④ 非对象入参不炸
    expect(readWebServerOrigin(undefined)).toBeUndefined();
    expect(readWebServerOrigin('x')).toBeUndefined();
  });

  it('探针永不把异常抛出给调用方(请求面必须照常发出)', () => {
    const hostile = {
      webServer: {
        get port(): never {
          throw new Error('boom');
        },
      },
    };
    expect(() => readWebServerOrigin(hostile)).not.toThrow();
    expect(readWebServerOrigin(hostile)).toBeUndefined();
  });
});
