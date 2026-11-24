/**
 * 「中文常量裸引用」守卫 —— 补 `locale-guard` 的盲区。
 *
 * 为什么还要一条：既有棘轮盯的是**源码里直接写死的中文字面量**，而本仓的文案组织是
 * `key = 中文原文`，于是漏出一类它抓不到的漏网之鱼 —— 中文好好躺在字典里，
 * 渲染点却**绕开 `tr()` 直接取常量 / 表值**：
 *
 * - `label={GRAPH_TOOL_LABEL}` → 切到 en 仍显示「图谱读工具」；
 * - `tr("{p1}投影", { p1: GRAPH_FEATURE_LABEL })` → 插值进去的是中文原文，en 下拼出
 *   「知识图谱 projection」这种半中半英串台。
 *
 * 这类写法不新增硬编码字面量，棘轮数字不动、守卫全绿，用户却看到串台。所以本测试盯
 * **引用姿势**：
 *
 * R1 —— 值为中文的标量 `const`，只允许出现在 `tr(...)` 参数子树内；
 * R2 —— 值含中文的表量（`Record` / 数组），在**展示位**（JSX 表达式与属性、
 *       `label/title/desc/hint/text/placeholder/caption` 属性值、`tr` 的插值实参）
 *       读取其中文属性 / 元素时必须包 `tr(...)`。
 *
 * 表量的非文案用法（`MODES[i].key === k`、`TABS.map(...)`、配色、座位名）一律不管，
 * 否则守卫会被逻辑代码淹掉。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { describe, expect, test } from 'vitest'
import ts from 'typescript'

const SRC = join(process.cwd(), 'client/src')
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/
/** 展示位属性名（取出来直接进 DOM / tooltip）。 */
const DISPLAY_PROPS = new Set(['label', 'title', 'desc', 'hint', 'text', 'placeholder', 'caption'])
/** R1 的既认例外：表内标签由消费点统一 `tr(l[1])` 兜住，裸放于表里不构成漏网。 */
const ALLOW = new Set(['client/src/tabs/BudgetInputs.tsx:GRAPH_BUDGET_LABEL'])

const files: string[] = []
;(function walk(d: string): void {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) {
      if (e !== 'locales') walk(p)
      continue
    }
    if (['.ts', '.tsx'].includes(extname(p))) files.push(p)
  }
})(SRC)

const rel = (p: string): string => relative(process.cwd(), p).replace(/\\/g, '/')

/** 节点子树里是否存在含中文的字符串/模板字面量（注释里的中文不算文案）。 */
function literalHasCJK(sf: ts.SourceFile, node: ts.Node): boolean {
  let hit = false
  const scan = (n: ts.Node): void => {
    if (hit) return
    if (ts.isStringLiteralLike(n)) {
      if (CJK.test(n.text)) hit = true
      return
    }
    if (ts.isTemplateLiteral(n)) {
      if (CJK.test(n.getText(sf))) hit = true
      return
    }
    n.forEachChild(scan)
  }
  scan(node)
  return hit
}

interface Findings {
  stringConsts: Set<string>
  /** 表量名 → 其值含中文的属性名集合；数组元素本身是中文串时记 `*`。 */
  tableProps: Map<string, Set<string>>
  bareString: string[]
  bareTable: string[]
}

function collect(): Findings {
  const stringConsts = new Set<string>()
  const tableProps = new Map<string, Set<string>>()

  // ── pass 1：谁装着中文 ──
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = n.initializer
        if (ts.isStringLiteralLike(init) && CJK.test(init.text)) {
          stringConsts.add(n.name.text)
        } else if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
          const props = new Set<string>()
          const members = ts.isObjectLiteralExpression(init) ? init.properties : init.elements
          for (const m of members) {
            if (ts.isPropertyAssignment(m) && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
              if (literalHasCJK(sf, m.initializer)) props.add(m.name.text)
            } else if (ts.isObjectLiteralExpression(m)) {
              for (const p of m.properties) {
                if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && literalHasCJK(sf, p.initializer)) props.add(p.name.text)
              }
            } else if (literalHasCJK(sf, m)) {
              props.add('*')
            }
          }
          if (props.size > 0) tableProps.set(n.name.text, props)
        }
      }
      n.forEachChild(visit)
    }
    visit(sf)
  }

  const bareString: string[] = []
  const bareTable: string[] = []

  // ── pass 2：引用姿势 ──
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
    const at = (n: ts.Node): string => {
      const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart())
      return `${rel(f)}:${line + 1}:${character + 1}`
    }
    /** 是否落在某个 `tr(...)` 调用的参数子树内。 */
    const insideTrArgs = (n: ts.Node): boolean => {
      let cur: ts.Node | undefined = n.parent
      let child: ts.Node = n
      while (cur) {
        if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && cur.expression.text === 'tr'
          && cur.arguments.some((a) => a === child)) return true
        child = cur
        cur = cur.parent
      }
      return false
    }
    /** 是否处在展示位。 */
    const inDisplaySite = (n: ts.Node): boolean => {
      let cur: ts.Node | undefined = n.parent
      let depth = 0
      while (cur && depth++ < 7) {
        if (ts.isJsxExpression(cur) || ts.isJsxAttribute(cur)) return true
        if (ts.isPropertyAssignment(cur) && ts.isIdentifier(cur.name) && DISPLAY_PROPS.has(cur.name.text)) return true
        if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && cur.expression.text === 'tr') return true
        cur = cur.parent
      }
      return false
    }

    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const name = n.text
        const parent = n.parent
        const isDecl = parent !== undefined && ts.isVariableDeclaration(parent) && parent.name === n
        const isImport = parent !== undefined && (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))
        const isPropName = parent !== undefined && ts.isPropertyAssignment(parent) && parent.name === n
        const isMemberName = parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === n
        if (!isDecl && !isImport && !isPropName && !isMemberName && !insideTrArgs(n)) {
          if (stringConsts.has(name) && !ALLOW.has(`${rel(f)}:${name}`)) {
            bareString.push(`${at(n)}  ${name}`)
          } else if (tableProps.has(name) && inDisplaySite(n)) {
            const props = tableProps.get(name)!
            // 只盯"取文案"的读法：NAME[...] 或 NAME.中文属性
            const readsValue =
              (parent !== undefined && ts.isElementAccessExpression(parent) && parent.expression === n) ||
              (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === n && props.has(parent.name.text))
            // NAME[...] 之后立刻接一个非中文属性（MODES[i].key）属于逻辑读法
            const gp = parent?.parent
            const thenLogic = parent !== undefined && ts.isElementAccessExpression(parent) && gp !== undefined &&
              ts.isPropertyAccessExpression(gp) && !props.has(gp.name.text) && !props.has('*')
            if (readsValue && !thenLogic) bareTable.push(`${at(n)}  ${name}`)
          }
        }
      }
      n.forEachChild(visit)
    }
    visit(sf)
  }
  return { stringConsts, tableProps, bareString, bareTable }
}

describe('中文常量裸引用守卫 (bare-reference)', () => {
  test('值为中文的标量常量只能在 tr(...) 内被引用', () => {
    const r = collect()
    if (r.bareString.length > 0) {
      throw new Error(`${r.stringConsts.size} 个中文标量常量里有 ${r.bareString.length} 处绕开 tr() 直接引用（切语言必串台，请包 tr()）：\n${r.bareString.map((s) => `  ${s}`).join('\n')}`)
    }
    expect(r.bareString).toEqual([])
  })

  test('中文表量在展示位取文案必须经 tr(...)', () => {
    const r = collect()
    if (r.bareTable.length > 0) {
      throw new Error(`${r.tableProps.size} 个中文表量在展示位有 ${r.bareTable.length} 处未经 tr()：\n${r.bareTable.map((s) => `  ${s}`).join('\n')}`)
    }
    expect(r.bareTable).toEqual([])
  })
})
