/**
 * 维度输入 → 提交计划（纯函数，无副作用，可在 node 下单测）。
 *
 * ## 为什么把它抽出来
 *
 * 这段逻辑原先内联在 `EmbeddingSection` 里，三条远程字段（端点 / 模型 / 维度）
 * 共用同一套「脏标记 + 提交后复位」模式，但维度的**失败路径漏了复位**：
 *
 * ```ts
 * // 端点、模型：防抖回调里无条件复位
 * baseTimer.current = setTimeout(() => {
 *   remoteDirty.current.base = false;   // ← 先复位，再提交
 *   commitRemote({ ... });
 * }, 600);
 *
 * // 维度：只在成功路径复位（原实现）
 * if (!Number.isInteger(n) || n <= 0 || n > 100000) {
 *   setErr('...');
 *   return;                              // ← 直接返回，dims 永远是 true
 * }
 * remoteDirty.current.dims = false;
 * ```
 *
 * 而轮询回填受该标记门控：
 *
 * ```ts
 * if (!remoteDirty.current.dims) setRDims(st.remote.dimensions > 0 ? String(...) : '');
 * ```
 *
 * ⇒ 一旦输入非法值，输入框**永久停在那个非法值上**、红字不消、也不再跟随生效值
 * 刷新，只能手动清空才能恢复。抽成纯函数后，「无论成败都必须复位」这条不变量
 * 才可被断言（见 `tests/dimensions.test.ts`）。
 */

/** 维度的合法区间（与宿主侧 `embedRemoteDimensions` 的校验一致）。 */
export const DIMS_MIN = 1;
export const DIMS_MAX = 100000;

/** 校验失败时给用户看的文案。 */
export function dimsRangeMessage(): string {
  return `嵌入维度须为 ${DIMS_MIN}~${DIMS_MAX} 的整数（留空 = 跟随部署配置）`;
}

/** 提交计划的两个出口（注入以便单测观察调用顺序与次数）。 */
export interface DimsCommitDeps {
  /**
   * 复位「用户正在编辑」标记。**必须无条件调用**，且早于任何提前返回 ——
   * 见文件头：失败路径漏掉它，输入框就会卡死在非法值上。
   */
  clearDirty(): void;
  /** 提交生效值（`0` = 跟随部署配置）。 */
  submit(value: number): void;
  /** 拒绝并提示（不提交）。 */
  reject(message: string): void;
}

/**
 * 解析维度输入并驱动提交。
 *
 * 取值语义：
 * - 空串 / 纯空白 → `0`，即**跟随部署配置**（清掉运行时覆盖）；
 * - `1..100000` 的整数 → 该值；
 * - 其余（0、负数、小数、越界、`NaN`、`Infinity`）→ 拒绝，且**保留生效值不变**。
 *
 * **取值用 `Number()` 解析，故指数与十六进制写法会被接受并归一**：
 * `'7e3'` → `7000`、`'0x10'` → `16`。这是**既有行为**（原实现同样用
 * `Number(raw)`），本次修复刻意不动它 —— HTML `<input type="number">` 本来就
 * 允许指数写法，收紧只会引入一次与本次缺陷无关的行为变更。
 * 副作用是：用户若输入 `7e3`，提交后轮询回填会把输入框显示成 `7000`
 * （显示值与该次输入的字面量不同）。**已知且可接受**，在此记录以免日后再被
 * 当成 bug 重新"修"一遍。
 */
export function commitDimensions(raw: string, deps: DimsCommitDeps): void {
  // ① 先复位脏标记 —— 这一步的**位置**就是修复本身，不要挪到下面去。
  deps.clearDirty();

  const trimmed = raw.trim();
  if (trimmed === '') {
    deps.submit(0);
    return;
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < DIMS_MIN || n > DIMS_MAX) {
    deps.reject(dimsRangeMessage());
    return;
  }
  deps.submit(n);
}
