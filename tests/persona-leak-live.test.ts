/**
 * 真机一次性审计（不进门禁，手动跑）：对当前 $DSH_HOME 的记忆库做一次全库人格泄露扫描。
 *
 * 用法：`npx vitest run tests/persona-leak-live.test.ts`（默认 skip，需设 PM_LIVE_AUDIT=1）。
 * 跑完看 `<dataDir>/audit/persona-leak.json`。
 */

import { describe, expect, it } from 'vitest';

import { loadPersonaTerms } from '../src/audit/persona-terms.js';
import { listMdFiles, runPersonaLeakAudit } from '../src/audit/persona-leak.js';
import { DatabaseSync } from 'node:sqlite';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const LIVE = process.env.PM_LIVE_AUDIT === '1';

describe.skipIf(!LIVE)('真机人格泄露审计（PM_LIVE_AUDIT=1）', () => {
  it('跑一次全库扫描并打印命中数', () => {
    const dataDir = dshHomePath('memory');
    const dbPath = join(dataDir, 'memory.db');
    const terms = loadPersonaTerms(dshHomePath());
    console.log('[live-audit] 词表来源:', terms.source, JSON.stringify({ self: terms.selfNames, alias: terms.aliases, name: terms.cardName }));
    const db = existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true }) : undefined;
    try {
      const files = listMdFiles(dataDir);
      const report = runPersonaLeakAudit({ dataDir, terms, windowDays: 7, ...(db === undefined ? {} : { db }), mdFiles: files });
      console.log('[live-audit] scanned:', JSON.stringify(report.scanned), 'summary:', JSON.stringify(report.summary));
      for (const hit of report.hits) console.log(`[live-audit] ${hit.layer} ${hit.level} ${hit.name} :: ${hit.excerpt}`);
      expect(report.ranAt).not.toBe('');
    } finally {
      db?.close();
    }
  });
});
