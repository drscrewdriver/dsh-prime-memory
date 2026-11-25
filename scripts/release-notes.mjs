/**
 * release-notes.mjs —— 生成 GitHub Release 正文（CI 与本地共用，零依赖）。
 *
 * 为什么不用 gh release --generate-notes：GitHub 自动正文只列 commit 标题，
 * 与 release-coverage.mjs 的空壳判据（历史版本补录 / No CHANGELOG section found）
 * 及 19 包线标签停版的旧史对不上；口径必须与 release-backfill.mjs 一致。
 *
 * 优先级：P0 RELEASE-NOTES-v<ver>.md > P1 CHANGELOG 版本节 > P2 tag 提交信息 > P3 兜底
 * 退出码：0 正常；2 tag 在本地不存在（CI 应红）；1 正文不足 MIN_BODY
 * 无 shebang：本仓 lint 的 file-header 规则要求文件首字符是 /**，且调用方一律 node 显式执行。
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const MIN_BODY = 80
// 与 release-coverage.mjs / release-backfill.mjs 判空壳的标记保持一致
const STUB_MARKS = ['历史版本补录', 'No CHANGELOG section found']

export function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '').replace(/-(local|beta|alpha|rc)\.\d+$/i, '')
}

export function extractChangelogSection(text, version) {
  const want = normalizeVersion(version)
  if (!text || !want) return { found: false, heading: null, body: '' }
  const lines = text.split(/\r?\n/)
  const esc = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headRe = new RegExp('^##\\s*\\[?v?' + esc + '(?![\\d.])')
  let start = -1
  for (let i = 0; i < lines.length; i++) if (headRe.test(lines[i])) { start = i; break }
  if (start < 0) return { found: false, heading: null, body: '' }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break }
  return { found: true, heading: lines[start].trim(), body: lines.slice(start + 1, end).join('\n').trim() }
}

function git(cwd, fmt, ref) {
  try {
    return execFileSync('git', ['log', '-1', '--format=' + fmt, ref], { cwd, encoding: 'utf8' }).trim()
  } catch { return null }
}

export function buildNotes({ cwd = '.', version, tag }) {
  const ver = normalizeVersion(version)
  const isClean = (s) => s.length >= MIN_BODY && !STUB_MARKS.some((m) => s.includes(m))

  const p0 = `${cwd}/RELEASE-NOTES-v${ver}.md`
  if (existsSync(p0)) {
    const s = readFileSync(p0, 'utf8').trim()
    if (isClean(s)) return { body: s, level: 'P0', source: p0 }
  }

  const cl = `${cwd}/CHANGELOG.md`
  if (existsSync(cl)) {
    const sec = extractChangelogSection(readFileSync(cl, 'utf8'), ver)
    if (sec.found && isClean(sec.body)) {
      return { body: `## ${ver}\n\n${sec.body}`, level: 'P1', source: 'CHANGELOG.md: ' + sec.heading }
    }
  }

  const msg = git(cwd, '%B', tag)
  if (msg === null) return { error: 'TAG_NOT_FOUND', body: '' }
  if (isClean(msg)) return { body: `## ${ver}\n\n${msg}`, level: 'P2', source: 'git log ' + tag }

  const subject = (git(cwd, '%s', tag) || msg.split('\n')[0] || '').trim()
  const date = git(cwd, '%cs', tag) || ''
  const parts = [`## ${ver}`]
  if (subject) parts.push('', subject)
  if (date) parts.push('', `_tag 日期：${date}_`)
  parts.push('', '_正文源：tag 提交信息（该版本无 CHANGELOG 条目）_')
  return { body: parts.join('\n').trim(), level: 'P3', source: 'git log subject' }
}

// ── CLI ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const version = arg('--version', process.env.VERSION)
const tag = arg('--tag', version ? 'v' + normalizeVersion(version) : '')
const out = arg('--out', '')
const cwd = arg('--cwd', '.')

if (!version) { console.error('用法: node release-notes.mjs --version <x.y.z> [--tag v<x>] [--out notes.md]'); process.exit(1) }

const r = buildNotes({ cwd, version, tag })
if (r.error === 'TAG_NOT_FOUND') { console.error(`[release-notes] tag 不存在: ${tag}`); process.exit(2) }
if ((r.body || '').length < MIN_BODY) { console.error('[release-notes] 正文不足 ' + MIN_BODY + ' 字符，拒绝写入'); process.exit(1) }

if (out) { writeFileSync(out, r.body + '\n', 'utf8'); console.error(`[release-notes] ${r.level} -> ${out} (${r.body.length} 字符, 源: ${r.source})`) }
else process.stdout.write(r.body + '\n')
