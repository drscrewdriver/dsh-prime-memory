/**
 * 蒸馏通道编辑器（llm.mode=direct 解耦通道的可编辑面，thinking-levels 式即时提交）。
 *
 * 数据源：llm-providers 的 channel 块（runtime = settings 覆盖档 / effective = 实际
 * 生效档 / deployed = 部署 config；apiKey 只回传布尔，明文不出宿主）。写入走
 * settings-set 的 distillMode / directBaseURL / directApiKey：
 *  - 模式分段即点即存（跟随部署 '' / 复用宿主 host / 直连端点 direct）；
 *  - direct 下端点 debounce 提交、密钥 Enter/失焦提交后清空（不回读明文）；
 *  - 与部署 pin 正交：direct 是独立传输层，不受宿主 provider pin 约束。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DirectChannelView } from '../../../src/contract.js';
import type { RpcFn } from '../rpc.js';
import { Segmented } from '../ui/controls.js';
import { NButton, NInput } from '../ui/primitives.js';

const STY: Record<string, CSSProperties> = {
  block: { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dsh-mem-border)' },
  head: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 },
  title: { fontSize: 13, fontWeight: 650, color: 'var(--dsh-mem-text-1)' },
  chip: {
    display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '1px 8px',
    fontSize: 11, fontWeight: 600, lineHeight: '18px', whiteSpace: 'nowrap',
  },
  chipAccent: { background: 'var(--dsh-mem-accent-weak)', color: 'var(--dsh-mem-accent-text)' },
  chipMuted: { background: 'var(--dsh-mem-bg-inset)', color: 'var(--dsh-mem-text-2)' },
  desc: { fontSize: 11, color: 'var(--dsh-mem-text-3)', margin: '0 0 8px', lineHeight: 1.5 },
  fieldRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 },
  fieldLabel: { fontSize: 11, color: 'var(--dsh-mem-text-3)', flexShrink: 0, width: 64 },
  input: { flex: '1 1 220px', minWidth: 160 },
  warn: { fontSize: 11, color: 'var(--dsh-mem-danger)', marginTop: 6 },
  preview: { fontSize: 12, color: 'var(--dsh-mem-text-2)', marginTop: 8, wordBreak: 'break-all', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
};

const MODE_OPTIONS: Array<{ key: '' | 'host' | 'direct'; label: string; title: string }> = [
  { key: '', label: '跟随部署配置', title: '没有运行时覆盖，用 cordis.patch.yml 的 llm.mode/baseURL（默认 host）' },
  { key: 'host', label: '复用宿主', title: '复用宿主 ctx.llm（与付费供应商同路）' },
  { key: 'direct', label: '直连端点', title: '插件原生 HTTP 直连 OpenAI 兼容端点，与付费 API 解耦' },
];

export function ChannelEditor(props: { channel: DirectChannelView; rpc: RpcFn; disabled?: boolean }) {
  const { channel, rpc, disabled } = props;
  // 端点输入可回显（受控，debounce 提交）；密钥输入不回读明文（Enter/失焦提交后清空）
  const [baseText, setBaseText] = useState<string>(channel.runtimeBaseURL);
  const [keyText, setKeyText] = useState<string>('');
  // debounce 定时器 + 「用户正在编辑」标记：轮询回传时不清掉未提交的草稿
  const baseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);

  // 端点跟随轮询收敛（不在编辑中才采纳，防止夹在两次 RPC 之间被旧值覆盖）
  useEffect(() => {
    if (!dirty.current) setBaseText(channel.runtimeBaseURL);
  }, [channel.runtimeBaseURL]);

  useEffect(() => () => clearTimeout(baseTimer.current), []);

  const commit = (patch: Record<string, unknown>): void => {
    rpc('dsh-memory/settings-set', patch).catch(() => {});
  };

  // 端点：debounce 即时提交（设置页低频，即点即生效）
  const onBaseChange = (v: string): void => {
    dirty.current = true;
    setBaseText(v);
    clearTimeout(baseTimer.current);
    baseTimer.current = setTimeout(() => {
      dirty.current = false;
      commit({ directBaseURL: v.trim() });
    }, 600);
  };

  // 密钥：Enter / 失焦一次性提交后清空输入框（不留明文；空值不提交）
  const commitKey = (): void => {
    const v = keyText.trim();
    if (v) {
      dirty.current = true;
      commit({ directApiKey: v });
      dirty.current = false;
    }
    setKeyText('');
  };

  const runtime = channel.runtime; // '' | 'host' | 'direct'
  const editing = runtime === 'direct';
  const isDirect = channel.effective === 'direct';
  const deployedDirect = channel.deployed === 'direct';
  const apiKeySet = channel.runtimeApiKeySet || channel.deployedApiKeySet;
  const showWarn = isDirect && !channel.directReady;

  return (
    <div style={STY.block}>
      <div style={STY.head}>
        <span style={STY.title}>蒸馏通道</span>
        <span style={isDirect ? STY.chipAccent : STY.chipMuted}>
          {isDirect ? '直连端点' : '复用宿主'}
        </span>
        <span title="direct = 插件原生直连 OpenAI 兼容端点，与付费 API 解耦；失败自动回退宿主路由链。" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--dsh-mem-text-3)' }}>
          生效：{runtime ? (runtime === 'direct' ? '运行时直连' : '运行时宿主') : '跟随部署配置'}
        </span>
      </div>
      <div style={STY.desc}>
        direct 通道走插件原生 HTTP，不依赖宿主 provider 注册表；direct 失败自动回退宿主路由链作兜底安全网。
      </div>

      <Segmented
        value={runtime}
        disabled={disabled}
        options={MODE_OPTIONS.map((m) => ({ key: m.key, label: m.label, title: m.title }))}
        onChange={(k) => commit({ distillMode: k })}
      />

      {editing ? (
        <div>
          {/* 端点（非机密，可回显） */}
          <div style={STY.fieldRow}>
            <span style={STY.fieldLabel}>端点 URL</span>
            <NInput
              style={STY.input}
              placeholder="如 http://127.0.0.1:11434/v1 或 https://api.xxx/v1"
              value={baseText}
              disabled={disabled}
              onChange={(e: { target: { value: string } }) => onBaseChange(e.target.value)}
              onKeyDown={(e: { key: string }) => {
                if (e.key === 'Enter') {
                  clearTimeout(baseTimer.current);
                  dirty.current = false;
                  commit({ directBaseURL: baseText.trim() });
                }
              }}
            />
            {deployedDirect && !channel.runtimeBaseURL ? (
              <span style={{ fontSize: 11, color: 'var(--dsh-mem-text-3)' }}>
                部署基线：{channel.deployedBaseURL || '（空）'}
              </span>
            ) : null}
          </div>
          {/* 密钥（不回读明文；点表示已配置，可覆盖或清除） */}
          <div style={STY.fieldRow}>
            <span style={STY.fieldLabel}>API Key</span>
            <NInput
              style={STY.input}
              type="password"
              placeholder={apiKeySet ? '••••••••（已配置；留空提交可覆盖）' : '本地免 key 可留空'}
              value={keyText}
              disabled={disabled}
              autoComplete="new-password"
              onChange={(e: { target: { value: string } }) => setKeyText(e.target.value)}
              onKeyDown={(e: { key: string }) => {
                if (e.key === 'Enter') commitKey();
              }}
              onBlur={commitKey}
            />
            {apiKeySet ? <span style={STY.chipAccent}>已配置</span> : <span style={STY.chipMuted}>未配置</span>}
            <NButton
              disabled={disabled}
              title="写入空串清除运行时密钥（部署 .yml 的密钥不受影响）"
              onClick={() => commit({ directApiKey: '' })}
            >
              清除
            </NButton>
          </div>
          {showWarn ? <div style={STY.warn}>{'⚠ direct 未配置完整：需同时有端点 URL 与模型（llm.model / 全局链主路由），否则会回退宿主路由。'}</div> : null}
        </div>
      ) : (
        <div style={STY.preview}>
          {isDirect
            ? '当前将直连端点：' + (channel.runtimeBaseURL || channel.deployedBaseURL || '（未配置端点）') + (apiKeySet ? ' · 密钥已配置' : ' · 未配置密钥')
            : '当前复用宿主 ctx.llm（' + (runtime === 'host' ? '运行时锁定' : '跟随部署配置') + '）'}
        </div>
      )}
    </div>
  );
}
