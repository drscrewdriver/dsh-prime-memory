/**
 * tui-command.ts — `/memory`：prime-memory 的 dsh-tui 终端面（宿主斜杠命令）。
 *
 * 背景：dsh-tui 不加载 client 半边（59 个 client 文件里的 11 个 tab 全部不执行），
 * 也调不到插件 RPC。记忆库在终端里因此完全不可见。命令面只读：
 *   status   = 库路径/维度 + L0/L1/回执/冲突计数
 *   records  = 最近 N 条 L1 原子记忆（按 updated_time 倒序）
 *   conflicts= 待裁决冲突数与前几条
 *
 * 契约（.agents/plans/dsh-tui-faces/spec.md §3）：单行 <=100、总行 <=40、无 ANSI、--json 单行。
 */

import type { Context } from '@deepseek-ai/cordis'

export type CommandKind = 'success' | 'error'
export interface CommandResult { kind: CommandKind; text: string }

export interface MemoryRow {
  record_id?: string
  content?: string
  type?: string
  priority?: number
  scene_name?: string
  updated_time?: string
  family?: string
}

export interface MemoryStatus {
  dbPath: string
  dims: number
  l0: number
  l1: number
  receipts: number
  conflicts: number
  error?: string
}

export interface MemorySwitches {
  enabled: boolean
  capture: boolean
  distill: boolean
  recall: boolean
  injectBootMode: string
  extractBootMode: string
  memoryMutate: boolean
  /** 部署上限：cordis.patch.yml 停用的分项，运行时开关拨不动。 */
  ceilings: { capture: boolean; distill: boolean; recall: boolean }
}

export interface RecalledRow {
  id: string
  content?: string
  type?: string
  family?: string
  scene_name?: string
  superseded?: boolean
  lane?: string
}

export interface MemoryCommandDeps {
  status(): MemoryStatus
  records(limit: number): MemoryRow[]
  conflicts(limit: number): MemoryRow[]
  /** 外部记忆驱动（配置是事实源，ext_drivers 只是运行态镜像）。 */
  ext(): { enabled: boolean; syncMode: string; drivers: string[] }
  /** Room 注册表（major 或 major/minor）。 */
  rooms(): Array<{ slug: string; label?: string; status?: string }>
  /** L2/L3 分族场景文件。 */
  scenes(): Promise<{ chat: number; work: number; sample: string[] }>
  /** 开关现值（live.get 投影 + 部署上限）。 */
  switches(): MemorySwitches
  /**
   * 写总闸 enabled（命令层唯一写操作）。实现方内部走 live.update 并回读，
   * 返回是否写入、回读生效值、是否发生漂移（写入成功但回读不一致）。
   */
  setEnabled(next: boolean): Promise<{ applied: boolean; effective: boolean; drift: boolean }>
  /** 某会话已注入的召回集（正文从 l1_records 取；superseded=正文已被摘要取代）。 */
  recalled(sessionId: string, limit: number): RecalledRow[]
  /** 最近有注入记录的会话（--last 用；按 updatedAt 倒序）。 */
  recentSessions(): Array<{ key: string; at: number; count: number }>
}

const MAX_LINES = 40
const MAX_WIDTH = 100

export function clip(text: string, width = MAX_WIDTH): string {
  const value = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+$/, '')
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`
}

export function renderLines(lines: string[], limit = MAX_LINES): string {
  const clipped = lines.map((line) => clip(line))
  if (clipped.length <= limit) return clipped.join('\n')
  const kept = clipped.slice(0, limit - 1)
  return [...kept, `… 还有 ${clipped.length - kept.length} 行，加 --all 查看`].join('\n')
}

const ok = (lines: string[]): CommandResult => ({ kind: 'success', text: renderLines(lines) })
const fail = (reason: string, next?: string): CommandResult =>
  ({ kind: 'error', text: renderLines([reason, ...(next ? [`  ${next}`] : [])]) })

function parse(rawInput: string): { argv: string[]; json: boolean; all: boolean; last: boolean; session?: string; limit: number } {
  const argv: string[] = []
  let json = false
  let all = false
  let last = false
  let session: string | undefined
  let limit = 10
  for (const token of String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)) {
    if (token === '--json') json = true
    else if (token === '--all') all = true
    else if (token === '--last') last = true
    else if (token.startsWith('--session=')) session = token.slice('--session='.length)
    else if (/^--n=\d+$/.test(token)) limit = Math.min(40, Math.max(1, Number(token.slice(4))))
    else if (!token.startsWith('--')) argv.push(token)
  }
  return { argv, json, all, last, session, limit: all ? 40 : limit }
}

const HELP = [
  'memory — 分层蒸馏记忆（L0/L1/L2/L3）的终端面',
  '  /memory              库状态与各层计数',
  '  /memory records      最近 10 条 L1（--n=20 / --all 调数量）',
  '  /memory conflicts    待裁决冲突',
  '  /memory rooms        Room 注册表（major / major-minor）',
  '  /memory scenes       场景文件计数（chat / work 分族）',
  '  /memory ext          外部记忆驱动与同步模式',
  '  /memory switch       查看记忆开关现值（总闸/捕获/蒸馏/召回/挡位/高权限）',
  '  /memory on|off       拨总闸 enabled（默认 dry 回显；加 --yes 才写入）',
  '  /memory injected     本会话已注入的记忆（--last 取最近会话 / --session=<id>）',
  '  /memory rebuild      dry run：预估重蒸馏影响面（不写库）',
  '  flags                --json 单行 JSON',
  '  note                 除 on/off 外写入仍在 Desktop 面板；命令层其余只读',
]

/** 纯函数入口。scenes 读目录，所以整体异步。 */
export async function runMemoryCommand(rawInput: string, deps: MemoryCommandDeps): Promise<CommandResult> {
  const { argv, json, limit, last, session } = parse(rawInput)
  const sub = (argv[0] ?? 'status').toLowerCase()

  const wrap = (result: CommandResult, data: unknown): CommandResult => {
    if (!json) return result
    const body = result.kind === 'error'
      ? { ok: false, cmd: 'memory', error: { message: result.text.split('\n')[0] ?? result.text } }
      : { ok: true, cmd: 'memory', data }
    return { kind: result.kind, text: JSON.stringify(body) }
  }

  if (sub === 'help' || sub === '?') return wrap(ok(HELP), { help: true })

  if (sub === 'status') {
    const status = deps.status()
    const lines = [
      `memory — L1 ${status.l1} 条  L0 ${status.l0} 条  回执 ${status.receipts}  待裁决 ${status.conflicts}`,
      `  db         ${status.dbPath}`,
      `  dims       ${status.dims}`,
      '  use        /memory records  ·  /memory conflicts',
    ]
    if (status.error) lines.push(`  warning    ${clip(status.error, 70)}`)
    return wrap(ok(lines), status)
  }

  if (sub === 'records') {
    const rows = deps.records(limit)
    if (rows.length === 0) return wrap(ok(['memory records — 还没有 L1 原子记忆']), { rows: 0 })
    const lines = [`memory records — 最近 ${rows.length} 条`]
    for (const row of rows) {
      const meta = [row.type, row.family, row.scene_name].filter(Boolean).join('/')
      lines.push(`  ${clip(String(row.updated_time ?? ''), 16)}  ${clip(meta || '—', 18)}  ${clip(String(row.content ?? ''), 52)}`)
    }
    return wrap(ok(lines), { rows })
  }

  if (sub === 'conflicts') {
    const rows = deps.conflicts(limit)
    if (rows.length === 0) return wrap(ok(['memory conflicts — 没有待裁决冲突']), { rows: 0 })
    const lines = [`memory conflicts — ${rows.length} 条待裁决`]
    for (const row of rows) {
      lines.push(`  ${clip(String(row.record_id ?? ''), 12)}  ${clip(String(row.content ?? ''), 70)}`)
    }
    return wrap(ok(lines), { rows })
  }

  if (sub === 'rooms') {
    const rooms = deps.rooms()
    if (rooms.length === 0) return wrap(ok(['memory rooms — 注册表为空', '  next 在 Desktop 面板里预注册或让标注器自生长']), { rooms: 0 })
    const active = rooms.filter((room) => room.status !== 'retired')
    const lines = [`memory rooms — ${active.length} 个活跃 / ${rooms.length} 总数`]
    for (const room of active.slice(0, 20)) {
      lines.push(`  ${clip(room.slug, 34).padEnd(34)}  ${clip(room.label ?? '', 30)}`)
    }
    if (active.length > 20) lines.push(`  … 还有 ${active.length - 20} 个`)
    return wrap(ok(lines), { total: rooms.length, active: active.length, rooms: active.slice(0, 20) })
  }

  if (sub === 'scenes') {
    const scenes = await deps.scenes()
    const lines = [
      `memory scenes — chat ${scenes.chat} 个文件  work ${scenes.work} 个文件`,
      ...scenes.sample.slice(0, 10).map((name) => `  ${clip(name, 70)}`),
    ]
    if (scenes.sample.length === 0) lines.push('  （尚无 L2 场景块）')
    return wrap(ok(lines), scenes)
  }

  if (sub === 'ext') {
    const ext = deps.ext()
    const lines = [
      `memory ext — ${ext.enabled ? '已启用' : '未启用'}  sync=${ext.syncMode}`,
      `  drivers    ${ext.drivers.length === 0 ? '(无)' : ext.drivers.join(', ')}`,
      '  note       配置是事实源；改驱动走 Desktop 设置页',
    ]
    return wrap(ok(lines), ext)
  }

  if (sub === 'switch') {
    const sw = deps.switches()
    const lock = (name: string, on: boolean, ceil: boolean) => `${name}=${on}${!ceil ? '(部署停用)' : ''}`
    const lines = [
      `memory switch — 注入 recall=${sw.recall}(启动=${sw.injectBootMode})  提取 capture=${sw.capture}/distill=${sw.distill}(启动=${sw.extractBootMode})`,
      `  ${lock('捕获', sw.capture, sw.ceilings.capture)}  ${lock('蒸馏', sw.distill, sw.ceilings.distill)}  ${lock('召回', sw.recall, sw.ceilings.recall)}`,
      `  高权限写删=${sw.memoryMutate}`,
      '  use        /memory on|off --yes  拨总闸',
    ]
    return wrap(ok(lines), sw)
  }

  if (sub === 'on' || sub === 'off') {
    const want = sub === 'on'
    const yes = /(^|\s)--yes(\s|$)/.test(String(rawInput ?? ''))
    if (!yes) {
      return wrap(ok([
        `memory ${sub} — dry run（未写入）`,
        `  would     将总闸 enabled 置为 ${want}`,
        '  next      加 --yes 才真写（影响捕获/蒸馏/召回注入）',
      ]), { dry: true, willSet: want })
    }
    const res = await deps.setEnabled(want)
    const lines = [
      `memory ${sub} — ${res.applied ? '已写入' : '写入失败'}`,
      `  effective  enabled=${res.effective}`,
      res.drift ? '  warning    写后回读不一致（可能被宿主剪枝），重启可能回落' : '  persisted  回读一致',
    ]
    const result: CommandResult = res.applied && !res.drift
      ? { kind: 'success', text: renderLines(lines) }
      : { kind: 'error', text: renderLines(lines) }
    return wrap(result, { ...res })
  }

  if (sub === 'injected') {
    let sid = session
    if (!sid) {
      if (!last) {
        const recent = deps.recentSessions()
        if (recent.length === 0) return wrap(ok(['memory injected — 近期无注入记录', '  next 在有记忆的会话里对话后再试，或 --session=<id>']), { sessions: 0 })
        return wrap(ok([
          'memory injected — 需指定会话：--last 取最近一个，或 --session=<id>',
          ...recent.slice(0, 8).map((s) => `  ${new Date(s.at).toISOString().slice(0, 19).replace('T', ' ')}  ${s.count} 条  ${clip(s.key, 40)}`),
        ]), { hint: true, recent: recent.slice(0, 8) })
      }
      const recent = deps.recentSessions()
      if (recent.length === 0) return wrap(ok(['memory injected — 近期无任何会话有注入记录']), { rows: 0 })
      sid = recent[0]!.key
    }
    const rows = deps.recalled(sid, limit)
    if (rows.length === 0) return wrap(ok([`memory injected — 会话 ${clip(sid, 32)} 无已注入记忆`]), { sessionId: sid, rows: 0 })
    const lines = [`memory injected — 会话 ${clip(sid, 36)}  共 ${rows.length} 条`]
    for (const r of rows) {
      const meta = [r.type, r.family, r.scene_name].filter(Boolean).join('/')
      const flags = `${r.superseded ? ' [已取代]' : ''}${r.lane ? ` (${r.lane})` : ''}`
      lines.push(`  ${clip(meta || '—', 18)}  ${clip(String(r.content ?? ''), 48)}${flags}`)
    }
    return wrap(ok(lines), { sessionId: sid, rows })
  }

  if (sub === 'rebuild') {
    const status = deps.status()
    const yes = /(^|\s)--yes(\s|$)/.test(String(rawInput ?? ''))
    const lines = [
      `memory rebuild — dry run（不会写库）`,
      `  would     重蒸馏 L1 ${status.l1} 条 / L0 ${status.l0} 条`,
      `  db        ${status.dbPath}`,
    ]
    if (yes) {
      lines.push('  blocked   命令层不提供写入：重蒸馏会改写记忆库，只能在 Desktop 面板里手动触发')
      return wrap({ kind: 'error', text: renderLines(lines) }, status)
    }
    lines.push('  next      确认影响后在 Desktop 面板点“重建”；命令只做影响面预估')
    return wrap(ok(lines), { dry: true, ...status })
  }

  return wrap(fail(`memory: 未知子命令 "${sub}"`, 'next: /memory help'), {})
}

/** 注册 `/memory`：无 commands 服务时静默跳过（老线安全）。 */
export function registerMemoryCommand(ctx: Context, deps: MemoryCommandDeps): void {
  const registry = (ctx as unknown as { commands?: { register(definition: unknown): unknown } }).commands
  if (!registry || typeof registry.register !== 'function') return
  registry.register({
    definitionId: 'dsh-prime-memory',
    name: 'memory',
    description: 'Prime-memory console: layer counts / recent L1 records / pending conflicts (read-only)',
    input: { hint: '[status|records|conflicts|rooms|scenes|ext|rebuild] [--n=20] [--all] [--json]' },
    handler: (invocation: { rawInput?: string }) => runMemoryCommand(invocation?.rawInput ?? '', deps),
  })
}
