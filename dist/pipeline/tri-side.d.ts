export interface TriSideObservation {
    /** 库当前正文(缺席 = 无库记录)。 */
    dbContent?: string;
    /** 文件解析后的正文(缺席 = 无文件)。 */
    fileContent?: string;
    /** 各外部条目命中该记录时的内容(空数组 = 无外部映射)。 */
    remoteContents?: string[];
}
export type TriSideVerdict = 'all-same' | 'db-only' | 'file-only' | 'remote-only' | 'db-file' | 'db-remote' | 'file-remote' | 'all-differ' | 'no-data';
export type TriSideAction = 'none' | 'rewrite-file' | 'reimport-db' | 'push' | 'pull' | 'conflict';
export interface TriSideAdjudication {
    verdict: TriSideVerdict;
    action: TriSideAction;
    why: string;
}
export declare function adjudicateTriSide(o: TriSideObservation): TriSideAdjudication;
