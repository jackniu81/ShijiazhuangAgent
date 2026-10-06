import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

// React 19.3 与 @vitejs/plugin-react 的 React Refresh(babel 注入)在 jsdom 采集阶段报错，
// 测试环境用 oxc 的 jsxOnly 转换,不注入 refresh;dev/build 仍走 vite.config.ts 的完整插件。
export default defineConfig({
  plugins: [react({ jsxOnly: true }), tailwindcss()],
  resolve: {
    alias: {
      '@shijiazhuang-agent/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
