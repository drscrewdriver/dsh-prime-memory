/**
 * locale 变更的 React 订阅面（**单独成文件**：`i18n.ts` 必须保持零 React 依赖，
 * 否则 `tests/dimensions.test.ts` / `tests/conflicts-view.test.ts` 这类纯 node 用例
 * 一 import client 纯模块就会在 node 里解析 `react` 而失败）。
 */
import { useSyncExternalStore } from 'react';
import { getLocaleService } from './i18n.js';

/** 稳定引用的订阅器：避免每次渲染换函数导致 useSyncExternalStore 反复重订阅。 */
function subscribe(onChange: () => void): () => void {
  const svc = getLocaleService();
  return svc ? svc.subscribe(onChange) : () => {};
}

function snapshot(): number {
  const svc = getLocaleService();
  return svc ? svc.getSnapshot().revision : 0;
}

/**
 * 订阅 locale 变更以触发重渲染。
 *
 * 只在**根组件**调用一次即可：根重渲染会带走整棵子树（本插件的组件都没有 React.memo）。
 * @returns 当前 locale revision（仅用于建立订阅，值本身不参与渲染）。
 */
export function useLocaleRevision(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
