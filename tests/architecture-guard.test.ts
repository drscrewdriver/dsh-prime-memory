/**
 * 架构守卫:物理删除单一调用方(治理横切 T5.7,I-13/P2-4)。
 *
 * `deleteL1Batch`(硬删,不可逆)的真实调用点数量**恒为 2**(定义 + exportThenPurge
 * 内唯一调用,而 purge 通路自带"先快照+校验通过才删"的纪律)。新增第三个调用点 =
 * 绕过快照纪律的硬删后门,必须显式论证并改本测试。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readDirRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...readDirRecursive(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('deleteL1Batch 单一调用方(I-13/P2-4)', () => {
  it('src/ 内真实调用点恒为 2(定义 + exportThenPurge 唯一调用)', () => {
    const callSites: string[] = [];
    for (const f of readDirRecursive(join(process.cwd(), 'src'))) {
      const src = readFileSync(f, 'utf8');
      for (const line of src.split('\n')) {
        const t = line.trim();
        // 排除注释行;`.deleteL1Batch(`(方法调用)与独立语句才算调用
        if (t.startsWith('//') || t.startsWith('*')) continue;
        if (/\.deleteL1Batch\(/.test(t) || /^deleteL1Batch\(/.test(t)) {
          callSites.push(`${f}: ${t.slice(0, 70)}`);
        }
      }
    }
    const msg = callSites.length === 0 ? '(无调用点)' : `\n${callSites.join('\n')}`;
    expect(callSites.length, `deleteL1Batch 调用点 ${callSites.length} 处:${msg}`).toBe(2);
  });
});
