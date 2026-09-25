// hall → Wing 一次性改名脚本(2026-09-23,升格拍板后的机制落地)
// 边界:只改代码标识符/组件名/RPC 端点 id/LLM 文案;磁盘与 wire 键
// (metadata.hall、session-modes 的 hall/halls/hallInclude* 字段名、
//  cfg.hall、memory_search 参数名)一律保留,由调用处注释标注。
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync(
  `git ls-files "src/**/*.ts" "src/*.ts" "client/src/**/*.ts" "client/src/**/*.tsx" "client/src/*.ts" "tests/**/*.ts" "tests/*.ts"`,
  { encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean); // 全量纳入(hall-migrate 族已随改名)

// 顺序无关:全部用 \b 词边界,重叠词(hallLabel/hallLabels)天然不互吃
const rules = [
  // RPC 端点 id + 注释里的端点引用
  [/dsh-memory\/hall-overview/g, 'dsh-memory/wing-overview'],
  [/dsh-memory\/hall-backfill/g, 'dsh-memory/wing-backfill'],
  [/\bhall-overview\b/g, 'wing-overview'],
  [/\bhall-backfill\b/g, 'wing-backfill'],
  // 常量
  [/\bHALL_FALLBACK\b/g, 'WING_FALLBACK'],
  [/\bHALL_ANCHORS\b/g, 'WING_ANCHORS'],
  [/\bHALL_CATALOG\b/g, 'WING_CATALOG'],
  [/\bHALL_GATE_WEIGHT_FLOOR\b/g, 'WING_GATE_WEIGHT_FLOOR'],
  [/\bHALL_DEFAULT_ENABLED\b/g, 'WING_DEFAULT_ENABLED'],
  [/\bHALL_VALID_VALUES\b/g, 'WING_VALID_VALUES'],
  // 类型 / 组件
  [/\bHallOverviewResponse\b/g, 'WingOverviewResponse'],
  [/\bHallBackfillResponse\b/g, 'WingBackfillResponse'],
  [/\bHallMigrationOptions\b/g, 'WingMigrationOptions'],
  [/\bHallMultiSelect\b/g, 'WingMultiSelect'],
  [/\bHallWheel\b/g, 'WingWheel'],
  [/\bHallDef\b/g, 'WingDef'],
  [/\bHallId\b/g, 'WingId'],
  // 函数 / 方法(长名先于短名,词边界保证)
  [/\bsetHallIncludeUnlabeled\b/g, 'setWingIncludeUnlabeled'],
  [/\bsetHallIncludeGeneral\b/g, 'setWingIncludeGeneral'],
  [/\bhardFilterByHallLock\b/g, 'hardFilterByWingLock'],
  [/\bisHallCorner\b/g, 'isWingCorner'],
  [/\bnormHallEnabled\b/g, 'normWingEnabled'],
  [/\bdomainOfHall\b/g, 'domainOfWing'],
  [/\bhallOf\b/g, 'wingOf'],
  [/\bhallCatalog\b/g, 'wingCatalog'],
  [/\bhallLabels\b/g, 'wingLabels'],
  [/\bhallLabel\b/g, 'wingLabel'],
  [/\bhallText\b/g, 'wingText'],
  [/\bhallSel\b/g, 'wingSel'],
  [/\bhallById\b/g, 'wingById'],
  [/\bhallL1Counts\b/g, 'wingL1Counts'],
  [/\bhallCounts\b/g, 'wingCounts'],
  [/\bstartHallBackfill\b/g, 'startWingBackfill'],
  [/\brunHallMigration\b/g, 'runWingMigration'],
  [/\bhallBackfillState\b/g, 'wingBackfillState'],
  [/\bsetHalls\b/g, 'setWings'],
  [/\bgetHalls\b/g, 'getWings'],
  [/\bsetHall\b/g, 'setWing'],
  [/\bgetHall\b/g, 'getWing'],
  [/\bhallBoundaries\b/g, 'wingBoundaries'],
  [/\bonCommitHallBoundaries\b/g, 'onCommitWingBoundaries'],
  [/\bcommitHallBoundaries\b/g, 'commitWingBoundaries'],
  [/\bonCommitHall\b/g, 'onCommitWing'],
  [/\bcommitHall\b/g, 'commitWing'],
  [/\bbyHall\b/g, 'byWing'],
  [/\bnextHalls\b/g, 'nextWings'],
  // CSS 变量
  [/dsh-mem-hall/g, 'dsh-mem-wing'],
  // LLM 文案
  [/【Hall 标签】/g, '【Wing 标签】'],
  [/可选 Hall：/g, '可选 Wing：'],
  // ── 第二遍:漏网常量 / 局部变量 / 概念注释(大写 Hall 只出现在注释与文案,wire 键是小写) ──
  [/\bHALL_GATE_NEUTRAL\b/g, 'WING_GATE_NEUTRAL'],
  [/\bhallByIdOf\b/g, 'wingByIdOf'],
  [/\bhallLocks\b/g, 'wingLocks'],
  // domain-gate.ts 内部局部变量(该文件无 wire 键)
  [/\bhall\b/g, 'wing'],
  // 注释/日志里的概念措辞(小写 hall 概念词,按短语精确替换,不碰 hall: 键)
  [/hall 打标候选/g, 'Wing 打标候选'],
  [/hall 域范围/g, 'Wing 域范围'],
  [/hall 归属表/g, 'Wing 归属表'],
  [/域硬过滤 hall=/g, '域硬过滤 wing='],
  [/hall 八边形/g, 'Wing 八边形'],
  [/hall 打标/g, 'Wing 打标'],
  [/hall 功能/g, 'Wing 功能'],
  [/Hall id 列表/g, 'Wing id 列表'],
  [/Hall 过滤/g, 'Wing 过滤'],
  [/Hall 词表/g, 'Wing 词表'],
  [/Hall 标签/g, 'Wing 标签'],
  [/metadata 键\(`hall`/g, 'metadata 键(`hall`(磁盘兼容键名,概念名 Wing)'],
];

let total = 0;
for (const f of files) {
  const before = readFileSync(f, 'utf8');
  let after = before;
  for (const [re, to] of rules) after = after.replace(re, to);
  if (after !== before) {
    writeFileSync(f, after);
    const n = rules.reduce((acc, [re]) => (before.match(re)?.length ?? 0) + acc, 0);
    total += n;
    console.log(`${f} (${n})`);
  }
}
console.log(`TOTAL replacements ≈ ${total}`);
