/**
 * DrscClient(T8.4 读切,drsc-redact-memory-wiring task_18):memory 读历史
 * 面的 dsh-reference-session-collector HTTP 客户端。
 *
 * 两个读点(R7):
 * - 蒸馏背景窗(recentBySession 等价供给)→ `op=session&tail=N&redact=1`
 *   (collector task_11 尾窗升序 + task_12 redact 臂);
 * - 工具面 conversation_search → `op=search&redact=1`(命中基于原文 fts,
 *   返回 snippet 取脱敏锚定文本)。
 *
 * 加上 issue #14-B 的**重建事实源**：`op=sessions` 枚举 + `op=session`（**不带 tail**）
 * 逐会话拉全量——对全量重建来说“尾窗”不够用，而 collector 侧不带 tail 即 `ORDER BY seq ASC`
 * 无 LIMIT。此路径同样恒带 `redact=1`。
 *
 * 硬依赖纪律(对齐 T7.3 裁定):collector 缺席/超时/非 2xx/ok=false 一律抛
 * {@link DrscClientError}——**绝不回退本地 l0**(表已退役,无退路);调用方
 * 分口径处理:蒸馏背景窗空窗降级(runner),工具面显式报错(tools)。
 *
 * 同源 Host 解析(steward drs-source 的 resolveDrsBaseUrl 同款):
 * 显式 baseUrl > 首个 trustedHosts 条目(补 http://)> 宿主实际监听 origin
 * (issue #20:Desktop App 走随机端口,写死 8080 永远对不上)> `http://127.0.0.1:8080`
 * (宿主缺省口)。Host 头**只回显被选作基址的那个 trustedHosts 条目**:collector
 * 信任门是精确匹配,条目省略端口而 URL 带端口会失配——所以基址来自 origin 兜底时
 * 索性不回显(等价于旧版 trustedHosts 为空时的形状),而不是拿另一个 authority 去撞门。
 * trustedHosts / origin 均惰性读取(webStartup、webServer 可能晚于本插件就绪),
 * 每次请求现算,无缓存陈旧面。
 */
import type { ConversationMessage } from '../types.js';

/** collector API 路径(与其 DRS_API_PATH 字面一致;不跨包 import)。 */
export const DRSC_API_PATH = '/api/dsh-reference-session-collector';

/** 客户端缺省超时:loopback 正常 <10ms,5s 是给冷启动 GC/断点的天花板。 */
export const DRSC_DEFAULT_TIMEOUT_MS = 5_000;

/** collector 缺席/超时/契约破损。显式报错,不回退本地。 */
export class DrscClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DrscClientError';
  }
}

/** 基址与其来源。 */
export interface ResolvedDrscBase {
  url: string;
  /** 基址是否取自显式配置或 trustedHosts 条目(即解析序的前两档)。 */
  fromConfigured: boolean;
}

/** 供 Host 回显的条目:须与 {@link resolveDrscBaseUrl} 的选取口径逐字一致。 */
export function firstDrscTrustedHost(trustedHosts?: readonly string[]): string | undefined {
  return trustedHosts?.find((entry) => entry.trim() !== '')?.trim();
}

/**
 * 基址解析:显式配置 > 首个 trustedHosts 条目(补 http:// 前缀)> 宿主实际监听
 * origin(issue #20 新增的兜底)> `http://127.0.0.1:8080`(宿主默认口;trustedHosts
 * 缺席的老线 collector 门本就放行)。
 *
 * origin 刻意排在 trustedHosts **之下**:它只替换那句写死的 8080。放上去会把
 * 已经能工作的配置(靠 `--trusted-host` 指过地址)改到另一个 authority 上,那是回归。
 */
export function resolveDrscBaseUrl(
  explicit: string | undefined,
  trustedHosts?: readonly string[],
  fallbackOrigin?: string,
): string {
  return resolveDrscBaseUrlDetail(explicit, trustedHosts, fallbackOrigin).url;
}

/** 条目→URL 的单一规范化：无 scheme 时补 `http://`。三档来源共用，不开两种形状。 */
function withScheme(authority: string): string {
  return /^https?:\/\//u.test(authority) ? authority : `http://${authority}`;
}

/** {@link resolveDrscBaseUrl} 的带来源形态,供客户端决定 Host 回显。 */
export function resolveDrscBaseUrlDetail(
  explicit: string | undefined,
  trustedHosts?: readonly string[],
  fallbackOrigin?: string,
): ResolvedDrscBase {
  const trimmed = explicit?.trim() ?? '';
  const pick = trimmed !== '' ? trimmed : firstDrscTrustedHost(trustedHosts);
  if (pick !== undefined && pick !== '') {
    return { url: withScheme(pick), fromConfigured: true };
  }
  const origin = fallbackOrigin?.trim() ?? '';
  // origin 也走同一规范化:宿主 getOrigin() 返的是全 URL(此处原样透传),但若调用方
  // 递的是 `127.0.0.1:<port>` 这种 authority,不补 scheme 会让拼出的请求 URL 直接不行。
  if (origin !== '') return { url: withScheme(origin), fromConfigured: false };
  return { url: 'http://127.0.0.1:8080', fromConfigured: false };
}

/** `op=session` 的一个 segment 行(redact=1 时 text 为脱敏正文;wire 蛇形直取)。 */
export interface DrscSessionRow {
  seq: number;
  turn: number;
  step: number;
  kind: string;
  role: string;
  time: number;
  text: string;
}

/** `op=search` 的一个命中(redact=1 时 snippet 为脱敏锚定文本)。 */
export interface DrscSearchHit {
  session_id: string;
  seq: number;
  kind: string;
  rank: number;
  snippet: string;
  time: number;
  on_surface: number;
  turn: number;
}

/** `op=sessions` 的一个会话摘要行（分页枚举用；wire 蛇形直取）。 */
export interface DrscSessionSummary {
  session_id: string;
  title: string;
  cwd: string;
  event_count: number;
  turn_count: number;
  /** 末条消息时间（ms）—— collector 按它降序排，客户端用时注意反转。 */
  last_time_ms: number;
}

/** kind → L0 角色词表(memory 只收 user/assistant 两类,其余(tool/* 等)不映射)。 */
export function drscRoleOf(kind: string): 'user' | 'assistant' | undefined {
  if (kind === 'user/message') return 'user';
  if (kind === 'assistant/message') return 'assistant';
  return undefined;
}

/**
 * session 行 → ConversationMessage 形状映射(蒸馏背景窗用)。
 * - id:确定性合成 `drsc:<session>:<seq>`(跨次调用稳定,anchor 追溯可解释);
 * - anchor:turn>0 才成立(与 ConversationAnchor 红线一致:没坐标不伪造);
 * - 非 user/assistant 段(tool/call 等)返回 undefined,调用方跳过。
 */
export function drscRowToConversationMessage(
  row: DrscSessionRow,
  sessionId: string,
): ConversationMessage | undefined {
  const role = drscRoleOf(row.kind);
  if (role === undefined) return undefined;
  const msg: ConversationMessage = {
    id: `drsc:${sessionId}:${row.seq}`,
    role,
    content: row.text,
    timestamp: row.time,
  };
  if (Number.isFinite(row.turn) && row.turn > 0) {
    msg.anchor = { sessionId, turn: row.turn };
    if (Number.isFinite(row.step) && row.step > 0) msg.anchor.step = row.step;
  }
  return msg;
}

/** 包络收窄:响应必须是 {ok:true, ...} 形状。 */
interface DrscEnvelope {
  ok: boolean;
  error?: unknown;
}

/**
 * `op=session` 包络 → 行数组。
 *
 * `session:null` = collector 没有这个会话 —— 新会话首轮的常态，**不是错误**
 * （“没有内容”与“没拿到”必须分开：前者空窗降级，后者抛 DrscClientError）。
 */
function parseSessionRows(body: Record<string, unknown>): DrscSessionRow[] {
  if (body['session'] === null || body['session'] === undefined) return [];
  const rows = Array.isArray(body['rows']) ? (body['rows'] as Record<string, unknown>[]) : [];
  return rows.map((r) => ({
    seq: Number(r['seq'] ?? 0),
    turn: Number(r['turn'] ?? 0),
    step: Number(r['step'] ?? 0),
    kind: String(r['kind'] ?? ''),
    role: String(r['role'] ?? ''),
    time: Number(r['time'] ?? 0),
    text: String(r['text'] ?? ''),
  }));
}

export interface DrscClientOptions {
  /** 显式基址(缺省走 trustedHosts → 宿主 origin → 127.0.0.1:8080,见 resolveDrscBaseUrl)。 */
  baseUrl?: string;
  /** trustedHosts 惰性读取(webStartup 服务可能晚于装配;每次请求现取)。 */
  trustedHosts?: () => readonly string[] | undefined;
  /**
   * 宿主实际监听 origin 惰性读取(issue #20)。webServer 服务可能晚就绪/换实例/
   * 下线,故与 trustedHosts 同款每次现取;取不到即返回 undefined → 落回 8080 老行为。
   */
  origin?: () => string | undefined;
  /** 注入面(单测);缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 单请求超时 ms;缺省 {@link DRSC_DEFAULT_TIMEOUT_MS}。 */
  timeoutMs?: number;
}

export class DrscClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: DrscClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DRSC_DEFAULT_TIMEOUT_MS;
  }

  /** 每次请求现算基址与 Host 回显(trustedHosts/origin 惰性;无缓存陈旧面)。 */
  private base(): { url: string; hostHeader?: string } {
    const trusted = this.options.trustedHosts?.() ?? [];
    const origin = this.safeOrigin();
    const resolved = resolveDrscBaseUrlDetail(this.options.baseUrl, trusted, origin);
    const base = resolved.url.replace(/\/+$/u, '');
    // Host 头只在**存在非空 trustedHosts 条目**时回显(与旧版逐字同口径)。基址来自
    // origin 兜底时本来就没有条目可回显,而 collector 信任门精确匹配 authority,
    // 拿条目原串去配一个带真实端口的 URL 只会失配(#20 的报错面)。
    const echo = resolved.fromConfigured ? firstDrscTrustedHost(trusted) : undefined;
    return { url: `${base}${DRSC_API_PATH}`, ...(echo !== undefined ? { hostHeader: echo } : {}) };
  }

  /** origin 探针失败(服务未就绪/属性读抛)不得影响请求:视作取不到,落老行为。 */
  private safeOrigin(): string | undefined {
    if (this.options.origin === undefined) return undefined;
    try {
      return this.options.origin();
    } catch {
      return undefined;
    }
  }

  /** 一个 GET 的 JSON 包络(非 2xx / ok!==true / 超时 / 断网一律抛 DrscClientError)。 */
  private async getJson(query: string): Promise<Record<string, unknown>> {
    const { url, hostHeader } = this.base();
    let response: Response;
    try {
      response = await this.fetchImpl(`${url}${query}`, {
        headers: {
          accept: 'application/json',
          ...(hostHeader === undefined ? {} : { host: hostHeader }),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DrscClientError(`collector 不可达(${query}): ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    if (!response.ok) throw new DrscClientError(`collector HTTP ${response.status}(${query})`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new DrscClientError(`collector 响应非 JSON(${query})`, { cause: err });
    }
    if (typeof body !== 'object' || body === null || (body as DrscEnvelope).ok !== true) {
      const reason =
        typeof body === 'object' && body !== null
          ? String((body as DrscEnvelope).error ?? 'ok=false')
          : '响应非对象';
      throw new DrscClientError(`collector 包络异常(${query}): ${reason}`);
    }
    return body as Record<string, unknown>;
  }

  /**
   * 会话尾窗:`op=session&session=<id>&tail=N&redact=1` → 脱敏消息行(升序)。
   * collector 无此会话(session:null)返回空数组(新会话首轮的常态,非错误)。
   */
  async sessionTail(sessionId: string, tail: number): Promise<DrscSessionRow[]> {
    const body = await this.getJson(
      `?op=session&session=${encodeURIComponent(sessionId)}&tail=${Math.max(0, Math.floor(tail))}&redact=1`,
    );
    return parseSessionRows(body);
  }

  /**
   * **整会话**正文（issue #14-B 重建事实源）：`op=session&session=<id>&redact=1`，
   * **不带 `tail`** —— collector 侧 `tail` 未给时走 `ORDER BY s.seq ASC` 无 LIMIT，即全量。
   *
   * `redact=1` 是**硬要求**，不是可选项：collector 的 `session` 缺省是原文臂，
   * 而 memory 捕获侧是写前单点脱敏；重建若走原文臂，产出的 L1 会比正常蒸馏「更脏」，
   * 而且会经 md 投射落盘。
   */
  async sessionAll(sessionId: string): Promise<DrscSessionRow[]> {
    const body = await this.getJson(`?op=session&session=${encodeURIComponent(sessionId)}&redact=1`);
    return parseSessionRows(body);
  }

  /**
   * 会话枚举：`op=sessions&offset&limit`（collector 侧 limit 钳到 1..500）。
   *
   * 重建的事实源没有“全量导出”单口（也不应该有：一个响应装不下几万条正文），
   * 所以走「枚举会话 → 逐会话拉全量」的 N+1 组合。采集端分页是 0-SQL 的内存切片，
   * 代价仅在于请求数。
   */
  async listSessions(offset: number, limit: number): Promise<{ total: number; rows: DrscSessionSummary[] }> {
    const from = Math.max(0, Math.floor(offset));
    const size = Math.max(1, Math.min(500, Math.floor(limit)));
    const body = await this.getJson(`?op=sessions&offset=${from}&limit=${size}`);
    const rows = Array.isArray(body['rows']) ? (body['rows'] as Record<string, unknown>[]) : [];
    return {
      total: Number(body['total'] ?? rows.length),
      rows: rows.map((r) => ({
        session_id: String(r['session_id'] ?? ''),
        title: String(r['title'] ?? ''),
        cwd: String(r['cwd'] ?? ''),
        event_count: Number(r['event_count'] ?? 0),
        turn_count: Number(r['turn_count'] ?? 0),
        last_time_ms: Number(r['last_time_ms'] ?? 0),
      })),
    };
  }

  /** 原史检索:`op=search&q=<query>&limit=N&redact=1` → 脱敏 snippet 命中。 */
  async search(query: string, limit: number): Promise<DrscSearchHit[]> {
    const body = await this.getJson(
      `?op=search&q=${encodeURIComponent(query)}&limit=${Math.max(1, Math.floor(limit))}&redact=1`,
    );
    const hits = Array.isArray(body['hits']) ? (body['hits'] as Record<string, unknown>[]) : [];
    return hits.map((h) => ({
      session_id: String(h['session_id'] ?? ''),
      seq: Number(h['seq'] ?? 0),
      kind: String(h['kind'] ?? ''),
      rank: Number(h['rank'] ?? 0),
      snippet: String(h['snippet'] ?? ''),
      time: Number(h['time'] ?? 0),
      on_surface: Number(h['on_surface'] ?? 1),
      turn: Number(h['turn'] ?? 0),
    }));
  }
}
