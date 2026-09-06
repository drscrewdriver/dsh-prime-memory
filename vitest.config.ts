/**
 * Vitest 配置：纯 node 环境单元测试（TDD 基座，与 smoke 互补）。
 * 只测纯函数/模块级逻辑，不拉宿主；client 的 JSX 组件不在本 suite（另由 typecheck 管）。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/smoke.ts', 'src/bench-control.ts', 'src/token-cost.ts'],
    },
  },
});