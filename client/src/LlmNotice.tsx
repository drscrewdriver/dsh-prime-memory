/**
 * 记忆蒸馏使用 LLM 能力（费用提示 + 本地端点建议）——设置面**第一区块**。
 *
 * 原则（2026-11-25 用户裁定）：凡用到 LLM 的处理，费用提示与本地端点建议永远排
 * 在设置面第一位、且在 N 条使用建议里排第一条；样式美化（引导）排其次。
 *
 * 数据源：`dsh-memory/llm-providers` 的 channel 块（DirectChannelView）。只读展示，
 * 不做写入——写入口仍在「概览 → 蒸馏通道」（ChannelEditor）。
 */
import { tr } from './i18n.js';
import { useEffect, useState, type CSSProperties } from 'react';
import type { DirectChannelView } from '../../src/contract.js';

const STY: Record<string, CSSProperties> = {
  box: {
    margin: '10px 0 12px',
    padding: '12px 14px',
    border: '1px solid var(--dsh-mem-border)',
    borderLeft: '4px solid var(--dsh-mem-danger)',
    borderRadius: 8,
    background: 'var(--dsh-mem-bg-inset)',
  },
  title: { margin: '0 0 6px', fontSize: 13.5, fontWeight: 650, color: 'var(--dsh-mem-text-1)' },
  note: { margin: '4px 0', fontSize: 11, color: 'var(--dsh-mem-text-3)', lineHeight: 1.55 },
  warn: { margin: '6px 0 0', fontSize: 11, color: 'var(--dsh-mem-danger)', lineHeight: 1.55 },
};

/** 解析当前蒸馏通道的一句话现状（未就绪时给「读取中」，不编造）。 */
function routeLabel(channel: DirectChannelView | null): { text: string; host: boolean } {
  if (channel === null) return { text: tr('读取中…'), host: false }
  if (channel.effective === 'direct') {
    const base = channel.runtime === 'direct'
      ? channel.runtimeBaseURL
      : channel.deployedBaseURL || channel.runtimeBaseURL
    const ready = channel.directReady ? '' : tr('（端点未配置齐，蒸馏可能回落）')
    const prefix = channel.runtime === 'direct' ? '' : `${tr('跟随部署 ·')} `
    return { text: `${prefix}${tr('直连端点 {p1}', { p1: base || '—' })}${ready}`, host: false }
  }
  const prefix = channel.runtime === 'host' ? '' : `${tr('跟随部署 ·')} `
  return { text: `${prefix}${tr('宿主模型（与对话共用 provider/model，消耗对话配额）')}`, host: true }
}

export function LlmCostNotice(props: { channel: DirectChannelView | null }) {
  const route = routeLabel(props.channel)
  // 两步关闭：我已知晓 → 弹窗确认 → 写专门 flag（与引导跳过标记分开）
  const HIDDEN_FLAG = 'dsh.llm-notice.prime-memory.hidden.v1'
  const readHidden = (): boolean => { try { return typeof localStorage !== 'undefined' && localStorage.getItem(HIDDEN_FLAG) === '1' } catch { return false } }
  const [hidden, setHidden] = useState(() => readHidden())
  if (hidden) return null
  return (
    <section style={STY.box} aria-label={tr('记忆蒸馏使用 LLM 能力')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={STY.title}>{tr('记忆蒸馏使用 LLM 能力')}</h3>
        <span style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            style={{ appearance: 'none', font: 'inherit', fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid rgba(127,127,127,.45)', background: 'transparent', cursor: 'pointer', color: 'inherit' }}
            onClick={() => {
              let ok = false
              try { ok = typeof window !== 'undefined' && window.confirm(tr('确定隐藏「LLM 使用提示」？之后面板不再展示；清空 localStorage 键 dsh.llm-notice.prime-memory.hidden.v1 可恢复。')) } catch { ok = false }
              if (!ok) return
              try { localStorage.setItem(HIDDEN_FLAG, '1') } catch {}
              setHidden(true)
            }}
          >
            {tr('我已知晓')}
          </button>
        </span>
      </div>
      <p style={STY.note}>
        {tr('蒸馏（L1 抽取 / 场景摘要 / 画像）与全记忆重建全部异步执行，不阻塞对话；关闭「蒸馏」开关时不会调用任何 LLM。已指定本地/局域网 OpenAI 兼容端点（Ollama、LM Studio、自建 llama.cpp、vLLM、SGLang、Strata、Ninfer 等）后绝不跟随宿主；只有「跟随部署配置 / 复用宿主」才与对话共用 provider/model——宿主若是高价 API，蒸馏费用会随之上升，请谨慎。默认不建议跟随：请显式指定本地蒸馏端点。')}
      </p>
      <p style={STY.note}>{tr('蒸馏通道：{p1}', { p1: route.text })}</p>
      {route.host ? (
        <p style={STY.warn} role="note">
          {tr('⚠ 当前走宿主/部署通道：蒸馏与对话共用 provider/model，高价 API 下每轮抽取都会增加费用；请改为「直连端点」本地服务。')}
        </p>
      ) : null}
      <p style={STY.note}>
        {tr('「跟随」只是缺省回退，不是推荐配置；默认建议不跟随——在「概览 → 蒸馏通道」显式选择「直连端点」。')}
      </p>
    </section>
  )
}