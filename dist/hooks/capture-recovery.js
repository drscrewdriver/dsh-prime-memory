function turnOf(event) {
    const t = event.data?.turn;
    return typeof t === 'number' && Number.isFinite(t) ? t : undefined;
}
/**
 * 从持久化事件日志折叠出可恢复轮次。
 *
 * - **bracket 完整性**:只有 `turn/start(T) … turn/end(T)` 成对(任意 reason——
 *   interrupted 与 completed 同等对待,插件停机期间宿主正常完成的轮次同样缺 L0)才入选;
 *   未闭合 tail 跳过(宿主 reload 补闭合后,下次 resume 自然纳入)。
 * - **水位线窗口**:只取 `turn > watermark`(watermark=undefined 视为会话 L0 全空,
 *   全部入选)。
 * - **上限**:按 turn 取最靠尾的 `maxTurns`(缺省 2)个,返回按 startSeq 升序
 *   (调用方按序落 L0,保持时序)。
 * - **防御**:输入乱序时按 seq 稳定排序;同 turn 重复 bracket(代际文件重叠等畸形)
 *   保留 endSeq 更晚的一个;`data.turn` 非有限数字的括号一律不折叠。
 */
export function foldRecoverableTurns(events, watermark, opts) {
    const maxTurns = opts?.maxTurns ?? 2;
    const sorted = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const open = new Map();
    const brackets = [];
    for (let i = 0; i < sorted.length; i++) {
        const event = sorted[i];
        if (event.type === 'turn/start') {
            const turn = turnOf(event);
            if (turn !== undefined)
                open.set(turn, { startSeq: event.seq, startIdx: i });
        }
        else if (event.type === 'turn/end') {
            const turn = turnOf(event);
            const start = turn !== undefined ? open.get(turn) : undefined;
            if (turn === undefined || start === undefined)
                continue;
            open.delete(turn);
            brackets.push({
                turn,
                startSeq: start.startSeq,
                endSeq: event.seq,
                events: sorted.slice(start.startIdx + 1, i + 1),
            });
        }
    }
    const eligible = brackets.filter((b) => watermark === undefined || b.turn > watermark);
    const byTurn = new Map();
    for (const b of eligible) {
        const prev = byTurn.get(b.turn);
        if (prev === undefined || b.endSeq >= prev.endSeq)
            byTurn.set(b.turn, b);
    }
    return [...byTurn.values()].sort((a, b) => a.turn - b.turn).slice(-maxTurns).sort((a, b) => a.startSeq - b.startSeq);
}
/**
 * task_8 降级链:`agent.session.events` 不可得时,依次尝试
 * ① `ctx.sessionQuery.readSession(id)`(live 或 persisted 均可,返回完整原始日志);
 * ② `ctx.sessionPersistence.readFrom(id, 0)`(按 seq 范围读,0 = 从头取全量——
 *    水位线以 turn 计,无 seq 对应,全量交由 fold + 上限 2 收敛)。
 *
 * 0.1.5 适配:readSession/readFrom 在宿主 0.1.5 上是 **async** 且解析为
 * `{ session: { id }, events }`(见 src/store/evidence-source.ts 的
 * SessionQueryLike);0.1.7+ 为同步。本函数统一 await,`accepts` 同时认
 * 顶层 `events` 与 `session.events` 两种放置。
 *
 * 返回 undefined = 两级均不可用/均失败(调用方走一次性提示 + 维持现状)。
 * 守卫纪律与 recall.ts 的 loadStored 探针一致:不假设方法存在,失败静默降级。
 */
export async function readPersistedEventsViaServices(svcs, sessionId) {
    const unwrap = (r) => {
        if (r === null || typeof r !== 'object')
            return undefined;
        const o = r;
        if (Array.isArray(o.events) && o.events.length > 0)
            return o.events;
        const inner = o.session;
        if (inner !== null && typeof inner === 'object' && Array.isArray(inner.events) && inner.events.length > 0) {
            return inner.events;
        }
        return undefined;
    };
    const q = svcs.sessionQuery;
    if (q !== null && typeof q === 'object' && typeof q.readSession === 'function') {
        try {
            const result = await q.readSession(sessionId);
            const events = unwrap(result);
            if (events)
                return events;
        }
        catch {
            /* 落到下一级 */
        }
    }
    const p = svcs.sessionPersistence;
    if (p !== null && typeof p === 'object' && typeof p.readFrom === 'function') {
        try {
            const result = await p.readFrom(sessionId, 0);
            const events = unwrap(result);
            if (events)
                return events;
        }
        catch {
            /* 均不可用 */
        }
    }
    return undefined;
}
