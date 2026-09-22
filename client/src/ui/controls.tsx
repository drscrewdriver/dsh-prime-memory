/** Switch / SwitchRow / Segmented：轻量自绘控件（S 布局 + theme 类交互态）。 */
import type { ReactNode } from 'react';
import { S } from '../styles.js';

export function Switch(props: { checked?: boolean; disabled?: boolean; onChange?(v: boolean): void }) {
  const on = !!props.checked;
  const disabled = !!props.disabled;
  const base: typeof S.switch = { ...S.switch, ...(on ? S.switchOn : S.switchOff), ...(disabled ? S.switchDisabled : null) };
  return (
    <div
      style={base}
      onClick={() => {
        if (!disabled && props.onChange) props.onChange(!on);
      }}
    >
      <span style={{ ...S.knob, left: on ? 18 : 2 }} />
    </div>
  );
}

export function SwitchRow(props: {
  label?: ReactNode;
  desc?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  onChange?(v: boolean): void;
}) {
  return (
    <div style={S.switchRow}>
      <Switch checked={props.checked} disabled={props.disabled} onChange={props.onChange} />
      <div>
        <div style={S.switchLabel}>{props.label}</div>
        <div style={S.switchDesc}>{props.desc || ''}</div>
      </div>
    </div>
  );
}

/** 动作按钮（点了就执行，没有"当前选中项"语义）。
 *  与 `Segmented` 的分工：Segmented 的 onClick 带 `!on` 守卫（点击已选中项不触发），
 *  用它承载一次性动作会得到一个永远点不动的死按钮（一键回填曾踩此坑）。
 *  视觉沿用 seg 配方，保证与同排的分段控件观感一致。 */
export function ActionButton(props: {
  label: ReactNode;
  /** 悬停提示（解释性文字进 tooltip 不占版面，#34 文案极简约定） */
  title?: string;
  disabled?: boolean;
  onClick?(): void;
}) {
  const disabled = !!props.disabled;
  return (
    <button
      type="button"
      title={props.disabled ? '' : props.title || ''}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled && props.onClick) props.onClick();
      }}
      style={{
        ...S.seg,
        ...S.segBtn,
        fontFamily: 'inherit',
        border: '1px solid var(--dsh-mem-border)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...(disabled ? S.switchDisabled : null),
      }}
    >
      {props.label}
    </button>
  );
}

export interface SegOption {
  key: string;
  label: ReactNode;
  disabled?: boolean;
  disabledTitle?: string;
  /** 悬停提示（非禁用态；解释性文字进 tooltip 不占版面，#34 文案极简约定） */
  title?: string;
}

/** 分段选择器（支持逐项禁用：如远程档未配齐连接信息时置灰）。
 *  语义限定：**选择器**——`value` 是当前选中项，点击"已选中项"不触发 onChange（`!on` 守卫）。
 *  承载"点了就要执行"的动作（如一键回填）请用 `ActionButton`，否则会出现死按钮。 */
export function Segmented(props: {
  value: string | null | undefined;
  options: SegOption[];
  disabled?: boolean;
  onChange?(key: string): void;
}) {
  const value = props.value;
  const disabled = !!props.disabled;
  return (
    <div style={{ ...S.seg, ...(disabled ? S.switchDisabled : null) }}>
      {props.options.map((opt, i) => {
        const on = opt.key === value;
        const optDisabled = disabled || !!opt.disabled;
        return (
          <span
            key={opt.key}
            title={opt.disabledTitle || opt.title || ''}
            style={{
              ...S.segBtn,
              ...(on ? S.segBtnOn : null),
              ...(i === props.options.length - 1 ? { borderRight: 'none' } : null),
              ...(optDisabled ? { cursor: 'not-allowed', opacity: 0.45 } : null),
            }}
            onClick={() => {
              if (!optDisabled && !on && props.onChange) props.onChange(opt.key);
            }}
          >
            {opt.label}
          </span>
        );
      })}
    </div>
  );
}
