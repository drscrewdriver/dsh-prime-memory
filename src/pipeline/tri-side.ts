/**
 * 三侧账本裁决(计划 T4.1):db(检索库) / file(投射文件) / remote(外部记忆服务)
 * 的**内容指纹**并排看,把 md-sync 原有的"两边都变一律挂账"收敛为:
 *
 * **file == 某个 remote ≠ db → 以文件为真值回灌库**。
 *
 * 为什么这是安全的自动收敛:文件与远端一致说明"外部写完 → 拉取落地/投射渲染"
 * 这条链刚刚走完,文件里的正文就是外部真值的本地投影;此时若还挂账等人裁决,
 * 用户会看到"明明两边一样却天天报冲突"。db 与 file 同变但互不相等(且远端无输入)
 * 仍然挂账——那才是真的三方分歧,自动选边是赌博。
 *
 * 指纹一律 `contentOnlyDigest`(不含 type):远端没有本地 type 语义,含 type 的
 * 指纹在第三侧根本算不出来(见 store/digest.ts 头注)。
 */
import { contentOnlyDigest } from '../store/digest.js';

export interface TriSideObservation {
  /** 库当前正文(缺席 = 无库记录)。 */
  dbContent?: string;
  /** 文件解析后的正文(缺席 = 无文件)。 */
  fileContent?: string;
  /** 各外部条目命中该记录时的内容(空数组 = 无外部映射)。 */
  remoteContents?: string[];
}

export type TriSideVerdict =
  | 'all-same'
  | 'db-only'
  | 'file-only'
  | 'remote-only'
  | 'db-file'
  | 'db-remote'
  | 'file-remote'
  | 'all-differ'
  | 'no-data';

export type TriSideAction = 'none' | 'rewrite-file' | 'reimport-db' | 'push' | 'pull' | 'conflict';

export interface TriSideAdjudication {
  verdict: TriSideVerdict;
  action: TriSideAction;
  why: string;
}

export function adjudicateTriSide(o: TriSideObservation): TriSideAdjudication {
  const db = o.dbContent === undefined ? undefined : contentOnlyDigest(o.dbContent);
  const file = o.fileContent === undefined ? undefined : contentOnlyDigest(o.fileContent);
  const remotes = [...new Set((o.remoteContents ?? []).map((c) => contentOnlyDigest(c)))];
  const remote = remotes.length === 0 ? undefined : remotes.length === 1 ? remotes[0] : `multi:${remotes.join(',')}`;
  const remoteMatches = (v: string | undefined): boolean => v !== undefined && remotes.includes(v);

  if (db === undefined && file === undefined && remote === undefined) {
    return { verdict: 'no-data', action: 'none', why: '三侧皆空' };
  }
  // 单侧存在
  if (file === undefined && remote === undefined) return { verdict: 'db-only', action: 'rewrite-file', why: '仅库有:渲染到文件' };
  if (db === undefined && remote === undefined) return { verdict: 'file-only', action: 'reimport-db', why: '仅文件有:回灌库(需过写入内核)' };
  if (db === undefined && file === undefined) return { verdict: 'remote-only', action: 'pull', why: '仅远端有:拉取回灌' };

  // 双侧/三侧
  if (db !== undefined && file !== undefined && remote === undefined) {
    if (db === file) return { verdict: 'db-file', action: 'none', why: '库=文件(无外部映射)' };
    return { verdict: 'all-differ', action: 'conflict', why: '库≠文件且无远端可判:挂账' };
  }
  if (db !== undefined && remote !== undefined && file === undefined) {
    if (remoteMatches(db)) return { verdict: 'db-remote', action: 'rewrite-file', why: '库=远端:文件缺失/待渲染' };
    return { verdict: 'db-remote', action: 'push', why: '库≠远端且无文件:以库为准推送' };
  }
  if (file !== undefined && remote !== undefined && db === undefined) {
    if (remoteMatches(file)) return { verdict: 'file-remote', action: 'reimport-db', why: '文件=远端:回灌库' };
    return { verdict: 'file-remote', action: 'pull', why: '文件≠远端:以远端为准拉取' };
  }

  // 三侧齐全
  if (db !== undefined && file !== undefined && remote !== undefined) {
    if (db === file && remoteMatches(db)) return { verdict: 'all-same', action: 'none', why: '三侧一致' };
    if (db === file) return { verdict: 'db-file', action: 'push', why: '库=文件≠远端:推送' };
    if (remoteMatches(db)) return { verdict: 'db-remote', action: 'rewrite-file', why: '库=远端≠文件:重写文件' };
    if (remoteMatches(file)) return { verdict: 'file-remote', action: 'reimport-db', why: '文件=远端≠库:回灌库(外部真值已落地)' };
    return { verdict: 'all-differ', action: 'conflict', why: '三侧各不相同:挂账' };
  }

  return { verdict: 'no-data', action: 'none', why: '未覆盖组合(保守不动)' };
}
