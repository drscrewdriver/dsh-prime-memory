/**
 * Phase 4 硬闸(T4.1/T4.2 判据):
 * ① **digest 单源**:md 账本与 ext 影子的库侧指纹是**同一个函数**——同一
 *    (content,type) 两处输出逐字相等;空白/大小写/换行差异在三侧可比指纹下恒等;
 * ② **三侧裁决表**:db/file/remote 的组合逐格断言,重点钉住
 *    "file == remote ≠ db → reimport-db"(外部真值落地的自动收敛);
 * ③ **共存门控**:two-way × memExport 同开 → 降 shadow-read + notice;
 *    push-only 不动(不反向改库,与文件面无写竞争)。
 */
import { describe, expect, it } from 'vitest';
import { contentDigest, contentOnlyDigest, normContentKey, sha256Hex } from '../src/store/digest.js';
import { recordDigest as mdRecordDigest } from '../src/store/memory-md.js';
import { recordDigest as extRecordDigest } from '../src/ext-memory/util.js';
import { adjudicateTriSide } from '../src/pipeline/tri-side.js';
import { applyCoexistGate, normSyncMode } from '../src/ext-memory/types.js';

describe('digest 单源(T4.1 硬闸)', () => {
  it('md 账本与 ext 影子的 recordDigest 是同一实现:同输入逐字相等', () => {
    const content = '部署约定：生产一律 nginx 反代，发布走蓝绿切换。';
    // md 侧签名只吃 content(不传 type);ext 侧带 type —— 同为 contentDigest 的不同调用
    expect(mdRecordDigest({ content })).toBe(extRecordDigest({ content }));
    expect(extRecordDigest({ content, type: 'work_fact' })).toBe(contentDigest({ content, type: 'work_fact' }));
    // 含 type 与不含 type 是不同指纹(库语义),但算法只有一份
    expect(extRecordDigest({ content, type: 'work_fact' })).not.toBe(extRecordDigest({ content }));
  });

  it('三侧可比指纹:空白/换行/大小写差异恒等;内容真变才变', () => {
    const a = contentOnlyDigest('Hello   World\n部署');
    const b = contentOnlyDigest('  hello world 部署 ');
    expect(a).toBe(b);
    expect(contentOnlyDigest('hello world 部署!')).not.toBe(a);
    expect(sha256Hex(normContentKey(' A  b '))).toBe(contentOnlyDigest('a b'));
  });

  it('md 文件面 digest 与账本库侧指纹是两件事(文件 hash 键不受迁移影响)', async () => {
    // 只验证口径分离存在:同一正文,文件面 digest(sha1/NormText)与库侧指纹(sha256)不等。
    const md = await import('../src/store/memory-md.js');
    const body = '同一段正文';
    expect(md.digest(body)).not.toBe(mdRecordDigest({ content: body }));
    expect(md.digest(body)).toHaveLength(12); // DIGEST_HEX=12(文件面口径,见 memory-md.ts)
  });
});

describe('三侧裁决表(T4.1)', () => {
  const D = (c: string) => c;
  it('三侧全同 → none', () => {
    expect(adjudicateTriSide({ dbContent: D('甲'), fileContent: '甲', remoteContents: ['甲'] }))
      .toMatchObject({ verdict: 'all-same', action: 'none' });
  });
  it('file=remote≠db → reimport-db(外部真值落地自动收敛)', () => {
    expect(adjudicateTriSide({ dbContent: '旧', fileContent: '新(外部)', remoteContents: ['新(外部)'] }))
      .toMatchObject({ verdict: 'file-remote', action: 'reimport-db' });
  });
  it('db=remote≠file → rewrite-file', () => {
    expect(adjudicateTriSide({ dbContent: '甲', fileContent: '乙', remoteContents: ['甲'] }))
      .toMatchObject({ verdict: 'db-remote', action: 'rewrite-file' });
  });
  it('db=file≠remote → push', () => {
    expect(adjudicateTriSide({ dbContent: '甲', fileContent: '甲', remoteContents: ['乙'] }))
      .toMatchObject({ verdict: 'db-file', action: 'push' });
  });
  it('三侧各不相同 → conflict(不赌)', () => {
    expect(adjudicateTriSide({ dbContent: '甲', fileContent: '乙', remoteContents: ['丙'] }))
      .toMatchObject({ verdict: 'all-differ', action: 'conflict' });
  });
  it('db≠file 且无远端 → conflict(保持 Phase 3 挂账语义)', () => {
    expect(adjudicateTriSide({ dbContent: '甲', fileContent: '乙', remoteContents: [] }))
      .toMatchObject({ verdict: 'all-differ', action: 'conflict' });
  });
  it('单侧存在 → db-only/file-only/remote-only 各自的动作', () => {
    expect(adjudicateTriSide({ dbContent: '甲' })).toMatchObject({ verdict: 'db-only', action: 'rewrite-file' });
    expect(adjudicateTriSide({ fileContent: '甲' })).toMatchObject({ verdict: 'file-only', action: 'reimport-db' });
    expect(adjudicateTriSide({ remoteContents: ['甲'] })).toMatchObject({ verdict: 'remote-only', action: 'pull' });
  });
  it('空白差异不误判:内容等价即同侧', () => {
    expect(adjudicateTriSide({ dbContent: 'Hello  World', fileContent: 'hello world', remoteContents: ['HELLO  WORLD'] }))
      .toMatchObject({ verdict: 'all-same', action: 'none' });
  });
  it('多个远端且其中一个与文件一致 → 仍收敛(远端多副本不阻塞)', () => {
    expect(adjudicateTriSide({ dbContent: '旧', fileContent: '新', remoteContents: ['新', '别家的旧版本'] }))
      .toMatchObject({ action: 'reimport-db' });
  });
});

describe('共存门控(T4.2)', () => {
  it('two-way × memExport 同开 → 降 shadow-read + notice', () => {
    const g = applyCoexistGate({ extMemoryEnabled: true, syncMode: 'two-way', memExportEnabled: true });
    expect(g.syncMode).toBe('shadow-read');
    expect(g.notice).toContain('shadow-read');
  });
  it('push-only × memExport 同开 → 保留(不反向改库,与文件面无写竞争)', () => {
    const g = applyCoexistGate({ extMemoryEnabled: true, syncMode: 'push-only', memExportEnabled: true });
    expect(g.syncMode).toBe('push-only');
    expect(g.notice).toBeUndefined();
  });
  it('投射关 / 外部关 → 不介入;非法档位仍归一 shadow-read', () => {
    expect(applyCoexistGate({ extMemoryEnabled: true, syncMode: 'two-way', memExportEnabled: false }).syncMode).toBe('two-way');
    expect(applyCoexistGate({ extMemoryEnabled: false, syncMode: 'two-way', memExportEnabled: true }).syncMode).toBe('two-way');
    expect(applyCoexistGate({ extMemoryEnabled: true, syncMode: 'bogus', memExportEnabled: true }).syncMode).toBe('shadow-read');
    expect(normSyncMode('bogus')).toBe('shadow-read');
  });
});
