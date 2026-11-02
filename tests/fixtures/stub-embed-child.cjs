/**
 * #22 机理刀·崩溃自愈用例的微型 fork stub(无模型依赖)。
 *
 * 说同一套 IPC 协议(warmup/embed/embedProgress/settle/ack)但**不加载任何模型**——用一个
 * 特殊文本作为「被硬杀」的触发器,让主线程侧 `LocalEmbeddingService` 的 crashCb → respawn →
 * ack 断点续试 → 速率上限这条真状态机在无 bge-m3、跨平台(CI ubuntu-latest 也能跑)下可验。
 *
 * 触发词(与真实 SIGTRAP 同形:被杀进程连同未回执向量一起消失,父侧只能从实时进度拿断点位):
 * - `__CRASHONCE__`:仅**首次**命中时自杀(靠 STUB_STATE_FILE 记录「已崩过一次」)。用于断点
 *   **续试成功**——重 fork 的新进程再遇到它时状态文件已存在,正常出向量。
 * - `__CRASHALWAYS__`:**每次**命中都自杀。用于毒输入「最多吃 2 批不成活锁」与速率上限。
 *
 * 崩法用 SIGKILL 代替 macOS 的 SIGTRAP:二者在 Node 侧都表现为 child 'exit'(code=null+signal),
 * 触发同一条 failAll→crashCb 路径,且 SIGKILL 全平台可发(Node 在 Windows 上把任意信号都当强杀)。
 * 仅供本地/CI 用例 fork,不进生产链路,也不被任何生产代码 require。
 */
'use strict';

const DIMS = Number(process.env.STUB_DIMS || 512);
const STATE_FILE = process.env.STUB_STATE_FILE || '';

function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

// warmup 秒回 ready(无模型可加载);embed 逐条走队列。
function reply(msg) {
  try {
    process.send(msg);
  } catch {
    /* 父进程已断,回复无处可去 */
  }
}

function makeVector(seed) {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = (seed + i) / 1000;
  return v;
}

function selfKill() {
  // 先让出一拍,确保上一条 embedProgress 已写入 IPC 管道(否则崩溃可能吞掉断点位)
  setImmediate(() => {
    try {
      process.kill(process.pid, 'SIGKILL');
    } catch {
      process.exit(1);
    }
  });
}

function fs() {
  try {
    return require('node:fs');
  } catch {
    return null;
  }
}

function stateFileExists() {
  const f = fs();
  if (!f || !STATE_FILE) return false;
  try {
    return f.existsSync(STATE_FILE);
  } catch {
    return false;
  }
}

function createStateFile() {
  const f = fs();
  if (!f || !STATE_FILE) return;
  try {
    f.writeFileSync(STATE_FILE, 'crashed');
  } catch {
    /* 无法落态则退化为「每次崩」,不影响用例方向 */
  }
}

/** 命中崩溃触发词时返回 true(并已在自杀路径上);否则产向量。 */
function maybeCrash(text) {
  if (text === '__CRASHALWAYS__') {
    selfKill();
    return true;
  }
  if (text === '__CRASHONCE__') {
    if (!stateFileExists()) {
      createStateFile();
      selfKill();
      return true;
    }
    return false; // 重 fork 后再遇:已崩过一次,正常出向量
  }
  return false;
}

async function handleEmbed(msg) {
  const texts = Array.isArray(msg.texts) ? msg.texts : [];
  if (texts.length === 0) {
    reply({ id: msg.id, ok: true, type: 'embedded', vectors: [], ack: 0, tokensMax: -1 });
    return;
  }
  const vectors = new Array(texts.length);
  const total = texts.length;
  for (let i = 0; i < total; i++) {
    if (maybeCrash(String(texts[i]))) return; // 进程即将自杀,不再产后续/回执
    vectors[i] = makeVector(i + 1);
    // 多条目批逐条实时上报断点(与真 embedding-child.cjs 同协议:cid 回显)
    if (total > 1) reply({ id: msg.id, cid: msg.cid, type: 'embedProgress', done: i + 1 });
    await new Promise((r) => setImmediate(r)); // 条间让路 + 让 IPC 落管道
  }
  reply({
    id: msg.id,
    ok: true,
    type: 'embedded',
    vectors: vectors.map((v) => Array.from(v)),
    ack: total,
    tokensMax: -1,
  });
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'warmup' || msg.type === 'ping') {
    reply({ id: msg.id, ok: true, type: msg.type === 'warmup' ? 'ready' : 'pong' });
    return;
  }
  if (msg.type === 'embed') {
    handleEmbed(msg).catch((err) => reply({ id: msg.id, ok: false, stage: 'infer', error: errMsg(err) }));
    return;
  }
});
