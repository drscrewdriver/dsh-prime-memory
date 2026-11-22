/**
 * 记忆库入口的两个组件壳（entry.tsx 只负责装配，不写 JSX）。
 *
 * - `ExplorerIcon`：0.1.7+/0.2.x 的 `sidebar.panellist` 行图标。宿主按 owner props
 *   传 `{ size, active }`，尺寸与选中态**必须由 props 驱动**——自己写死 16px 会在
 *   折叠态（宿主传 18）下与相邻官方行错位。
 * - `ExplorerFooterEntry`：≤0.1.5 的回落形态，底栏一个按钮 + 自绘 dialog。
 *   两条线渲染的是**同一个 `ExplorerPage`**，只差容器高度，老线不缩水。
 */
import { tr } from '../i18n.js';
import { useState } from 'react';
import { ExplorerPage } from './ExplorerPage.js';
import { NModal } from '../ui/primitives.js';
import type { RpcFn } from '../rpc.js';

/** 行图标：三颗节点 + 两条边（"记忆图"的最小可读形状），随字色走，不写死颜色。 */
export function ExplorerIcon(props: { size?: number; active?: boolean }) {
  const size = props.size ?? 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      opacity={props.active ? 1 : 0.72}
      aria-hidden="true"
    >
      <path d="M4 11.5 L8 4 L12.5 9" strokeLinecap="round" />
      <circle cx="4" cy="11.5" r="1.7" />
      <circle cx="8" cy="4" r="1.7" />
      <circle cx="12.5" cy="9" r="1.7" />
    </svg>
  );
}

/** 底栏回落入口：按钮 + dialog 内的整页组件。 */
export function ExplorerFooterEntry(props: { rpc: RpcFn }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="dsh-mem-btn" onClick={() => setOpen(true)} title={tr("打开记忆库（查询 L1 记忆与关联图谱）")}>
        {tr("记忆库")} </button>
      {open ? (
        <NModal title={tr("记忆库")} onClose={() => setOpen(false)}>
          <div style={{ height: '70vh', minHeight: 420 }}>
            {/* dialog 里三栏太挤：图给矮一点，靠两侧栏滚动承载内容。 */}
            <ExplorerPage rpc={props.rpc} canvasHeight={360} />
          </div>
        </NModal>
      ) : null}
    </>
  );
}
