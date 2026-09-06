/**
 * ESLint 扁平配置（Flat Config，ESLint 9）。
 * 覆盖 host 侧（src/）与 client 侧（client/src，TSX）与脚本（scripts/*.mjs）。
 * tseslint.configs.recommended 为非 type-checked 基线（不依赖 tsconfig 解析，避免 host/client
 * 双 tsconfig 的 type-aware 冲突）。rules 中的豁免反映本仓库既有约定，避免为风格大动迁改。
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-smoke/**',
      'node_modules/**',
      'assets/**',
      'resources/**',
      'bench/**',
      'coverage/**',
      '*.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // 项目约定：未用变量/参数报错（下划线前缀豁免）
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 仓库既有 pattern：空 extends 别名（如 StatsResponse extends MemoryStats {}）
      '@typescript-eslint/no-empty-object-type': 'off',
      // scripts/smoke 常直接 throw new Error(...)，不强制 preserve-caught-error
      'preserve-caught-error': 'off',
      // client primitives.tsx 等 fallback 层有意用 any（见文件内禁用注释）
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // 浏览器侧全局（仅 client/src）
    files: ['client/src/**/*.ts', 'client/src/**/*.tsx'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
);