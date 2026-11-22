import { tr } from '../i18n.js';
/**
 * 驱动配置面板的行为判据(计划 ext-driver-config-ui Phase 3)。
 *
 * 为什么抽出来:本仓库没有 DOM 测试环境(无 jsdom/testing-library),面板历史上靠真机
 * 目视。但"两道门 + 两段式确认"的**判断**本身是纯逻辑,埋在 JSX 里就只能靠人眼看;
 * 抽成函数后它能被普通单测钉住,真机只需验证渲染接线,不必再验证规则。
 */
export interface ArmView {
  armed: boolean;
  reason?: string;
}

/** 编辑/删除/新增按钮的可点性与原因(不可点必须说清为什么,否则像坏了)。 */
export function editAffordance(arm: ArmView | null): { enabled: boolean; why: string } {
  if (arm === null) return { enabled: false, why: tr("写面状态未知（等待 ext-config-arm 回读）") };
  if (arm.armed) return { enabled: true, why: '' };
  return { enabled: false, why: arm.reason ?? tr("驱动配置当前不可写") };
}

/** 删除的两段式状态机第一问:返回下一步与该步该说什么。 */
export function removeStep(pendingId: string | null, id: string): 'arm-confirm' | 'commit' {
  return pendingId === id ? 'commit' : 'arm-confirm';
}

/** 删除前警告文案:把账本数目说清,否则"删除远端接入"看起来是个无成本按钮。 */
export function removeWarningText(id: string, shadows: number, outboxPending: number): string {
  const parts: string[] = [];
  if (shadows > 0) parts.push(tr("{p1} 条影子账", { p1: shadows }));
  if (outboxPending > 0) parts.push(tr("{p1} 个待推任务", { p1: outboxPending }));
  const tail = parts.length > 0 ? tr("该驱动已有 {p1}，远端数据不会因此消失；", { p1: parts.join('、') }) : tr("该驱动尚无本地账本；");
  return tr("移除只改 profile 里的接入项：{p1}重载后不再装配。id={p2}", { p1: tail, p2: id });
}

/** 保存成功后的提示:needsReload 决定要不要提"重载"（本插件无热重载通道）。 */
export function savedText(
  id: string,
  created: boolean,
  needsReload: boolean,
  counts: { shadows: number; outboxPending: number },
  notice?: string,
): string {
  const head = tr("已写入 profile") + (needsReload ? tr("，重载插件后生效") : '');
  const tail = counts.shadows > 0 ? tr("（{p1} 条影子账保留）", { p1: counts.shadows }) : '';
  // 服务端读回结果比“成功”二字值钱：不一致时必须抢在成功文案前面说话。
  const note = notice !== undefined && notice !== '' ? `⚠ ${notice}` : '';
  return `${note}${note ? ' ' : ''}${head}（${created ? tr("新增") : tr("更新")} ${id}）${tail}`;
}

/**
 * 总闸未开时，同步开关卡片该不该置灰 + 该说什么。
 *
 * 不置灰就是个暗示器：`pusher`/`puller` 的第一道条件都是 `masterEnabled`（装配期由
 * `ext_memory.enabled` 定），总闸关时拨档位会真写 live、界面也会变，但行为零变更——
 * “开关拨了而设置不生效”比不给开关更坑。置灰 + 说原因才能把生效点位指对。
 */
export function syncGateNotice(inEffect: boolean): { blocked: boolean; why: string } {
  if (inEffect) return { blocked: false, why: '' };
  return {
    blocked: true,
    why: tr("总闸未开（ext_memory.enabled=false）：以下开关不会改变行为——装配在启动期决定，第 5 路与推/拉闸门此时不存在。"),
  };
}

/**
 * 总闸写入后的回显文案：`needsReload` 恒真，必须说“还没生效”。
 * 面板上的“生效态”仍读装配真相，所以写入后列表会接着显示“已关闭 + 待重载”——
 * 这是故意不一致：把待生效当成已生效回显，用户就会去拨那些其实不会动的开关。
 */
export function gateResultText(want: boolean, notice?: string): string {
  const head = want
    ? tr("总闸已写入 profile（enabled=true），重载后才会装配驱动并开启检索第 5 路。")
    : tr("总闸已写入 profile（enabled=false），重载后外部记忆整体停用。");
  return notice !== undefined && notice !== '' ? `⚠ ${notice} ${head}` : head;
}

/** 关闭总闸前的警告：说清会停掉什么，否则这是个看起来无成本的按钮。 */
export function gateOffWarning(driverCount: number, shadows: number, outboxPending: number): string {
  const parts: string[] = [];
  if (driverCount > 0) parts.push(tr("{p1} 个驱动接入项", { p1: driverCount }));
  if (shadows > 0) parts.push(tr("{p1} 条影子账", { p1: shadows }));
  if (outboxPending > 0) parts.push(tr("{p1} 个待推任务", { p1: outboxPending }));
  const tail = parts.length > 0 ? tr("将随装配一并停下：{p1}；profile 里的配置与本地账本不删。", { p1: parts.join('、') }) : tr("当前无驱动接入项，停用后行为同未引入本段。");
  return tr("关闭总闸只改 profile 里的 enabled：{p1}再开同样需重载。", { p1: tail });
}

/**
 * 总闸状态文案：分开说“在不在跑”与“profile 想让它怎样”。
 *
 * 真宿主的 extMemory 是 volatile 节：写入后内存值立即变，而驱动实例是启动期建的。
 * 拿配置值当生效态会反向骗人（面板说“已关闭”，第 5 路其实还在跑）；拿装配值当唯一
 * 真相又会让人以为点了没反应。所以两个都说，并指明哪个要重载才对齐。
 */
export function gateStateText(assembled: boolean, configured: boolean | undefined): string {
  if (assembled && configured === false) {
    return tr("外部记忆仍在运行（驱动已装配），但 profile 里的总闸已改为关：重载后停用。");
  }
  if (!assembled && configured === true) {
    return tr("总闸已在 profile 开启（enabled=true），但驱动尚未装配：重载后才会装配驱动并开启检索第 5 路。");
  }
  if (!assembled) {
    return tr("总闸 ext_memory.enabled=false：无驱动装配、零外部网络请求、检索第 5 路不存在。");
  }
  return '';
}

/** 导入按钮的可点性：三种情势都得带原因，否则“按不了”看起来就是插件坏了。 */
export function importAffordance(
  arm: ArmView | null,
  driver: { typeId: string; browse?: boolean; shadows?: number } | null,
): { enabled: boolean; why: string } {
  if (arm === null) return { enabled: false, why: tr("导入面状态未知（等待 ext-config-arm 回读）") };
  if (!arm.armed) return { enabled: false, why: arm.reason ?? tr("导入面当前不可用") };
  if (driver !== null && driver.browse === false) {
    return { enabled: false, why: tr("{p1} 不提供遍历端点，无法全量导入（只能按查询词检索）", { p1: driver.typeId }) };
  }
  return { enabled: true, why: '' };
}

/**
 * “从断点第 N 条续跑”该不该说，以及说 N 是几。
 *
 * 真机抓到的谎报：上一轮已 `complete`（断点已清），面板仍写“从断点第 3000 条续跑”——
 * 用户以为点下去只导剩下的，实际从 0 重扫一遍。本函数只在一个条件成立时给数：
 * **上一轮未正常收尾 且 属于同一驱动**。
 */
export function resumePoint(
  prog: { driverId: string; offset: number; last?: { truncation: string } } | null,
  driverId: string,
): number | undefined {
  if (prog === null || prog.driverId !== driverId) return undefined;
  if (prog.last !== undefined && prog.last.truncation === 'complete') return undefined;
  return prog.offset > 0 ? prog.offset : undefined;
}

/**
 * 关闭隔离闸前的后果说明（两段式）。
 *
 * 这个开关是本面唯一**默认开**且关掉就静默改变检索质量的闸：关掉后外源条目会进入反刍/L2 的
 * 取数窗口，把本地记忆挤出去——没有报错、没有提示，只是“最近怎么想不起来自己的事”。
 * 所以关闭必须先说后果，而不是一个一拨就生效的框。
 */
export function isolateOffWarning(shadowTotal: number): string {
  const scale = shadowTotal > 0
    ? tr("当前已导入/关联 {p1} 条外源条目，关闭后会一起进入取数窗口", { p1: shadowTotal })
    : tr("当前无外源条目，关闭当下无影响；但一旦导入过外源条目，它们将进入取数窗口");
  return (
    tr("关闭后，外源条目会与本地记忆争夺同一批取数名额，可能把本地记忆挤出窗口——")
    + tr("这不会报错，只会让反刍“越来越不记得自己的事”。{p1}。确定关闭？", { p1: scale })
  );
}

/**
 * 导入前的量级警告（两段式第一问）。
 *
 * 必须把成本说在点下去之前：导入不是“读一下”，它逐条向量化（本地模型单条可达秒级、
 * 远程按次计费），md 投射开着时还会每条生成一个文件。不说清，用户就是拿一个
 * 意外的小时级后台任务换了“我以为是预览”。
 */
export function importWarningText(input: {
  driverId: string;
  maxItems: number;
  resumedFrom?: number;
  memExportOn?: boolean;
}): string {
  const from = input.resumedFrom !== undefined && input.resumedFrom > 0 ? tr("从断点第 {p1} 条续跑，", { p1: input.resumedFrom }) : '';
  const md = input.memExportOn === true ? tr("且 md 投射当前开着：导入 N 条会生成 N 个 .memory.md 文件，后续人工改动会与远端形成 both_dirty。") : '';
  return (
    tr("导入将把 {p1} 的远端条目写入本地 L1 检索库（逐条向量化，上限 {p2} 条）；", { p1: input.driverId, p2: input.maxItems }) +
    tr("{p1}可中断，断点会保留。{p2}再点一下确认开始。", { p1: from, p2: md })
  );
}

/**
 * 导入收尾文案。`truncation` 非 complete 时**不得读成成功**——
 * 把“没取完”显示成“导入完成”，用户会拿它当全量结果用。
 */
export function importResultText(
  s: { imported: number; skipped: number; conflicts?: number; failed?: number; truncation: string; l1TotalBefore?: number; l1TotalAfter?: number },
): string {
  const head = tr("导入完成：新增 {p1} 条，跳过 {p2} 条", { p1: s.imported, p2: s.skipped });
  const proof = s.l1TotalBefore !== undefined && s.l1TotalAfter !== undefined ? tr("（本地库 {p1} → {p2} 条）", { p1: s.l1TotalBefore, p2: s.l1TotalAfter }) : '';
  const extra = (s.conflicts ?? 0) > 0 || (s.failed ?? 0) > 0 ? tr("冲突 {p1}，失败 {p2}。", { p1: s.conflicts ?? 0, p2: s.failed ?? 0 }) : '';
  if (s.truncation === 'complete') return tr("{p1}{p2}，已翻到末页。{p3}", { p1: head, p2: proof, p3: extra });
  const why: Record<string, string> = {
    capped: tr("未取完：达本次上限，可提高上限或再跑一轮（会从断点续）"),
    budget: tr("未取完：时间预算耗尽，再跑一轮会从断点续"),
    cancelled: tr("已中断：断点已保留，再点会从当前位置续跑"),
    unsupported: tr("该服务不提供遍历端点，本次未导入任何条目"),
  };
  return `⚠ ${why[s.truncation] ?? tr("未正常收尾（{p1}）", { p1: s.truncation })}；${head}${proof}。${extra}`;
}

/**
 * 字段 placeholder:“留空代表什么”必须贴在输入框上。
 * 尤其 apiKey——它不回显，用户看不到当前值；若不写“留空 = 保留原值”，
 * 唯一安全的做法就变成“每次重填密钥”，而那正是用户会误删配置的瞬间。
 */
export function fieldPlaceholder(key: 'id' | 'type' | 'endpoint' | 'apiKey' | 'space' | 'extra', hasExisting: boolean): string {
  switch (key) {
    case 'id':
      return tr("如 hs-prod（小写字母/数字起头，可含 . _ -）");
    case 'endpoint':
      return tr("https://api.example.com 或本地绝对路径");
    case 'apiKey':
      return hasExisting ? tr("已配置不回显；留空 = 保留原值；推荐 secret://ref") : tr("可留空；或填 secret://ref（推荐，存于 DPAPI 凭据库）");
    case 'space':
      return hasExisting ? tr("留空 = 保留原值（bankId / userId:agentId / containerTag / uri / 目录）") : tr("namespace：bankId / userId:agentId / containerTag / uri / 目录");
    case 'extra':
      return hasExisting ? tr("JSON 对象；留空 = 保留原值") : tr("JSON 对象（可选），如 {\"mode\":\"self-hosted\"}");
    default:
      return '';
  }
}
