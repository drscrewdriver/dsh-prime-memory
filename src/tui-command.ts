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

function parse(rawInput: string): { argv: string[]; json: boolean; all: boolean; limit: number } {
  const argv: string[] = []
  let json = false
  let all = false
  let limit = 10
  for (const token of String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)) {
    if (token === '--json') json = true
    else if (token === '--all') all = true
    else if (/^--n=\d+$/.test(token)) limit = Math.min(40, Math.max(1, Number(token.slice(4))))
    else if (!token.startsWith('--')) argv.push(token)
  }
  return { argv, json, all, limit: all ? 40 : limit }
}

const HELP = [
  'memory — 分层蒸馏记忆（L0/L1/L2/L3）的只读终端面',
  '  /memory              库状态与各层计数',
  '  /memory records      最近 10 条 L1（--n=20 / --all 调数量）',
  '  /memory conflicts    待裁决冲突',
  '  /memory rooms        Room 注册表（major / major-minor）',
  '  /memory scenes       场景文件计数（chat / work 分族）',
  '  /memory ext          外部记忆驱动与同步模式',
  '  /memory rebuild      dry run：预估重蒸馏影响面（不写库）',
  '  flags                --json 单行 JSON',
  '  note                 蒸馏/重建等写操作仍在 Desktop 面板；命令层只读',
]

/** 纯函数入口。scenes 读目录，所以整体异步。 */
export async function runMemoryCommand(rawInput: string, deps: MemoryCommandDeps): Promise<CommandResult> {
  const { argv, json, limit } = parse(rawInput)
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
