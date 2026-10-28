/**
 * 技能结晶的生产者（issue #15 的缺失环节）。
 *
 * **为什么需要这个文件**：`crystallize.detectCandidates` 自 0.26.x 起就存在，但全仓
 * 只有测试调用它，`SkillStore.create()` 同样零生产调用点 ⇒ `skills.json` 永远不会被
 * 写入，看板恒为 0。本文件补的就是生产者。
 *
 * **两条路径，一套语义**：
 * - `ingestRound`（稳态）：挂 `runner.runTurn` 的 L2 攒批轮次之后，吃本轮新记录 +
 *   本轮 sessionId。0 全表扫描、0 IO 读、0 LLM。
 * - `backfill`（一次性）：分页扫历史记录，从 `metadata.dsh_source_anchors` 复原会话
 *   归属，让装了很久的老库不必再跨 N 个会话才见第一条技能。
 * 两者共用 `crystallize` 的 `groupKey`/`fnv1a`，保证同一组在两条路径算出**同一个**
 * 候选 id（否则会出现两个重复候选，幂等崩）。
 *
 * **三条不可让步的纪律**：
 * 1. 必须投 `evidence`——`SkillStore.sessionCount` 只数 evidence 行、不看
 *    `Skill.evidenceRecordIds`；只 create 不 appendEvidence 的话，技能永远停在
 *    candidate 且 distinct-session 恒 0，**即使 allowPromote 打开也永不晋升**。
 * 2. 只覆盖 `steps`，绝不传 `body`——`body` 是人编辑区（`skill-store.ts` 头部分列
 *    不变量），机器侧只能重写 checklist 步骤。
 * 3. 不调 `getAllL1()`/`l1.all()`——那两个方法一次性全量同步反序列化含正文，
 *    在事件循环里会阻塞所有 RPC（`sqlite.ts` 里 `getAllL1Lite` 的存在理由注释已写明）。
 *
 * **候选首见即建，但不注入**：`appendEvidence` 要求技能已存在，所以无法"攒够阈再建"；
 * 而 `status:'candidate'` 本身不进召回（`skill-recall` 只注入 active），因此早期建
 * 候选没有注意力税。"是否达阈"由面板按 sessionCount/minSessions 如实显示。
 */
import type { MemoryConfig } from '../config.js'
import { ANCHOR_METADATA_KEY } from '../pipeline/anchors.js'
import type { L1Store } from '../store/l1.js'
import type { SkillEvidence, SkillStore } from '../store/skill-store.js'
import type { ConversationAnchor, MemoryLogger, MemoryRecord } from '../types.js'
import { fnv1a, groupKey, type MethodRecord } from './crystallize.js'

/** L1 词表里的「工作方法」类型字面量（技能只从这一类派生，不新增类型）。 */
const WORK_METHOD_TYPE = 'work_method'

/** 证据行的来源标记：区分蒸馏轮次投的与人工补的。 */
const EVIDENCE_KIND = 'distill'

/** backfill 分页大小与扫描上限：大库必须可截断，不许无界扫。 */
const BACKFILL_PAGE = 500
const BACKFILL_MAX_RECORDS = 20_000

/** 单候选最多收录的步骤数与证据 id 数（与 crystallize 的默认口径一致）。 */
const MAX_STEPS = 20
const EVIDENCE_IDS_CAP = 200

/** 候选 body 的首段截取长度（steps[0] 的摘要，人可后续编辑）。 */
const BODY_LEAD_CHARS = 200

type SkillsConfig = MemoryConfig['skills']

/** 一次投递的账目。`errors` 只收要人看的失败原因，不抛穿调用方。 */
export interface SkillIngestSummary {
  /** 入参记录总数（含被过滤掉的其它类型）。 */
  scanned: number
  /** 其中 work_method 且正文非空的条数。 */
  methods: number
  /** 本轮触及的候选数。 */
  candidatesTouched: number
  created: number
  /** 新投的证据条数（去重后）。 */
  appended: number
  promoted: number
  /** backfill 专用：因缺锚点而跳过的记录数（增量路径恒 0）。 */
  skippedNoAnchor: number
  /** 是否因技能数达上限而提前停止。 */
  stoppedAtCap: boolean
  errors: string[]
}

export interface SkillBackfillSummary extends SkillIngestSummary {
  /** 实际翻页次数（可观测：判断大库回灌成本）。 */
  pages: number
  /** 是否因扫描上限被截断。 */
  truncated: boolean
}

/** 生产者健康态：面板三态判定与 `skills-list` 透出的数据源。 */
export interface SkillProducerStatus {
  /** 本版起恒为 true；保留该字段是为了让面板能区分"有生产者"与旧版空盒子。 */
  wired: true
  lastRoundAt?: string
  backfilledAt?: string
}

export interface SkillProducer {
  /** 稳态入口：本轮新记录 + 本轮 sessionId。 */
  ingestRound(records: readonly MemoryRecord[], sessionId: string, runId: string): Promise<SkillIngestSummary>
  /** 一次性历史回灌（面板「立即检测历史」按钮与 `skills-detect` RPC 的落点）。 */
  backfill(opts?: { maxRecords?: number; page?: number }): Promise<SkillBackfillSummary>
  status(): SkillProducerStatus
}

/** 一个 (hall, scene) 组在本轮看到的所有方法视图。 */
interface MethodGroup {
  key: string
  /** 确定性候选 id。 */
  id: string
  hall?: string
  sceneName?: string
  views: MethodRecord[]
}

/**
 * 把 L1 记录归一成检测用的视图：`hall` 住在 `metadata.hall`（Wings 关时缺省 ⇒
 * groupKey 回落 'general'），`scene_name` 是 snake_case 列，`sessionId` 由调用方注入
 * （**记录本身不存 sessionId**，这是本文件存在的关键约束之一）。
 */
function toViews(records: readonly MemoryRecord[], sessionId: string): MethodRecord[] {
  const out: MethodRecord[] = []
  for (const r of records) {
    if (!r || r.type !== WORK_METHOD_TYPE) continue
    if (typeof r.content !== 'string' || r.content.trim() === '') continue
    const hall = typeof r.metadata?.['hall'] === 'string' ? (r.metadata['hall'] as string) : undefined
    out.push({ id: r.id, content: r.content, sessionId, hall, sceneName: r.scene_name })
  }
  return out
}

/**
 * 从锚点展开一条历史记录到「每会话一条视图」。
 *
 * 无锚点或锚点里 sessionId 全空 ⇒ 返回空数组（调用方计入 `skippedNoAnchor`）。
 * **绝不回落成 `'default'`**：伪造的会话归属会虚增 distinct-session，直接骗过晋升门。
 */
function viewsFromAnchors(r: MemoryRecord): { views: MethodRecord[]; sessions: number } {
  if (!r || r.type !== WORK_METHOD_TYPE) return { views: [], sessions: 0 }
  if (typeof r.content !== 'string' || r.content.trim() === '') return { views: [], sessions: 0 }
  const raw = r.metadata?.[ANCHOR_METADATA_KEY]
  if (!Array.isArray(raw)) return { views: [], sessions: 0 }
  const hall = typeof r.metadata?.['hall'] === 'string' ? (r.metadata['hall'] as string) : undefined
  const seen = new Set<string>()
  const views: MethodRecord[] = []
  for (const a of raw as readonly ConversationAnchor[]) {
    const sid = typeof a?.sessionId === 'string' ? a.sessionId.trim() : ''
    if (sid === '' || seen.has(sid)) continue
    seen.add(sid)
    views.push({ id: r.id, content: r.content, sessionId: sid, hall, sceneName: r.scene_name })
  }
  return { views, sessions: seen.size }
}

function buildGroups(views: readonly MethodRecord[]): MethodGroup[] {
  const m = new Map<string, MethodGroup>()
  for (const v of views) {
    const key = groupKey(v)
    const g = m.get(key)
    if (g) g.views.push(v)
    else m.set(key, { key, id: 'skx-' + fnv1a(key), hall: v.hall, sceneName: v.sceneName, views: [v] })
  }
  // 按 key 排序：与 detectCandidates 同口径，让日志与快照可复现。
  return [...m.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 归一化去重步骤（空白折叠 + 小写比较，保留首次出现顺序）。 */
function dedupe(views: readonly MethodRecord[]): { steps: string[]; recordIds: string[] } {
  const seen = new Set<string>()
  const steps: string[] = []
  const recordIds: string[] = []
  for (const v of views) {
    const norm = v.content.replace(/\s+/g, ' ').trim()
    if (norm === '') continue
    const probe = norm.toLowerCase()
    if (seen.has(probe)) continue
    seen.add(probe)
    if (steps.length < MAX_STEPS) steps.push(norm)
    if (recordIds.length < EVIDENCE_IDS_CAP && !recordIds.includes(v.id)) recordIds.push(v.id)
  }
  return { steps, recordIds }
}

/** 候选标题：与 detectCandidates 的 label 公式逐字一致（两处漂移会让同一组显示两个名字）。 */
function titleOf(g: MethodGroup): string {
  const label = g.hall && g.hall !== 'general' ? `${g.hall} 流程` : g.sceneName ? `${g.sceneName} 流程` : '通用流程'
  return `技能：${label}`
}

/** 两个 steps 数组逐字相等（用于跳过无变化的重写）。 */
function sameSteps(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export interface SkillProducerDeps {
  skills: SkillStore
  l1: L1Store
  /** 函数式取配置：面板改阈值后下一轮即生效，不必重启。 */
  cfg: () => SkillsConfig
  logger?: MemoryLogger
}

/**
 * 建一个技能生产者。
 *
 * 所有失败都在内部消化成 `summary.errors` + warn 日志，**不抛穿调用方**——
 * 蒸馏轮次不该因为技能结晶失败而丢记忆。
 */
export function createSkillProducer(deps: SkillProducerDeps): SkillProducer {
  const { skills, l1, logger } = deps
  let lastRoundAt: string | undefined
  let backfilledAt: string | undefined

  /** 空账目（开关关时直接返回，全程零动作）。 */
  const emptySummary = (): SkillIngestSummary => ({
    scanned: 0,
    methods: 0,
    candidatesTouched: 0,
    created: 0,
    appended: 0,
    promoted: 0,
    skippedNoAnchor: 0,
    stoppedAtCap: false,
    errors: [],
  })

  /**
   * 把一组视图落成「一个候选 + 若干证据」。
   *
   * 写入节奏（真机量测后调整）：本函数**不逐条落盘**——证据先攒进 `pending`
   * 由调用方整批一次写，steps 只在真变化时才 `update`。否则一轮空跑也会把
   * sidecar 全量重写几百次（`rev` 跳涨就是这么被发现的）。
   * 返回 false 表示应当中止外层循环（达 SKILLS_CAP）。
   */
  const absorbGroup = async (
    g: MethodGroup, runId: string, s: SkillIngestSummary,
    pending: SkillEvidence[], seen: Set<string>, touched: string[], at: string,
  ): Promise<boolean> => {
    const { steps, recordIds } = dedupe(g.views)
    if (steps.length === 0) return true

    const existing = skills.get(g.id)
    if (existing === undefined) {
      try {
        await skills.create({
          id: g.id,
          title: titleOf(g),
          body: (steps[0] ?? '').slice(0, BODY_LEAD_CHARS),
          steps,
          trigger: { hall: g.hall, sceneName: g.sceneName },
          status: 'candidate',
          family: 'work',
          evidenceRecordIds: recordIds,
        })
        s.created += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('上限')) {
          s.stoppedAtCap = true
          s.errors.push('技能数已达上限，本轮停止结晶（可在面板归档部分技能）')
          logger?.warn('[memory] 技能结晶停止：技能数已达上限')
          return false
        }
        if (!msg.includes('已存在')) {
          s.errors.push(`建候选失败: ${msg}`)
          logger?.warn(`[memory] 技能候选创建失败(${g.id}): ${msg}`)
          return true
        }
        // 并发下另一轮刚建好：重新取一次，当作已存在继续走证据路径
        const again = skills.get(g.id)
        if (again && !sameSteps(again.steps, steps)) await skills.update(g.id, { steps })
      }
    } else if (!sameSteps(existing.steps, steps)) {
      // 机器侧只重写 steps；body 是人编辑区，传进去就破坏了分列不变量。
      try {
        await skills.update(g.id, { steps })
      } catch (err) {
        s.errors.push(`更新步骤失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    s.candidatesTouched += 1
    touched.push(g.id)

    // 证据：sessionCount 的唯一来源。三元组去重（含本批内去重），重复轮次不重复投。
    for (const v of g.views) {
      if (v.sessionId === '') continue
      const key = `${g.id}\u0000${v.sessionId}\u0000${v.id}`
      if (seen.has(key) || skills.hasEvidence(g.id, v.sessionId, v.id)) continue
      seen.add(key)
      pending.push({ skillId: g.id, runId, recordId: v.id, sessionId: v.sessionId, at, kind: EVIDENCE_KIND })
    }
    return true
  }

  const drainGroups = async (groups: readonly MethodGroup[], runId: string, cfg: SkillsConfig, s: SkillIngestSummary): Promise<void> => {
    const pending: SkillEvidence[] = []
    const seen = new Set<string>()
    const touched: string[] = []
    const at = new Date().toISOString()
    for (const g of groups) {
      if (!(await absorbGroup(g, runId, s, pending, seen, touched, at))) return
    }

    // 整批一次落盘；晋升必须在证据落盘后判，否则 sessionCount 看不到本轮新会话。
    if (pending.length > 0) s.appended = await skills.appendEvidenceBatch(pending)
    if (!cfg.allowPromote) return
    for (const id of touched) {
      if (skills.sessionCount(id) >= cfg.minSessions && skills.evidenceCount(id) >= cfg.minEvidence) {
        if (await skills.tryPromote(id, cfg.minSessions, { allowPromote: true })) s.promoted += 1
      }
    }
  }

  return {
    async ingestRound(records, sessionId, runId) {
      const s = emptySummary()
      const cfg = deps.cfg()
      s.scanned = records.length
      if (!cfg.enabled || records.length === 0) return s

      const views = toViews(records, sessionId)
      s.methods = views.length
      if (views.length === 0) return s

      try {
        await drainGroups(buildGroups(views), runId, cfg, s)
        lastRoundAt = new Date().toISOString()
      } catch (err) {
        s.errors.push(err instanceof Error ? err.message : String(err))
      }

      if (s.candidatesTouched > 0 || s.created > 0) {
        logger?.info(
          `[memory] 技能结晶：触及 ${s.candidatesTouched} 候选（新建 ${s.created}、证据 +${s.appended}${s.promoted > 0 ? `、晋升 ${s.promoted}` : ''}）`,
        )
      }
      return s
    },

    async backfill(opts) {
      const s: SkillBackfillSummary = { ...emptySummary(), pages: 0, truncated: false }
      const cfg = deps.cfg()
      if (!cfg.enabled) return s
      const page = opts?.page !== undefined && opts.page > 0 ? opts.page : BACKFILL_PAGE
      const maxRecords = opts?.maxRecords !== undefined && opts.maxRecords > 0 ? opts.maxRecords : BACKFILL_MAX_RECORDS

      // 累积全部会话的视图后一次性分组：跨页分裂的同组记录必须合成一个候选，
      // 所以不能在页内直接落库。上限由 maxRecords 兜住，内存里只放视图引用。
      const views: MethodRecord[] = []
      try {
        for (let offset = 0; ; offset += page) {
          const lite = l1.allLite(page, offset)
          s.pages += 1
          if (lite.length === 0) break
          s.scanned += lite.length
          const ids = lite.filter((r) => r.type === WORK_METHOD_TYPE).map((r) => r.id)
          if (ids.length > 0) {
            for (const r of l1.getByIds(ids)) {
              const { views: vs } = viewsFromAnchors(r)
              if (vs.length === 0) {
                if (r.content.trim() !== '' && r.type === WORK_METHOD_TYPE) s.skippedNoAnchor += 1
                continue
              }
              views.push(...vs)
            }
          }
          if (s.scanned >= maxRecords) {
            s.truncated = true
            break
          }
          // 让出事件循环：大库回灌期间面板 RPC 不能被独占（对齐 allLite 的存在理由）。
          await new Promise((resolve) => setImmediate(resolve))
        }

        s.methods = new Set(views.map((v) => v.id)).size
        await drainGroups(buildGroups(views), `backfill-${Date.now().toString(36)}`, cfg, s)
        backfilledAt = new Date().toISOString()
      } catch (err) {
        s.errors.push(err instanceof Error ? err.message : String(err))
        logger?.warn(`[memory] 技能历史回灌失败: ${err instanceof Error ? err.message : String(err)}`)
      }

      logger?.info(
        `[memory] 技能历史回灌：扫 ${s.scanned} 条记录（${s.pages} 页${s.truncated ? '，达上限截断' : ''}）→ 触及 ${s.candidatesTouched} 候选（新建 ${s.created}、证据 +${s.appended}${s.skippedNoAnchor > 0 ? `、${s.skippedNoAnchor} 条缺锚点跳过` : ''}）`,
      )
      return s
    },

    status() {
      return { wired: true, ...(lastRoundAt === undefined ? {} : { lastRoundAt }), ...(backfilledAt === undefined ? {} : { backfilledAt }) }
    },
  }
}
