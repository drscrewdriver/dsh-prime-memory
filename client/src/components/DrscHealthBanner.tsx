/**
 * DRSC（参考会话库）依赖状态 banner —— 记忆设置面板顶部，12 个 tab 全局可见。
 *
 * 为什么需要它（`.agents/plans/drsc-dependency-hint/findings.md` 实证）：
 * `dsh.pluginDependencies` 在运行时不产生任何行为（宿主 boot 层全文 0 处引用），
 * 记忆插件只是 collector 的**消费者**，无权挂载它。于是「只开启了记忆、没启用 collector」
 * 的部署里，蒸馏背景窗与跨会话检索会静默为空——面板上却看不出任何异常。
 *
 * 设计取舍：
 * - `ok` 态完全不占版面（`return null`），首帧未拿到也不渲染（避免正常用户看到闪烁）；
 * - 四态文案各自给「影响说明」，并写明 desktop 只能手改 profile + pnpm install；
 * - 只展示不执行：改 profile 是高危动作（并发重写/BOM 有历史事故），复制文案由用户自己跑。
 */
import { tr } from '../i18n.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DrscHealthResponse } from '../../../src/contract.js';
import type { RpcFn } from '../rpc.js';
import { S } from '../styles.js';
import { fmtTime } from '../format.js';

const POLL_MS = 60_000;

/** 桌面侧唯一可行链路（宿主独占管理 desktop profile，CLI 必被拒）。 */
const GUIDE = tr("桌面版（DSH Desktop）不能用 `dsh plugin --profile desktop add`（宿主独占管理，会被拒绝），只能手工： 1. 编辑 ~/.dsh/profiles/desktop/package.json - dependencies 追加 \"dsh-reference-session-collector\": \"^0.2.5\" - dsh.profile.bundles 追加 \"dsh-reference-session-collector\" 2. 在该目录执行 pnpm install 3. 重启 DSH Desktop 注意：只开启「记忆」不会自动启用参考会话库 —— 记忆插件只是它的消费者，无权挂载它。");

interface Tone {
  title: string;
  style: keyof typeof S;
}

function toneOf(h: DrscHealthResponse): Tone {
  switch (h.state) {
    case 'missing':
      return { title: tr("未安装参考会话库（DRSC）"), style: 'bannerError' };
    case 'not-running':
      return { title: tr("DRSC 已安装但未启用"), style: 'bannerWarn' };
    case 'stale':
      return { title: tr("DRSC 投影库已过期"), style: 'bannerWarn' };
    default:
      return { title: tr("无法读取 DRSC 投影库"), style: 'bannerNeutral' };
  }
}

export function DrscHealthBanner({ rpc }: { rpc: RpcFn }) {
  const [health, setHealth] = useState<DrscHealthResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLPreElement | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const tick = async () => {
      try {
        const r = await rpc('dsh-memory/drsc-health');
        if (!aliveRef.current) return;
        if (r.ok) setHealth(r.value);
      } catch {
        // 探针失败保持上一状态：banner 是提示面，不能因一次网络抖动自我消失
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [rpc]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(GUIDE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文/权限拒绝）：降级为选中文本，用户可手工复制
      const el = codeRef.current;
      if (el && typeof window.getSelection === 'function') {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }, []);

  // 首帧与健康态都不占版面
  if (!health || health.state === 'ok') return null;

  const tone = toneOf(health);
  const toneStyle = (S[tone.style] ?? {}) as CSSProperties;
  const lagHours = health.lagMs === null ? null : Math.round((health.lagMs / 3_600_000) * 10) / 10;

  return (
    <div style={{ ...S.bannerBase, ...toneStyle }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{tone.title}</div>
      <div style={{ color: 'var(--dsh-mem-text-3)' }}>
        {tr("影响：蒸馏背景参考与跨会话检索会为空（记忆本身仍可捕获与检索本库）。")} </div>
      {health.state === 'stale' && health.lastSyncAt !== null ? (
        <div style={{ color: 'var(--dsh-mem-text-3)', marginTop: 2 }}>
          {tr("最后同步：")}{fmtTime(new Date(health.lastSyncAt).toISOString())}
          {lagHours === null ? '' : tr("（滞后约 {p1} 小时）", { p1: lagHours })}
        </div>
      ) : null}
      {health.state === 'unknown' && health.error ? (
        <div style={{ color: 'var(--dsh-mem-text-3)', marginTop: 2 }}>{tr("探针：")}{health.error}</div>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--dsh-mem-text-3)' }}>{tr("修复指引（可复制）")}</span>
        <button className="dsh-mem-tab" onClick={() => void copy()} title={tr("复制修复指引")}>
          {copied ? tr("已复制") : tr("复制")}
        </button>
      </div>
      <pre ref={codeRef} style={S.bannerCode}>
        {GUIDE}
      </pre>
    </div>
  );
}
