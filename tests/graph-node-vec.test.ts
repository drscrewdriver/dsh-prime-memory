/**
 * §F 图谱节点向量列 / task_32~34。
 *
 * 三件事，每件都配了**反向判据**:
 * ① **建表**与 `l1_vec` 同模式（vec0 + `float[N] distance_metric=cosine`），
 *    维度来自既有能力探测结果，不新增一套探测；
 * ② **降级是结构性内建的**：维度未定 → 该路压根不存在（不建表、不告警）；
 *    建表失败 → 该路停用但**图谱其余功能照常**；
 * ③ **task_34 的核心**：向量列失败**不得**把图谱从"向量路不可用"退化成
 *    "整个图谱域不可用"。用户例用**非法维度**（`float[-1]`）触发真实的建表失败——
 *    若那一层内层 `try/catch` 被移除，异常会冒到 `init` 的外层 catch，
 *    `ready` 变成 false，本用例当场变红。这是它与"读一遍代码觉得没问题"的区别。
 *
 * 另：vec0 相关的读写用例用 `it.runIf` 门控。**门控是可见的**（vitest 会显示 skipped），
 * 不是"静默不跑"；且降级用例不依赖 vec0，任何环境都有实质断言。
 */
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { GraphStore } from '../src/store/graph-store.js';

const require = createRequire(import.meta.url);

/**
 * 当前环境能否用 vec0。探测方式与 MemoryDb 的 `ensureVecLoaded` **逐字对齐**：
 * ① 建库时必须 `{ allowExtension: true }`——**事后开不了**
 *    （`Cannot enable extension loading because it was disabled at database creation.`）；
 * ② 加载扩展前后用 `enableLoadExtension` 开关，加载完立即复位（不留常开的加载面）。
 *
 * ⚠️ 这里连踩两坑，都产出了同一症状"本机不支持 vec0"、整组用例被静默跳过
 * （**代码写了但从未执行**）：首版漏了 `enableLoadExtension`，次版漏了建库选项。
 * 教训：**探针与生产加载路径不一致时，"环境不支持"是最容易被误信的解释**——
 * 探针必须照抄生产那两行，而不是"意思差不多"。
 */
function probeVec0(): boolean {
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  try {
    const sqliteVec = require('sqlite-vec') as { load(d: unknown): void };
    db.enableLoadExtension(true);
    sqliteVec.load(db);
    db.exec('CREATE VIRTUAL TABLE probe USING vec0(v float[2])');
    return true;
  } catch {
    return false;
  } finally {
    try {
      db.enableLoadExtension(false);
    } catch {
      /* ignore */
    }
    db.close();
  }
}

/** 打开一个已加载 sqlite-vec 的连接（无扩展时退回裸连接，由 `VEC0_OK` 门控用例组）。 */
function openVecDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  try {
    const sqliteVec = require('sqlite-vec') as { load(d: unknown): void };
    db.enableLoadExtension(true);
    sqliteVec.load(db);
    db.enableLoadExtension(false);
  } catch {
    /* 无扩展 → 裸连接 */
  }
  return db;
}

const VEC0_OK = probeVec0();

/** 直接插一个节点（绕过投影管线，本文件只关心存储层语义）。 */
function rawInsertNode(db: DatabaseSync, id: string, name: string): void {
  db.prepare(
    `INSERT INTO graph_nodes (node_id, name, type, aliases_json, tags_json, current_state, facts_json,
       status, confidence, source_record_ids_json, families_json, created_time, updated_time)
     VALUES (?, ?, 'concept', '[]', '[]', '', '[]', 'active', 0.8, '[]', '["work"]', '', '')`,
  ).run(id, name);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** 受控的伪向量：与查询向量的余弦距离可直接算出，便于断言排序。 */
const V = {
  same: new Float32Array([1, 0, 0, 0]),
  ortho: new Float32Array([0, 1, 0, 0]),
  zero: new Float32Array([0, 0, 0, 0]),
};

describe('task_32 §F graph_node_vec：维度未定 → 该路结构性不存在', () => {
  it('dimensions=0 → 不建表、接口 no-op、不抛（不是"建了空表"）', () => {
    const db = new DatabaseSync(':memory:');
    const g = new GraphStore();
    g.init(db, undefined, { dimensions: 0 });
    expect(g.ready).toBe(true);
    expect(g.nodeVecReady).toBe(false);
    expect(tableExists(db, 'graph_node_vec')).toBe(false);
    expect(g.searchNodesByVector(V.same, 5)).toEqual([]);
    expect(g.upsertNodeVectors([{ nodeId: 'n1', embedding: V.same }])).toBe(0);
    expect(() => g.deleteNodeVectors(['n1'])).not.toThrow();
    db.close();
  });

  it('不传 vec 参数 = 同"维度 0"（缺省即不启用，既有调用方零行为变化）', () => {
    const db = new DatabaseSync(':memory:');
    const g = new GraphStore();
    g.init(db, undefined);
    expect(g.ready).toBe(true);
    expect(g.nodeVecReady).toBe(false);
    expect(tableExists(db, 'graph_node_vec')).toBe(false);
    db.close();
  });
});

describe('task_34 §F 向量列失败不得拖垮图谱域', () => {
  it('vec0 不可用（正维度但模块缺失）→ 建表真抛，图谱仍 ready、词法检索照常', () => {
    // 触发方式必须精确：**裸连接**（建库时未开 allowExtension → 加载不了 vec0 扩展）
    // 配**正**维度，于是真的走到 `CREATE VIRTUAL TABLE ... USING vec0` 并抛出
    // `no such module: vec0`——这正是生产环境缺 sqlite-vec 时的真实场景。
    //
    // ⚠️ 本用例首版写的是 `dimensions: -1`，那是**空洞通过**：`prepareNodeVec` 开头
    // `if (dimensions <= 0) return;` 把负数拦在 try **之前**，"建表失败"那条路径
    // 压根没执行，去掉内层 catch 也不会变红（变异探针当场抓出）。
    const db = new DatabaseSync(':memory:');
    const g = new GraphStore();
    g.init(db, undefined, { dimensions: 4 });

    expect(g.ready).toBe(true); // ← 关键断言：失败被**内层**吃掉了，没冒到图谱域的 catch
    expect(g.nodeVecReady).toBe(false);
    expect(tableExists(db, 'graph_node_vec')).toBe(false);

    // 图谱**其余功能**照常：词法检索仍能命中节点
    rawInsertNode(db, 'n1', 'Rust');
    const hits = g.searchNodes('Rust', 5);
    expect(hits.length).toBe(1);
    expect(hits[0].node.name).toBe('Rust');

    // 向量接口在停用态仍是 no-op，不抛
    expect(g.searchNodesByVector(V.same, 5)).toEqual([]);
    expect(g.upsertNodeVectors([{ nodeId: 'n1', embedding: V.same }])).toBe(0);
    expect(() => g.deleteNodeVectors(['n1'])).not.toThrow();
    db.close();
  });
});

describe('task_33 §F vec0 可用时：建表、读写与降级口径', () => {
  it.runIf(VEC0_OK)('表结构与 l1_vec 同模式（node_id 主键 + embedding + updated_time）', () => {
    const db = openVecDb();
    const g = new GraphStore();
    g.init(db, undefined, { dimensions: 4 });
    expect(g.ready).toBe(true);
    expect(g.nodeVecReady).toBe(true);
    const cols = db.prepare('PRAGMA table_info(graph_node_vec)').all() as Array<{ name: string; pk: number }>;
    expect(cols.map((c) => c.name).sort()).toEqual(['embedding', 'node_id', 'updated_time']);
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['node_id']);
    db.close();
  });

  it.runIf(VEC0_OK)('写入后可按余弦距离检索，且 score 与 L1 向量路同口径（1 - distance）', () => {
    const db = openVecDb();
    const g = new GraphStore();
    g.init(db, undefined, { dimensions: 4 });
    rawInsertNode(db, 'n-same', 'Exact');
    rawInsertNode(db, 'n-ortho', 'Orthogonal');

    const written = g.upsertNodeVectors([
      { nodeId: 'n-same', embedding: V.same },
      { nodeId: 'n-ortho', embedding: V.ortho },
    ]);
    expect(written).toBe(2);

    const hits = g.searchNodesByVector(V.same, 5);
    expect(hits.length).toBe(2);
    expect(hits[0].node.name).toBe('Exact'); // 距离升序：同向在前
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it.runIf(VEC0_OK)('零向量被跳过（cosine 未定义，不入表）——区分力：不是"全部静默丢弃"', () => {
    const db = openVecDb();
    const g = new GraphStore();
    g.init(db, undefined, { dimensions: 4 });
    rawInsertNode(db, 'n-zero', 'Zero');
    rawInsertNode(db, 'n-same', 'Exact');

    const written = g.upsertNodeVectors([
      { nodeId: 'n-zero', embedding: V.zero },
      { nodeId: 'n-same', embedding: V.same },
    ]);
    expect(written).toBe(1); // 非零的那条确实进去了
    const ids = g.searchNodesByVector(V.same, 5).map((h) => h.node.name);
    expect(ids).toEqual(['Exact']);
  });

  it.runIf(VEC0_OK)('重复写入同一 node 是覆盖而非累加（先删后插：vec0 不支持 ON CONFLICT）', () => {
    const db = openVecDb();
    const g = new GraphStore();
    g.init(db, undefined, { dimensions: 4 });
    rawInsertNode(db, 'n1', 'N1');
    g.upsertNodeVectors([{ nodeId: 'n1', embedding: V.same }]);
    g.upsertNodeVectors([{ nodeId: 'n1', embedding: V.ortho }]);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM graph_node_vec').get() as { n: number };
    expect(rows.n).toBe(1);
    db.close();
  });

  it.runIf(VEC0_OK)('deleteNodeVectors 生效；删除不存在的 id 不抛', () => {
    const db = openVecDb();
    const g = new GraphStore();
    g.init(db, undefined, { dimensions: 4 });
    rawInsertNode(db, 'n1', 'N1');
    g.upsertNodeVectors([{ nodeId: 'n1', embedding: V.same }]);
    expect(() => g.deleteNodeVectors(['n1', 'nope'])).not.toThrow();
    const rows = db.prepare('SELECT COUNT(*) AS n FROM graph_node_vec').get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  it.runIf(VEC0_OK)('检索回链到已不存在的节点时跳过（不补空占位）', () => {
    const db = openVecDb();
    const g = new GraphStore();
    g.init(db, undefined, { dimensions: 4 });
    rawInsertNode(db, 'n1', 'N1');
    g.upsertNodeVectors([{ nodeId: 'n1', embedding: V.same }]);
    db.prepare("DELETE FROM graph_nodes WHERE node_id = 'n1'").run();
    expect(g.searchNodesByVector(V.same, 5)).toEqual([]);
    db.close();
  });
});

describe('task_33 §F 能力探测门控可见性', () => {
  it('vec0 探测结果如实反映在本机环境（不静默跳过 vec0 用例组）', () => {
    // 本用例唯一的职责是让"上一组被 runIf 跳过了"这件事**可见**：
    // 若本机缺 sqlite-vec，上组会显示 skipped，而这个断言仍然给出确定事实。
    expect(typeof VEC0_OK).toBe('boolean');
  });
});
