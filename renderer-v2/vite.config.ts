import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// runtime-only 预编译 SFC：运行时不需要 new Function，可启用严格 CSP（无 unsafe-eval）
// 产物为纯静态 dist/，由 Electron 主进程通过 file:// 加载，运行时零第三方依赖
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: true,
    cssCodeSplit: true,
    // 两个 HTML 入口：主窗 + 独立账本窗口。相对路径以 renderer-v2 为 root，
    // 产物都落在 dist/，electron-builder 的 dist/**/* 通配会自动把两者带上。
    rollupOptions: {
      input: { main: 'index.html', finance: 'finance.html' }
    }
  }
});
