/**
 * 长任务浮动球 + 建议卡片(参考 dsh-ego-browser 的 vanilla DOM overlay 模式:
 * FAB + 面板 appendChild 到 document.body,position:fixed + JS 内联定位,
 * Pointer Events 拖拽 + localStorage 持久化 + 视口夹紧)。
 *
 * pm 客户端纪律(对齐 meter/occupancy-indicator.ts 先例):
 *  - body 级直挂 = 幂等单例,应用生命周期存续,不做 dispose(页面刷新自然回收);
 *  - 回声环过滤:自有节点带 `dsh-mem-parasite` 类,不参与宿主面板探测;
 *  - 热路径:hint 轮询忙 2s / 闲 5s(服务端全内存读,session-stats 同口径),
 *    RPC 失败静默降级——建议面板永不打扰主流程。
 *
 * 行为:
 *  - 球默认隐藏;仅当 (部署开关开 && 建议出现) 时以「点亮」态浮现,点击展开卡片;
 *  - 卡片:长任务开关(临时,per-session)、上下文占用、todo 漂移、
 *    尾部 turn 压缩按钮(长任务开启才可用)、最近 todo 清单;
 *  - 建议不阻断:全部是提示与一键动作,没有任何阻断式 UI。
 */

const FAB_ID = 'dsh-mem-longtask-fab';
const PANEL_ID = 'dsh-mem-longtask-panel';
const STYLE_ID = 'dsh-mem-longtask-style';
const PARASITE = 'dsh-mem-parasite';
const POS_KEY = 'dsh.memory.longtask.pos';

interface LongTaskHint {
  sessionId: string;
  enabled: boolean;
  longTask: boolean;
  contextPct: number | null;
  contextThresholdPct: number;
  drift: number | null;
  driftThreshold: number;
  todoCount: number;
  suggest: boolean;
  reasons: string[];
  tailTurns: number;
  lastTailCompressedTurn: number | null;
  pendingTailTurns: number | null;
}

/** 与 makeRpc 的最小结构交集(全契约泛型在此收窄为 unknown,消费侧自断言)。 */
export type RpcFn = (endpoint: string, payload: Record<string, unknown>) => Promise<unknown>;

export function initLongTaskFab(rpc: RpcFn, sessionIdOf: () => string | undefined): void {
  if (document.getElementById(FAB_ID) !== null) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#${FAB_ID} { position: fixed; z-index: 9999; width: 42px; height: 42px; border-radius: 50%;
  background: rgba(30,30,32,.72); backdrop-filter: blur(22px) saturate(180%);
  border: 1px solid rgba(255,255,255,.14); box-shadow: 0 8px 24px rgba(0,0,0,.4);
  color: #f5f5f7; font-size: 19px; line-height: 40px; text-align: center; cursor: grab;
  touch-action: none; user-select: none; display: none; transition: transform .18s; }
#${FAB_ID}:hover { transform: scale(1.08); }
#${FAB_ID}.lit { display: block; box-shadow: 0 0 0 5px rgba(10,132,255,.22), 0 8px 24px rgba(0,0,0,.4);
  animation: dsh-mem-lt-breathe 2.4s ease-in-out infinite; }
@keyframes dsh-mem-lt-breathe { 0%,100% { box-shadow: 0 0 0 4px rgba(10,132,255,.16), 0 8px 24px rgba(0,0,0,.4); }
  50% { box-shadow: 0 0 0 8px rgba(10,132,255,.30), 0 8px 24px rgba(0,0,0,.4); } }
#${PANEL_ID} { position: fixed; z-index: 9998; width: 336px; border-radius: 14px;
  background: rgba(28,28,30,.78); backdrop-filter: blur(26px) saturate(180%);
  border: 1px solid rgba(255,255,255,.12); box-shadow: 0 14px 44px rgba(0,0,0,.55);
  color: #f5f5f7; font-size: 12.5px; opacity: 0; pointer-events: none;
  transform: translateY(10px) scale(.92); transform-origin: 88% 100%;
  transition: opacity .22s cubic-bezier(.16,.8,.3,1.05), transform .22s cubic-bezier(.16,.8,.3,1.1); }
#${PANEL_ID}.open { opacity: 1; pointer-events: auto; transform: none; }
#${PANEL_ID} h4 { margin: 0; padding: 10px 14px 8px; font-size: 13px; cursor: grab;
  touch-action: none; user-select: none; border-bottom: 1px solid rgba(255,255,255,.09); }
#${PANEL_ID} .row { display: flex; align-items: center; gap: 8px; padding: 7px 14px; }
#${PANEL_ID} .muted { color: rgba(245,245,247,.55); }
#${PANEL_ID} button { font: inherit; border-radius: 8px; border: 1px solid rgba(255,255,255,.18);
  background: rgba(10,132,255,.85); color: #fff; padding: 4px 10px; cursor: pointer; }
#${PANEL_ID} button.ghost { background: transparent; }
#${PANEL_ID} button:disabled { opacity: .45; cursor: default; }
#${PANEL_ID} .bar { flex: 1; height: 6px; border-radius: 3px; background: rgba(255,255,255,.14); overflow: hidden; }
#${PANEL_ID} .bar > i { display: block; height: 100%; background: #0a84ff; }
#${PANEL_ID} .bar.hot > i { background: #ff9f0a; }
#${PANEL_ID} .todos { max-height: 168px; overflow: auto; padding: 2px 14px 6px; color: rgba(245,245,247,.8); white-space: pre-wrap; }
#${PANEL_ID} .hint { padding: 0 14px 8px; color: #ffd60a; display: none; }
#${PANEL_ID} .hint.show { display: block; }
`;
  document.head.appendChild(style);

  const fab = document.createElement('div');
  fab.id = FAB_ID;
  fab.className = PARASITE;
  fab.textContent = '⏳';
  fab.title = '长任务助手';
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = PARASITE;
  panel.hidden = true;
  panel.innerHTML = `
<h4>长任务助手</h4>
<div class="row"><label style="flex:1">长任务模式</label><button data-toggle>关闭</button></div>
<div class="row muted" data-why style="display:none"></div>
<div class="row"><span style="width:86px">上下文占用</span><div class="bar"><i></i></div><span data-ctx class="muted">–</span></div>
<div class="row"><span style="width:86px">任务漂移</span><div class="bar" data-driftbar><i></i></div><span data-drift class="muted">–</span></div>
<div class="hint" data-hint>建议开启长任务模式:临近上下文压缩高风险区 / 任务内容已大幅漂移。</div>
<div class="row"><button data-compress>压缩最近轮次入记忆</button><span class="muted" data-tail></span></div>
<div class="todos" data-todos>尚无任务快照</div>
`;
  document.body.append(fab, panel);

  // 位置:localStorage 恢复 + 视口夹紧(ego-browser 模板)
  let pos: { x: number; y: number };
  try {
    pos = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') ?? {
      x: window.innerWidth - 66,
      y: window.innerHeight - 140,
    };
  } catch {
    pos = { x: window.innerWidth - 66, y: window.innerHeight - 140 };
  }
  const place = (): void => {
    pos.x = Math.max(4, Math.min(window.innerWidth - 46, pos.x));
    pos.y = Math.max(4, Math.min(window.innerHeight - 46, pos.y));
    fab.style.left = `${pos.x}px`;
    fab.style.top = `${pos.y}px`;
  };
  place();

  // 拖拽(5px 判定;面板标题栏独立拖)
  const makeDrag = (el: HTMLElement, key: 'fab' | 'panel'): void => {
    let sx = 0;
    let sy = 0;
    let bx = 0;
    let by = 0;
    let active = false;
    let dragged = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest?.('button, input')) return;
      active = true;
      dragged = false;
      sx = e.clientX;
      sy = e.clientY;
      bx = pos.x;
      by = pos.y;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!dragged && Math.abs(dx) + Math.abs(dy) > 5) dragged = true;
      if (dragged) {
        pos.x = bx + dx;
        pos.y = by + dy;
        place();
      }
    });
    el.addEventListener('pointerup', () => {
      active = false;
      if (dragged) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(pos));
        } catch {
          /* 存储不可用 = 本次会话内仍可拖 */
        }
        if (key === 'fab') suppressClick = true;
      }
    });
    el.addEventListener('pointercancel', () => {
      active = false;
    });
  };
  let suppressClick = false;
  makeDrag(fab, 'fab');

  let open = false;
  fab.addEventListener('click', () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    open = !open;
    if (open) {
      panel.hidden = false;
      const px = Math.max(8, Math.min(window.innerWidth - 344, pos.x - 300));
      const py = pos.y - 300 < 8 ? pos.y + 46 : Math.max(8, pos.y - 300);
      panel.style.left = `${px}px`;
      panel.style.top = `${py}px`;
      void panel.offsetHeight;
      panel.classList.add('open');
    } else {
      panel.classList.remove('open');
      setTimeout(() => {
        panel.hidden = true;
      }, 240);
    }
  });
  makeDrag(panel.querySelector('h4') as HTMLElement, 'panel');

  // 状态与轮询
  let last: LongTaskHint | undefined;
  const setToggle = (on: boolean, busy: boolean): void => {
    const btn = panel.querySelector<HTMLButtonElement>('[data-toggle]')!;
    btn.textContent = on ? '开启中' : '关闭';
    btn.disabled = busy;
  };
  const render = (h: LongTaskHint): void => {
    last = h;
    fab.classList.toggle('lit', Boolean(h.enabled && h.suggest && !h.longTask));
    setToggle(h.longTask, false);
    const ctxBar = panel.querySelector('.row .bar > i') as HTMLElement;
    const ctxPctEl = panel.querySelector('[data-ctx]') as HTMLElement;
    const pct = h.contextPct;
    if (pct === null) {
      ctxBar.style.width = '0%';
      ctxPctEl.textContent = '–';
    } else {
      ctxBar.style.width = `${Math.min(100, pct)}%`;
      ctxBar.parentElement?.classList.toggle('hot', pct >= h.contextThresholdPct);
      ctxPctEl.textContent = `${pct}%`;
    }
    const driftBar = panel.querySelector('[data-driftbar] > i') as HTMLElement;
    const driftEl = panel.querySelector('[data-drift]') as HTMLElement;
    if (h.drift === null) {
      driftBar.style.width = '0%';
      driftEl.textContent = '–';
    } else {
      driftBar.style.width = `${Math.min(100, Math.round(h.drift * 100))}%`;
      driftEl.textContent = `${Math.round(h.drift * 100)}%`;
    }
    const hint = panel.querySelector('[data-hint]') as HTMLElement;
    hint.classList.toggle('show', Boolean(h.suggest && !h.longTask));
    const tail = panel.querySelector('[data-tail]') as HTMLElement;
    tail.textContent =
      h.pendingTailTurns === null
        ? ''
        : h.pendingTailTurns > 0
          ? `待压缩 ${h.pendingTailTurns} 轮`
          : '已全部入忆';
    (panel.querySelector('[data-compress]') as HTMLButtonElement).disabled = !h.longTask;
  };
  const fetchTodos = async (): Promise<string> => {
    // todo 清单直接来自 hint(服务端 todoCount);条目渲染走 session-stats 的 todo 参考?—
    // 保持单一数据源:hint 只带计数,清单内容通过上次快照缓存在服务端 todo-ref,
    // 这里以行内小轮询不引入第二个端点——直接展示计数 + 打开宿主 todo 面板的引导文案。
    return '';
  };
  void fetchTodos;

  const tick = async (): Promise<void> => {
    const sid = sessionIdOf();
    if (!sid) {
      setTimeout(tick, 5000);
      return;
    }
    try {
      const r = (await rpc('dsh-memory/longtask-hint-get', { sessionId: sid })) as LongTaskHint;
      if (r?.sessionId === sid) {
        render(r);
        if (String(r.longTask) !== panel.dataset.lt) {
          panel.dataset.lt = String(r.longTask);
          setToggle(r.longTask, false);
        }
        const todos = panel.querySelector('[data-todos]') as HTMLElement;
        todos.textContent =
          r.todoCount > 0
            ? `任务 ${r.todoCount} 条 · 漂移 ${r.drift === null ? '–' : `${Math.round((r.drift ?? 0) * 100)}%`}\n(完整清单见会话 todo 面板;开启长任务后清单自动驻留上下文)`
            : '尚无任务快照';
      }
    } catch {
      /* 端点未就绪/插件禁用:静默,球保持隐藏 */
    }
    setTimeout(tick, last?.suggest ? 2000 : 5000);
  };
  setTimeout(tick, 1500);

  // 动作:开关 + 手动压缩(只对当前会话;失败以内联提示,不弹窗)
  panel.querySelector('[data-toggle]')?.addEventListener('click', async () => {
    const sid = sessionIdOf();
    if (!sid) return;
    const btn = panel.querySelector<HTMLButtonElement>('[data-toggle]')!;
    const next = !(last?.longTask ?? false);
    setToggle(next, true);
    try {
      // 不带 mode:只切长任务开关,不触碰用户档位(服务端 mode 缺省 = 不动档位)。
      const r = (await rpc('dsh-memory/session-mode-set', { sessionId: sid, longTask: next })) as {
        longTask?: boolean;
      };
      if (last) last.longTask = Boolean(r.longTask ?? next);
      setToggle(Boolean(r.longTask ?? next), false);
    } catch {
      setToggle(!next, false);
    }
  });
  panel.querySelector('[data-compress]')?.addEventListener('click', async () => {
    const sid = sessionIdOf();
    if (!sid || !last?.longTask) return;
    const btn = panel.querySelector<HTMLButtonElement>('[data-compress]')!;
    btn.disabled = true;
    try {
      const r = (await rpc('dsh-memory/longtask-compress-tail', { sessionId: sid })) as {
        enqueued?: number;
      };
      const tail = panel.querySelector('[data-tail]') as HTMLElement;
      tail.textContent = `已入队 ${r.enqueued ?? 0} 条消息蒸馏`;
    } catch {
      /* 静默 */
    }
    btn.disabled = false;
  });
}
